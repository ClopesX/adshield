# Arquitetura: como o AdBlock 6.51.0 funciona e como o AdShield faz

## Parte 1 — AdBlock 6.51.0 (a partir do código recuperado)

O pacote é um Manifest V3 com um único *service worker* enorme (`abp-background.js`, 3,4 MB) gerado
por webpack a partir de um monorepo TypeScript. Os *source maps* entregam 590 arquivos originais,
com uma divisão clara em duas metades:

```
abp-background/
├── @eyeo/webext-ad-filtering-solution/   ← o motor (filtros, matching, DNR, cosmético)
│   └── adblockpluscore/lib/snippets.js   ← execução de scriptlets na página
├── adblock-betafish/                     ← a camada "marca AdBlock" (14 mil linhas)
│   ├── datacollection.v2.js              ← telemetria de bloqueios por domínio
│   ├── prefs/                            ← preferências e defaults
│   ├── messaging/                        ← barramento popup ↔ opções ↔ background
│   ├── onpage-dialog/, notifications/    ← UI injetada, campanhas
│   ├── picreplacement/                   ← troca de imagens (premium)
│   └── alias/uninstall.js                ← beacon de desinstalação
└── src/                                  ← integração nova (eyeometry, conta, IPM)
    ├── telemetry/{cdp,user-counting}.ts
    ├── filters/shared/                   ← tipos de filtro
    └── bootstrap/background/             ← ordem de inicialização
```

Fluxo de dados, em ordem:

1. **Inicialização** (`senior` `bootstrap.entry.ts`): Sentry → telemetria → assinaturas → UI.
2. **Listas**: 37 arquivos ABP em `data/rules/abp/` (EasyList + regionais, ~40 MB) e o equivalente
   já compilado em `data/rules/dnr/` (38 rulesets, cada um com UUID). O Chrome só liga 3 por padrão.
3. **Bloqueio**: `declarativeNetRequest` estático + regras dinâmicas; `webRequest` observa para
   contabilizar.
4. **Cosmético**: `adblock.css` genérico + CSS por domínio injetado por content script.
5. **UI**: `popup`, `options`, `devtools`, `onpage-dialog` se comunicam por mensagens.

Detalhe importante para quem for clonar: o pacote **já traz os filtros compilados**, não compila em
tempo de execução. É isso que explica o tamanho: 40 MB de dados.

## Parte 2 — AdShield: o que foi reconstruído

| Área | AdBlock 6.51.0 | AdShield |
|---|---|---|
| Tamanho do código | ~3,4 MB minificado + 40 MB de listas | ~2.400 linhas legíveis + 21 MB de regras |
| Compilação de filtros | offline, no build da eyeo | `tools/build.mjs`, roda na sua máquina |
| Regras de rede | 38 rulesets UUID, 3 ligados | 6 partes (25 mil regras cada) + YouTube |
| Cobertura | subconjunto curado pela eyeo | EasyList + EasyPrivacy completos (105.669) |
| Ocultação | genérica + por domínio + scriptlets | genérica + por domínio (sem scriptlets) |
| Telemetria | Sentry + eyeometry + log server | nenhuma |
| Contador | `webRequest` + estado próprio | `onRuleMatchedDebug` (modo desenvolvedor) |
| Allowlist | por site e por aba | por site (`allowAllRequests`) e por aba (`tabIds`) |
| Filtros do usuário | motor ABP completo | subconjunto ABP → DNR (2.500 regras dinâmicas) |
| Assinaturas | suportadas | 2.500 regras dinâmicas, truncado |

### Decisões de projeto

**1. Compilar em vez de copiar.** O AdShield não embute o código da eyeo. O `src/common/abp.js`
implementa o subconjunto de ABP que o Chrome consegue executar de forma declarativa: âncoras
`||`/`|`, curinga `*`, separador `^`, `$third-party`, `$domain=`, tipos de recurso, `$important`,
`$badflag`/`$badfilter` e exceções `@@`. O que não tem equivalente (`$redirect`, `$removeparam`,
`$csp`, scriptlets, regex) é descartado com motivo contabilizado — o `rules/report.json` mostra
exatamente o que ficou de fora.

**2. Orçamento de regras.** O Chrome garante 30.000 regras estáticas para extensões publicadas e
libera **330.000** para extensões carregadas sem empacotar. O AdShield usa esse espaço
(`--budget`, padrão 290.000) porque é assim que ele vai rodar: local, por "Carregar sem compactação".
Para gerar um pacote publicável, use `node tools/build.mjs --budget 28000`.

**3. Arquivos de 25 mil regras.** Um único arquivo de 27 MB atrasa a ativação; o Chrome carrega
rulesets em paralelo. Com 6 partes, 105.669 regras ficam prontas em ~2,4 s.

**4. Ordem de prioridade.** Exceções (`@@`) recebem `priority: 200`, bloqueios `1`, `$important`
sobe para 300/400 e a allowlist do usuário usa `allowAllRequests` com `priority: 1000` — sempre
acima de tudo. Pausa por aba usa `condition.tabIds`, que só existe em regras de sessão: por isso
ela não sobrevive ao fechamento da aba, e isso é intencional.

**5. Ocultação em dois níveis.** 13.782 seletores genéricos vão num CSS declarado no manifest
(aplicado pelo Chrome antes da primeira pintura, sem JS); 8.288 domínios ficam num JSON consultado
pelo service worker e injetado por content script em `document_start`.

**5b. Duas formas de bloquear um elemento.** A regra criada pelo seletor tem um modo:
`hide` aplica `display: none` (o nó continua no DOM) e `remove` apaga o nó. O segundo existe porque
overlay em tela cheia continua segurando o scroll mesmo invisível — e, como o site recria esses nós,
um `MutationObserver` remove de novo a cada aparição. Quando o nó removido cobre a viewport, o
`overflow: hidden` que o site põe em `html`/`body` também é liberado, senão o scroll segue travado.
O formato antigo (`{dominio: ["seletor"]}`) é migrado na leitura para `{dominio: {seletor: "hide"}}`.

**6. Contador sem mentir.** `onRuleMatchedDebug` só existe em extensão desempacotada. Quando ele não
está disponível, o popup diz isso ("contador exige modo desenvolvedor") em vez de mostrar números
inventados.

## Parte 3 — YouTube: o que o AdBlock faz (e por que o nosso precisou de outra abordagem)

O código do AdBlock 6.51.0 foi lido em duas frentes.

**1. Listas.** O pacote traz apenas estas regras de YouTube:

```
||youtube.com/pagead/            (bloqueio)
@@||youtube.com/pagead^$xmlhttprequest,image,domain=youtube.com   (exceção: libera no próprio YouTube)
||youtube.com/youtubei/v1/player/ad_break
||youtube.com/api/stats/ads?
||youtube.com/ptracking?html5=1&video_id=*&cpn=*&ei=*&ptk=youtube_*&pltype=content
```

**2. Content script (`yt-auto-allowlist.preload.js`).** O fragmento `yt-wall-detection` só
**detecta** o muro antiadblock e avisa o background:

```js
const adWallSelector = "ytd-enforcement-message-view-model";
// ao encontrar o muro -> browser.runtime.sendMessage({ type: "yt_site_ad_wall_detected", … })
// background responde liberando o YouTube: "yt_auto_allowlisted"
```

Ou seja: quando o YouTube ameaça bloquear a reprodução, o AdBlock **desiste e libera o site** — mas
só depois de tentar bloquear. O bloqueio de verdade não está no pacote: está na lista
**`abp-filters-anti-cv.txt`** (compliance/anti-circumvention), que ele liga por padrão e que usa
*snippets* (`#$#`):

```
www.youtube.com#$#override-property-read ytInitialPlayerResponse.adPlacements undefined; ...
www.youtube.com#$#skip-video '.video-stream' './/div[contains(@class,"ad-interrupting")]';
www.youtube.com#$#event-override click trusted; simulate-mouse-event 'button.ytp-skip-ad-button…'
m.youtube.com,music.youtube.com#$#json-prune '… adPlacements … adSlots …'
```

Três efeitos, em ordem de importância:

1. **`override-property-read`** — a leitura do campo devolve `undefined` mesmo se a página reatribuir;
2. **`skip-video`** — com o player em anúncio, o vídeo é **avançado até o fim**: um pré-roll de 30 s
   termina em milissegundos;
3. **`event-override click trusted`** — o clique em "Pular" precisa parecer confiável; o snippet
   troca o evento entregue ao listener.

### A abordagem do AdShield (v1.2.0)

`src/content/youtube-main.js` roda no **mundo MAIN**, em `document_start`, antes dos scripts da
página, e reproduz os três efeitos em código próprio, sem motor de snippets:

| Snippet do AdBlock | Equivalente no AdShield |
|---|---|
| `override-property-read` | `harden()`: getter que devolve `undefined` para `adPlacements`, `playerAds`, `adSlots`, `adBreakParams`… |
| `json-prune` | `prune()` no `fetch`/XHR de `/youtubei/v1/player`, antes de o player ler |
| `skip-video` | `skipAdVideo()`: leva `video.currentTime` ao fim (ou `playbackRate = 16` se a duração é desconhecida) |
| `simulate-mouse-event` + `event-override click trusted` | `trustedClick()` + fachada de `isTrusted` |
| `ytplayer.config.args.raw_player_response` | `hardenYtplayerConfig()` |

Detalhe que custou uma rodada de teste: **`isTrusted` não pode ser falsificado.** O Chrome cria a
propriedade como não configurável em cada evento — falha por instância e ignorada no protótipo. O
que funciona (e é o que o snippet faz) é marcar os eventos que nós disparamos e entregar ao listener
um `Proxy` que responde `true`; o `removeEventListener` precisa devolver o mesmo invólucro, senão o
YouTube não consegue desinscrever os próprios handlers.

O registro é dinâmico (`chrome.scripting.registerContentScripts` com `world: "MAIN"`), porque um
content script de mundo MAIN não tem acesso a `chrome.storage` — assim a chave "Bloqueio no YouTube"
das opções consegue ligar e desligar o script de verdade.

### Confronto lado a lado (`node tools/compare-youtube.mjs`)

| | AdBlock 6.51.0 | AdShield 1.2.0 |
|---|---|---|
| Regras estáticas | 56.852 | 105.669 |
| Regras dinâmicas | 2.680 | 0 |
| `adPlacements` no player | removido | removido |
| Requisições bloqueadas no vídeo | 7 | 21 |
| Vídeo toca | sim | sim |

### Medição em página real (02/11/2026, `youtube.com/watch?v=dQw4w9WgXcQ`)

```
                       sem extensão   com AdShield
adPlacements                1            null   (removido)
streamingData             presente     presente (player intacto)
playabilityStatus            OK           OK
video.currentTime            0 s          7 s   (o conteúdo andou)
```

Reproduza com `node tools/youtube-check.mjs`. É uma conferência de campo: depende do que o YouTube
entrega para o seu IP e do formato do anúncio.

### Limite honesto

Anúncio **costurado no vídeo pelo servidor** (SSAI, cada vez mais comum) não tem como ser removido
por extensão: o trecho já faz parte do arquivo servido. Contra esse formato, nenhum bloqueador de
navegador entrega 100%.

## Parte 4 — Limites conhecidos


- **Scriptlets** (`##+js(...)`): não implementados. Alguns sites (anti-adblock) dependem disso.
- **Regex** (`/.../`): descartados; o Chrome limita a 1.000 regras regex e o custo não compensa.
- **`$redirect`/`$removeparam`**: sem equivalente em DNR; descartados.
- **Listas novas em tempo de execução**: limitadas a 2.500 regras dinâmicas (o resto vem do build).
- **Publicação na Web Store**: exigiria `--budget 28000`, senão o Chrome recusa o pacote.
- **YouTube**: as 8 regras são conservadoras de propósito; mudanças no player quebram esse tipo de
  regra e a manutenção é manual.




