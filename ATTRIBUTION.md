# Atribuições e origem

## Código

Todo o código em `src/`, `tools/` e `tests/` foi escrito para o AdShield.
**Nenhuma linha do código do AdBlock 6.51.0 foi copiada.**

A análise do AdBlock (`docs/AUDITORIA-ADBLOCK.md`, `docs/ARQUITETURA.md`) foi feita por engenharia
reversa de um pacote instalado localmente, para entender comportamento e formato de dados. Fatos
observados (endpoints, nomes de preferência, assinaturas de lista, nomes de snippet) são
interoperabilidade e documentação, não código derivado.

## Listas de filtros

As regras em `rules/` são compiladas a partir de listas públicas:

| Lista | Origem | Licença |
|---|---|---|
| EasyList | https://easylist.to/ | CC BY-SA 3.0 |
| EasyPrivacy | https://easylist.to/ | CC BY-SA 3.0 |
| EasyList Português | https://easylist.to/ | CC BY-SA 3.0 |

O texto original das listas **não** é redistribuído neste repositório (fica em `data/cache/`, fora
do git). O que está versionado é o resultado compilado no formato `declarativeNetRequest` do Chrome.
Ao reutilizar essas regras, mantenha a atribuição à EasyList e a licença CC BY-SA 3.0.

## Marca

"AdBlock" e "Adblock Plus" são marcas de seus respectivos titulares (Adblock, Inc. e eyeo GmbH).
O AdShield não é afiliado, patrocinado ou endossado por eles, e não usa essas marcas no nome do
produto nem nos ícones.

## Ícones

`icons/*.png` são gerados por `tools/icons.mjs` (desenho original, GPL-3.0 como o resto do projeto).
