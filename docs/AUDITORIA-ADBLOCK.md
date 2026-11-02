# Auditoria do AdBlock 6.51.0 (extensão instalada)

Escopo: extensão **AdBlock** (`gighmmpiobklfepjocnamgkkbiglidom`) versão **6.51.0**, Manifest V3,
copiada de `C:\Users\<você>\AppData\Local\Google\Chrome\User Data\Profile 1\Extensions\...`.

Método: cópia local do pacote + recuperação do código-fonte original a partir dos *source maps*
incluídos no pacote (`abp-background.js.map` e outros 14) → **590 arquivos TypeScript/JS legíveis**,
com busca dirigida por endpoints, permissões e caminhos de dados. Não houve captura de tráfego.

Resumo honesto em uma linha: **não encontrei backdoor nem código remoto, mas encontrei telemetria
ativa por padrão que envia domínios que você visita e estatísticas de bloqueio.**

---

## 1. O que é enviado para fora

### 1.1 Estatísticas de bloqueio por domínio — `log.getadblock.com`

Arquivo: `adblock-betafish/datacollection.v2.js`

| O que | Evidência |
|---|---|
| Coleta | Cada navegação principal (`type: "main_frame"`) grava o **domínio visitado** e a contagem de páginas: `dataCollectionCache.domains[domain].pages += 1` |
| Coleta | Cada anúncio bloqueado grava o **texto do filtro** + domínio + se era terceira parte + assinaturas |
| Envio | `POST https://log.getadblock.com/v2/record_log.php`, a cada 60 min (`periodInMinutes: HOUR_IN_MIN`) |
| Payload | `addonVersion`, navegador e versão, plataforma, `appLocale`, lista de assinaturas, `domains`, `filters` |
| Gate | `Prefs.get("data_collection_opt_out")` e `settings.data_collection_v2` |

O payload `domains` é essencialmente um **histórico de sites visitados em nível de domínio** (sem
caminho, sem título, sem conteúdo de formulário). É agregado, mas é dado de navegação.

### 1.2 Relatório de erros — Sentry

Arquivo: `src/bootstrap/background/bootstrap.entry.ts`

```js
if (Prefs.get("data_collection_opt_out")) { … "Sentry is not initialized" }
else { void ewe_api.sentry.start("https://6758518d020dfd043e00c6f7dc4a2f8c@o526868.ingest.us.sentry.io/4507299627991040", …) }
```

DSN e organização do Sentry vêm embutidos no pacote. Envia exceções e contexto do navegador.

### 1.3 Pings de "contagem de usuários" (eyeometry / CDP)

Arquivo: `abp-background.js` (bloco `addonInfo`)

| Endpoint | Uso |
|---|---|
| `https://adblock.telemetry.getadblock.com/topic/cdp_activeping_noipc/version/6` | ping periódico (variante "noipc": sem IP) |
| `https://adblock.telemetry.getadblock.com/pubkey/rsa/2048` | chave pública usada para cifrar o ping |
| `https://adblock.telemetry.eyeo.com/topic/webextension_activeping/version/4` | contagem de usuários |
| `https://adblock.telemetry.eyeo.com/topic/webextension_eventlogging/version/2` | log de eventos |

Cada um carrega um token `bearer` fixo no código. O opt-out é aplicado por
`ewe.telemetry.setOptOut()` / `ewe.cdp.setOptOut()` a partir da preferência
`data_collection_opt_out` (arquivos `src/telemetry/background/cdp.ts` e `user-counting.ts`).

### 1.4 URL de desinstalação

Arquivo: `adblock-betafish/alias/uninstall.js`

Ao desinstalar, o navegador abre uma página da Adblock, Inc. com:

`rcid` (id rotativo do cliente) · `t` (tempo de instalação) · `av` · `bc` (total bloqueado) ·
`er` (revisão de remote config) · `ev` (experimentos) · `ca` (coortes) · `lt` (última atualização) ·
`wafc` · `ps` (status premium) · `aa` (status de "anúncios aceitáveis")

Em opt-out, o `rcid` passa a ser um UUID de sessão não persistido.

### 1.5 Conta / premium

`api.ua.eyeo.it` (base), `myaccount.getadblock.com/api/auth/ext-login*`,
`applicationId` fixo. Só entra em jogo no fluxo de conta/premium.

---

## 2. O ponto mais importante: o padrão é "ligado"

`adblock-betafish/alias/prefs.js:143`

```js
defaults.data_collection_opt_out = false;
```

`false` significa **não optou por sair** → Sentry, CDP ping e contagem de usuários **ativos por
padrão**. O coletor de estatísticas (`data_collection_v2`) é ligado pelo assistente de primeira
execução/consentimento; nos dois casos, o modelo é opt-out para o pacote de telemetria.

### O que a interface controla

`_locales/pt_BR/messages.json` traz `datacollectionoption`:
> "Permitir que o AdBlock colete dados de uso anônimos da lista de filtros, e informações sobre os
> conteúdos bloqueados pelas listas de filtros"

Essa caixa controla **`data_collection_v2`** (o `log.getadblock.com`). Ela **não** é a mesma
preferência que desliga Sentry e pings (`data_collection_opt_out`) — e não encontrei, no código das
páginas de opções desta versão, nenhum controle ligado a `data_collection_opt_out`. Ou seja:
desmarcar a caixa reduz, mas não desliga todo o conjunto.

---

## 3. Superfície de permissões (o que o código pode fazer)

| Permissão | Observação |
|---|---|
| `<all_urls>` + `webRequest` + `tabs` + `scripting` | necessário para bloquear e para contar requisições; é o mesmo conjunto de qualquer bloqueador |
| `declarativeNetRequestWithHostAccess` | bloqueio declarativo (MV3) |
| `management` (opcional) | usado para detectar conflito com outros bloqueadores |
| `externally_connectable` com 5 IDs fixos | permite que extensões específicas da própria Adblock/eyeo conversem com ela |
| `unlimitedStorage`, `notifications`, `idle`, `alarms`, `contextMenus` | rotina de bloqueador |

Não há `cookies`, `history`, `downloads`, `clipboardRead`, `debugger` nem `nativeMessaging` no
manifest.

## 4. Execução de código na página (scriptlets)

`adblockpluscore/lib/snippets.js` usa `new Function(...)` para rodar trechos de código **fornecidos
pelos filtros** (`##+js(...)`). Isso é a feature de *snippets* do Adblock Plus, não um backdoor — mas
significa que as listas de filtros (que podem ser atualizadas pela rede) têm poder de executar
JavaScript no contexto da página. Se você aceita listas de terceiros, aceita esse poder.

Também há `new Function("return this")` em dependências (`eventemitter2`, `jsonpath-plus`,
`runtime/global`) — polyfills usuais, sem relação com a rede.

## 5. O que não encontrei

- Nenhum download de **código de extensão** pela rede (MV3 proíbe; o bundle é todo local).
- Nenhum acesso a teclado, campos de formulário, senhas, histórico do navegador ou cookies.
- Nenhuma injeção de script remoto em páginas além dos mecanismos normais de filter list.
- Nenhuma comunicação que não esteja listada acima.

Limitações: o núcleo `@eyeo/webext-ad-filtering-solution` (~3,5 MB minificado) foi auditado por
busca dirigida e pelos módulos de origem recuperados, não linha por linha; a análise é estática
(não observei tráfego real).

## 6. Como reduzir a exposição no AdBlock que já está instalado

1. Opções → Geral → **desmarcar** "Permitir que o AdBlock colete dados de uso anônimos…".
2. Não faça login na conta Adblock (evita `api.ua.eyeo.it`, e o `ps/aa` no uninstall).
3. Se quiser ir além, desinstale: a URL de desinstalação só é aberta depois que você remove.

Isso reduz o envio de estatísticas, mas a telemetria de Sentry/pings não tem interruptor na
interface desta versão.

## 7. Conclusão

| Pergunta | Resposta |
|---|---|
| Tem backdoor? | Não encontrei. Nenhum código remoto, nenhuma porta de entrada além de mensagens entre extensões da própria família. |
| Ele "espiona"? | Coleta telemetria e **domínios visitados** por padrão. Não é keylogger, mas é vigilância de uso. |
| Entrega o que promete? | Sim: 105 mil filtros (EasyList/EasyPrivacy) aplicados via DNR, mais ocultação de elementos. Foi por isso que virou base do AdShield. |
| Dá para confiar na versão própria? | É o ponto do AdShield: mesmo princípio de bloqueio, **zero** rede, código legível. |

---

## Como reproduzir

O código-fonte recuperado (590 arquivos) e a lista de hosts encontrados ficaram **apenas na máquina
local** (`_REA-ADBLOCK/`), fora deste repositório: é código de terceiros, redistribuí-lo exigiria
cuidado com a licença e não é necessário para usar o AdShield. Para refazer a extração:

```powershell
# 1. copiar o pacote instalado
robocopy "$env:LOCALAPPDATA\Google\Chrome\User Data\Profile 1\Extensions\gighmmpiobklfepjocnamgkkbiglidom\6.51.0_0" `
         "_REA-ADBLOCK\adblock-6.51.0" /E /XD _metadata

# 2. inventário e evidência com o REA
node <caminho-rea>\scripts\rea.mjs analyze-javascript-application "_REA-ADBLOCK\adblock-6.51.0" --format json
```

O comando de inventário do REA funcionou e gerou o *JavaScript Application Graph* com hashes por
arquivo. A fase de AST (`parse_javascript_source`) **não** completou nesta máquina: o worker do REA
grava um arquivo temporário próprio e o sandbox do DSH nega a escrita (`EPERM` em
`rea-javascript-analysis-*/*.source`, mesmo com `TMP` dentro do workspace). O trabalho seguiu pelos
*source maps* do pacote, que trazem o TypeScript original — resultado mais fiel que o AST.


