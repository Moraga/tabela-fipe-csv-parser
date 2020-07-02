const fs = require('fs');
const xlsx = require('node-xlsx');
const request = require('request');
const spawnSync = require('child_process').spawnSync;

// diretório com os arquivos enviados pela FIPE
const UPLOAD_DIR = './upload/';

// arquivos JSON com todos os dados
const OUTPUT_DIR = './';

// categorias válidas
const TYPES = ['carros', 'motos', 'caminhoes'];

// filtros gerais
let brandFilter = () => true;
let modelFilter = () => true;
let fipeFilter = () => true;

// atualiza índices gerais
let UPDATE_INDEX = true;

// processa os parâmetros da execução. Ex:
// --tipo carros motos --marca chevrolet
// --tipo caminhoes --noindex
// --fipe 008289-0 008290-0 008289-1
for (const {name, values} of xargs()) {
    switch (name) {
        case 'tipo':
            const wrong = values.filter(x => !TYPES.includes(x));
            if (wrong.length) {
                exit('Invalid types:', ...wrong);
            }
            TYPES.splice(0, TYPES.length, ...values);
            break;
        
        case 'marca':
            brandFilter = (re => ({marca}) => re.test(marca))(new RegExp(values.join('|'), 'i'));
            break;
        
        case 'modelo':
            modelFilter = (re => ({modelo}) => re.test(modelo))(new RegExp(values.join('|'), 'i'));
            break;
        
        case 'fipe':
            fipeFilter = (ls => ({fipe: {cod}}) => ls.includes(cod))(values);
            break;
        
        case 'noindex':
            UPDATE_INDEX = false;
            break;

        default:
            console.warn('Undefined arg: ', name);
            break;
    }
}

// todos os dados processados são acumulados neste objeto
const DB = TYPES.reduce((carry, type) => ({...carry, [type]: []}), {});

// processamento: mapa de combustíveis (sigla e valor)
const COMBUSTIVEL = {
    a: 'Álcool',
    g: 'Gasolina',
    d: 'Diesel',
    f: 'Flex',
    e: 'Elétrico',
    h: 'Híbrido'
};

// lista de padrões e marcas para normalização
const BRANDS_FIND_REPLACE = [
    [/volks.*?wagen/i, 'Volkswagen'],
    [/chevrolet/i, 'Chevrolet'],
];

// número máximo de tentativas para publicar um veículo
const PUBLISH_MAX_TRIES = 3;

// marcas
const brandsMap = {};

const MONTHS = [
    'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
    'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'
];

// container de erros
const ERRORS = [];


/**
 * Inicializador
 */
function main() {
    // armazena os arquivos encontrados por categoria
    const source = TYPES.reduce((carry, type) => ({...carry, [type]: []}), {});

    console.log('reading directory', UPLOAD_DIR);

    // percorre os arquivos encontrados no diretório de arquivos da FIPE
    for (const file of fs.readdirSync(UPLOAD_DIR)) {
        let meta, month, year, type = '';

        // nome do arquivo é validado segundo os padrões:
        // MM + AA
        if (meta = file.match(/^([^_]+).*?_(\d{2})(\d{2})_/)) {
            [, type, month, year] = meta;
        }
        // AAAA + MM
        else if (meta = file.match(/^([^_]+)_.*?(\d{4})(\d{2})/)) {
            [, type, year, month] = meta;
        }

        // padroniza categorias no plural
        if (type.charAt(type.length-1) != 's') {
            if (type == 'caminhao') {
                type = 'caminhoes';
            } else {
                type += 's';
            }
        }

        // ignora arquivos com formato inválido
        if (!TYPES.includes(type) || file.includes('seguradora')) {
            continue;
        }
        
        year = parseFloat(year);

        // ano AA para AAAA
        // ex: 19 para 2019
        if (year < 100) {
            year += 2000;
        }

        // mês + 1
        // exemplo: dezembro refere-se a janeiro do ano seguinte
        month = parseFloat(month) + 1;

        // ajuste para mês maior que 12
        if (month > 12) {
            month = 1;
            year += 1;
        }

        // cria um índice ordenável para cada arquivos
        // será usado para ordenar os arquivos
        const index = year * 100 + month;

        // ignora arquivos repetidos (comparação por índice)
        if (!source[type].find(i => i.index == index)) {
            source[type].push({
                index,
                month,
                year,
                path: UPLOAD_DIR + file,
            });
        }
    }

    // processa as categorias
    for (const [type, data] of Object.entries(source)) {
        // ordena a leitura dos arquivos: novo para antigo
        data.sort((a, b) => b.index - a.index);

        // cria um mapa temporário por id para agrupar informações
        DB[type].map = {};
        DB[type].recent = data[0].index;
        DB[type].oldest = data[data.length-1].index;

        // processa os arquivos
        for (const {path, year, month} of data) {
            console.log('processing', path);
            const doc = xlsx.parse(path);
            processFile(doc[0].data, year, month, DB[type]);
        }

        // apaga o mapa temporário
        delete DB[type].map;
    }

    brands = [...brands];

    // postProcess();

    // // salva todos os dados em único arquivo
    // saveAsJSON();

    // // processa machine learning (apenas para carros)
    // // const res = spawnSync('python3', ['predict.py']);
    // // const carros2 = fs.readFileSync(OUTPUT_DIR + 'carros2.json');
    // // DB.carros = JSON.parse(carros2);
    
    // atualiza índice geral das categorias
    publishIndexes(() => {
        // publica veículo por veículo
        const pendingItems = getPublishFormat();
        publish(pendingItems, () => {
            saveErrors();
            console.log(ERRORS.length, 'errors. Bye');
        });
    });
}

function* getPublishFormat() {
    for (const [type, data] of Object.entries(DB)) {
        for (const item of data) {
            yield [type, item];
        }
    }
}

function processFile(rows, year, month, db) {
    const header = rows.shift();
    const anos = [];

    // índice do identificador único
    let pk;

    // chave complementar (usada em apenas alguns casos)
    let ck;

    const xs = [];

    // milênio + século base
    let base = 2000;

    header.forEach((colname, i) => {
        switch (colname.toLowerCase()) {
            case 'marca':
                xs.push([i, 'marca']);
                break;
            
            case 'modelo':
                xs.push([i, 'modelo']);
                break;
            
            case 'combus':
                xs.push([i, 'combustivel']);
                ck = i;
                break;
            
            case 'cod_fipe':
                xs.push([i, 'cod']);
                pk = i;
                break;
            
            case 'num_passag':
                xs.push([i, 'passageiros'])
                break;
            
            case 'novo_g':
                anos.unshift([i, 'Novo']);
                break;
            
            default:
                const match = colname.match(/med(\d{2})g/);
                if (match) {
                    const ano = parseFloat(match[1]);
                    if (ano == 99) {
                        base -= 100;
                    }
                    anos.push([i, (ano + base).toString()]);
                }
                break;
        }
    });

    // processa o conteúdo do arquivo
    // cada linha é um carro com suas informações e preços por ano
    rows.forEach((cols, i) => {
        // número mínimo de colunas
        if (cols < 5) return;
        
        const id = cols[pk];

        let item;

        // encontra veículo existente
        if (id in db.map) {
            item = db.map[id];
        }
        // cadastra um novo veículo
        else {
            // cria um objeto a partir dos dados extraídos das colunas
            item = xs.reduce((carry, [k, name]) => ({...carry, [name]: cols[k]}), {id});
            // formata os dados e popula com novas informações
            item = parseItem(item);
            db.push(item);
            db.map[id] = item;
            brands.add(item.marca);
        }
        
        const suffix = ck ? ' ' + fuel(cols[ck]) : '';

        for (const [i, ano] of anos) {
            const price = parseFloat(cols[i]);
            if (price) {
                const key = ano + suffix;
                if (!item.anos.includes(key)) {
                    // @TODO reordenar em outro lugar?
                    item.anos = sort([key, ...item.anos]);
                    item.fipe.anos[key] = [];
                }
                item.fipe.anos[key].push({month, year, price});
            }
        }
    });
}

/**
 * Pós processamento de arquivos
 */
function postProcess() {
    for (const [type, items] of Object.entries(DB)) {
        const {recent} = DB[type];

        for (const item of items) {
            for (let i = item.anos.length; i--;) {
                const ano = item.anos[i];
                if (ano.includes('Novo')) {
                    const {month, year} = item.fipe.anos[ano][0];
                    const index = year * 100 + month;
                    if (index < recent) {
                        delete item.fipe.anos[ano];
                        item.anos.splice(i, 1);
                    }
                }
            } 
        }
    }
}

/**
 * Processa um veículo
 * @param {Object} param0 
 * @return {Object}
 */
function parseItem({id, cod, modelo, ...append}) {
    // configuração padrão
    // de veículo
    const item = {
        id,
        nome: null,
        modelo: modelo.toString(),
        marca: '',
        cv: null,
        cilindradas: null,
        cambio: null,
        portas: null,
        combustivel: null,
        tracao: null,
        pcd: false,
        v: null,
        motor: null,
        passageiros: null,
        eixos: null,
        anos: [],
        fipe: {
            cod,
            anos: {}
        },
        ...append
    };

    let nome = item.modelo + ' ';

    // número de cavalos
    nome = nome.replace(/(\d+)cv/i, (_, n) => {
        item.cv = parseFloat(n);
        return '';
    });

    // câmbio
    nome = nome.replace(/\s(aut|mec|(tip|multi|s.*?)tron(?:i|ic)?(?:[./\s]+aut))\b/i, (_, t) => {
        item.cambio = t.toLowerCase() == 'mec' ? 'Manual' : 'Automático';
        return '';
    });

    // número de portas
    nome = nome.replace(/\s([12345])p/, (_, n) => {
        item.portas = parseInt(n);
        return '';
    });

    // combustível
    if (item.combustivel) {
        item.combustivel = fuel(item.combustivel);
    }

    // combustível (via extração): diesel, elétrico, híbrido
    nome = nome.replace(/\s[(]?(die(?:sel|s|\b)|flex|el.tric[oa]|h.brido?)[.)]*/i, (_, t) => {
        item.combustivel = COMBUSTIVEL[t.charAt(0).toLowerCase()];
        return '';
    });

    // número de válvulas
    nome = nome.replace(/\s(\d+)v\s/i, (_, n) => {
        item.v = parseInt(n);
        return ' ';
    });

    // motor 1.0, 2.0, n
    nome = nome.replace(/\s(\d+\.\d+)\s/, (_, v) => {
        item.motor = v;
        return ' ';
    });

    // cilindradas
    nome = nome.replace(/(\d+)\s*cc/, (_, n) => {
        item.motor = parseFloat(n);
        return '';
    });

    // tração 2x4, 4x4, 8x2
    nome = nome.replace(/([2468]x[24])/, (_, v) => {
        item.tracao = v;
        return '';
    });

    // eixos
    nome = nome.replace(/(\d+)[\s-]*eixos?/i, (_, n) => {
        item.eixos = parseInt(n);
        return '';
    });

    // pessoa com deficiência
    nome = nome.replace(/\(?PCD\)?/, () => {
        item.pcd = true;
        return '';
    });

    // remove caracteres restantes
    item.nome = nome.replace(/\s{2,}/g, ' ').trim();

    // número de passageiros pode estar no formato 0000x
    if (item.passageiros) {
        item.passageiros = parseFloat(item.passageiros) || null;
    }

    // substitui marca quando necessário
    for (const [re, replacer] of BRANDS_FIND_REPLACE) {
        if (re.test(item.marca)) {
            item.marca = replacer;
            break;
        }
    }

    return item;
}

function fuel(input) {
    return COMBUSTIVEL[groupChars(input).toLowerCase()] || null;
}

/**
 * Publica um veículo no Publicador
 * @param {Generator} data 
 * @param {Function} callback 
 */
function publish(data, callback) {
    const ptr = data.next();

    if (ptr.done) {
        callback();
        return;
    }

    let [type, item, list] = ptr.value;

    // aplica condicionais
    if (!brandFilter(item) || !modelFilter(item) || !fipeFilter(item)) {
        setTimeout(() => {
            publish(data, callback)
        }, 0);
        return;
    }

    // mudança na ficha de carros
    if (type == 'carros') {
        type = 'carro';
    }

    console.log(`Publishing ${item.nome} - ${item.fipe.cod}`);
    
    // const lastFipeEntry = item.fipe.anos[item.anos[0]].find(e => !e.pred);
    // const lastUpdate = MONTHS[lastFipeEntry.month - 1] + '/' + lastFipeEntry.year;
    // const latestPrices = JSON.stringify(item.anos.map(ano => `${ano}|${item.fipe.anos[ano][0].price}`));

    let tag;
    
    if (item.marca in brandsMap) {
        const brand = brandsMap[item.marca];
        tag = `${brand.t} [${brand.i}];`
    }

    // prepare data
    const body = ``;

    const post = {
        url: 'http://some/path',
        method: 'POST',
        headers: {
            // 'content-type': 'text/xml',
            // 'content-type': 'application/json',
        },
        body
    };

    request(post, function (error, _, body) {
        // exibe sucesso ou erro no terminal
        console.log(error || body);
        // delay antes da próxima publicação
        setTimeout(() => {
            // em caso de erro de publicação
            if (error) {
                // cria um contador de erro para o item
                item.$error = (item.$error || 0) + 1;
                // são 3 tentativas para publicar o item
                if (item.$error < PUBLISH_MAX_TRIES) {
                    list.push(item);
                }
                // se exceder o número máximo de tentativas
                else {
                    // registra o erro
                    ERRORS.push({id: item.id, error,});
                }
            }
            // próximo item
            publish(data, callback);
        }, 200);
    });
}

/**
 * Agrupa repetições de caracteres em sequência
 * Ex: GGG -> G
 * @param {string} input
 * @return {string}
 */
function groupChars(input) {
    let ret = '';
    for (let i = 0, prev, curr; i < input.length; ++i) {
        curr = input.charAt(i);
        if (curr != prev) {
            ret += curr;
            prev = curr;
        }
    }
    return ret;
}

/**
 * Ordena array de strings com as informações:
 * - Ano ou novo
 * - Combustível
 * @param {array} list 
 * @return {array}
 */
function sort(list) {
    return list
        .map((v, i) => {
            const si = v.indexOf(' ');
            if (si > -1) {
                const p1 = v.substr(0, si);
                const p2 = v.substr(si + 1);
                return [parseInt(p1) || 9999, p2, i];
            }
            return [parseInt(v), '', i];
        })
        .sort(([a1, a2], [b1, b2]) => {
            if (b1 == a1) {
                if (b2 == a2) {
                    return 0;
                }
                return b2.charAt(0) == 'G' || a2 > b2 ? 1 : -1;
            }
            return b1 > a1 ? 1 : -1;
        })
        .map(([,, i]) => list[i]);
}

function saveAsJSON() {
    for (const [type, data] of Object.entries(DB)) {
        console.log('creating json file for', type);
        fs.writeFileSync(OUTPUT_DIR + type + '.json', JSON.stringify(data));
    }
}

function saveErrors() {
    if (ERRORS.length) {
        fs.writeFileSync(OUTPUT_DIR + 'errors.json', JSON.stringify(ERRORS));
    }
}

function xargs() {
    const args = [];
    let i = -1;
    for (const arg of process.argv.slice(2)) {
        // method
        if (arg.substr(0, 2) == '--') {
            i = args.push({name: arg.substr(2), values: []}) - 1;
        }
        // value
        else if (i > -1) {
            args[i].values.push(arg);
        }
    }
    return args;
}

function exit(...message) {
    if (message.length) {
        console.error(...message);
    }
    console.log('Exiting...');
    process.exit(1);
}


if (require.main === module) {
    main();
}