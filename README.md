# Fipe Parser

Processador de arquivos da tabela FIPE.


## Requisitos

- Node >= 8
- Arquivos da FIPE


## Instalação

1) Instalar dependências

```bash
npm install
```

2) Criar o diretório upload/

3) Mover os arquivos da FIPE para dentro de upload/


## Iniciar

O processamento dos arquivos e atualização dos dadospode ser completo ou parcial/específico.

Para processar tudo, execute:

```bash
node index.js
```


### Customização


#### --tipo

Atualiza itens por tipo, as opções são: carros, motos e caminhoes.

```bash
node index.js --tipo carros motos caminhoes
```


#### --marca

Atualiza itens de determinadas marcas. Separe diferentes marcas por espaço. Aceita expressão regular.

```bash
node index.js --marca audio mercedes
```


#### --modelo

Atualiza itens por modelo. Separe diferentes modelos por espaço. Aceita expressão regular.

```bash
node index.js --modelo onix hb20
```


#### --fipe

Atualiza itens por código FIPE. Separe diferentes códigos por espaço.

```bash
node index.js --fipe 008189-1 008189-2 008190-1
```


### --noindex

Esta flag configura para não atualizar os indices.



### Exemplos

```bash

## apenas motos
node index.js --tipo motos

## apenas carros das marcas chevrolet e volkswagen
node index.js --tipo carros --marca chevrolet volks

## apenas carros, sem atualizar índice
node index.js --tipo carros --noindex
```



## Docker

## Parser (Node)

```bash
docker build -t node-fipe .

docker run -v $(pwd)/upload:/usr/src/app/upload node-fipe
```


## PHP development

Diretório local mapeado como volume para receber os uploads

```bash
docker build -t php-fipe .

docker run -v $(pwd):/var/www/html php-fipe
```