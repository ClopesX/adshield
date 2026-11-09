#!/usr/bin/env node
/**
 * AdShield — teste de ponta a ponta com Chrome real (headless).
 *
 * Sobe um servidor local, carrega a extensão num perfil temporário e verifica:
 *  1. o service worker sobe e as listas estáticas estão ligadas;
 *  2. uma requisição a domínio de anúncio é bloqueada;
 *  3. uma requisição normal passa;
 *  4. a ocultação cosmética genérica é aplicada;
 *  5. o contador por aba registra o bloqueio;
 *  6. popup e opções carregam sem erro.
 *
 * O Chrome 156 ignora --load-extension, então a extensão é carregada pelo
 * próprio CDP (Extensions.loadUnpacked), que exige um Chrome real.
 *
 * Uso: node tools/e2e.mjs
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];
const PORT = 9333;
const HTTP_PORT = 8123;
const TARGET_FILTER = '';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function waitForEndpoint(url, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      return await getJson(url);
    } catch (error) {
      lastError = error;
      await sleep(250);
    }
  }
  throw new Error(`endpoint não respondeu: ${url} (${lastError?.message})`);
}

class Cdp {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.nextId = 1;
    this.pending = new Map();
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl);
      this.ws.addEventListener('open', () => resolve());
      this.ws.addEventListener('error', (event) => reject(new Error(`ws: ${event.message || 'erro'}`)));
      this.ws.addEventListener('message', (event) => {
        const frame = JSON.parse(event.data);
        const entry = this.pending.get(frame.id);
        if (!entry) return;
        this.pending.delete(frame.id);
        if (frame.error) entry.reject(new Error(frame.error.message));
        else entry.resolve(frame.result);
      });
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`timeout em ${method}`));
      }, 25000);
    });
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || 'exceção na página');
    }
    return result.result.value;
  }

  close() {
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
  }
}

const PAGE_HTML = `<!doctype html>
<html lang="pt-BR">
  <head><meta charset="utf-8"><title>AdShield e2e</title></head>
  <body>
    <div class="adslot" style="height:40px;background:#ddd">anúncio cosmético</div>
    <p id="ok">página de teste</p>
    <script>
      window.__e2e = (async () => {
        const attempt = async (url) => {
          try {
            await fetch(url, { mode: 'no-cors', cache: 'no-store' });
            return 'passou';
          } catch (error) {
            return 'bloqueado';
          }
        };
        const normal = await attempt('https://example.com/');
        const ad = await attempt('https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js');
        const tracker = await attempt('https://www.google-analytics.com/analytics.js');
        const cosmetic = getComputedStyle(document.querySelector('.adslot')).display;
        return { normal, ad, tracker, cosmetic };
      })();
    </script>
  </body>
</html>`;

/**
 * Página que imita o caso real do YouTube: um overlay em tela cheia que trava
 * o scroll do body e que o site recria depois de 1,5 s. É o cenário em que
 * `display:none` não resolve — só removendo o nó do DOM.
 */
const OVERLAY_HTML = `<!doctype html>
<html lang="pt-BR">
  <head><meta charset="utf-8"><title>overlay</title></head>
  <body>
    <p id="content">conteúdo</p>
    <div id="adshield-overlay" style="position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.6)">
      overlay que trava o scroll
    </div>
    <script>
      document.body.style.overflow = 'hidden';
      setTimeout(() => {
        const again = document.createElement('div');
        again.id = 'adshield-overlay';
        again.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.6)';
        document.body.append(again);
        document.body.style.overflow = 'hidden';
      }, 1500);
    </script>
  </body>
</html>`;

async function findTarget(predicate, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let targets = [];
  while (Date.now() < deadline) {
    targets = await getJson(`http://127.0.0.1:${PORT}/json/list`);
    const found = targets.find(predicate);
    if (found) return found;
    await sleep(400);
  }
  return null;
}

function dumpTargets(targets) {
  console.log('  alvos:');
  for (const target of targets) console.log(`    ${target.type} ${target.url}`);
}

async function main() {
  const chrome = CHROME_CANDIDATES.find((candidate) => existsSync(candidate));
  if (!chrome) throw new Error('Chrome não encontrado');

  const profile = await mkdtemp(join(tmpdir(), 'adshield-e2e-'));
  const logPath = join(profile, 'chrome.log');
  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(String(request.url || '').startsWith('/overlay') ? OVERLAY_HTML : PAGE_HTML);
  });
  await new Promise((resolve) => server.listen(HTTP_PORT, '127.0.0.1', resolve));

  const headful = process.argv.includes('--headful');
  const args = [
    ...(headful ? ['--window-size=900,700', '--window-position=-2400,-2400'] : ['--headless=new', '--disable-gpu']),
    '--no-first-run',
    '--no-default-browser-check',
    '--enable-unsafe-extension-debugging',
    '--enable-logging=file',
    `--log-file=${logPath}`,
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${PORT}`,
  ];

  console.log(`Chrome: ${chrome}`);
  const child = spawn(chrome, args, { stdio: 'ignore', windowsHide: true });

  let browserCdp = null;
  try {
    const versionInfo = await waitForEndpoint(`http://127.0.0.1:${PORT}/json/version`);
    browserCdp = new Cdp(versionInfo.webSocketDebuggerUrl);
    await browserCdp.connect();

    let extensionId = null;
    try {
      const loaded = await browserCdp.send('Extensions.loadUnpacked', { path: ROOT });
      extensionId = loaded?.id || null;
    } catch (error) {
      console.log(`  loadUnpacked falhou: ${error.message}`);
    }
    check('extensão carregada', Boolean(extensionId), extensionId || 'falhou');

    if (!extensionId) throw new Error('sem id de extensão');

    // O service worker pode levar alguns segundos para aparecer como target.
    let serviceWorker = await findTarget(
      (target) => target.type === 'service_worker' && String(target.url).includes(extensionId),
      15000,
    );
    check('service worker ativo', Boolean(serviceWorker), serviceWorker?.url?.split('/').pop());

    const optionsUrl = `chrome-extension://${extensionId}/src/options/options.html`;
    const popupUrl = `chrome-extension://${extensionId}/src/popup/popup.html`;

    let cdp = null;
    if (serviceWorker) {
      cdp = new Cdp(serviceWorker.webSocketDebuggerUrl);
      await cdp.connect();
      await cdp.send('Runtime.enable');

      // O contexto do worker pode levar um instante para expor as APIs.
      let apiReady = false;
      for (let attempt = 0; attempt < 40 && !apiReady; attempt++) {
        try {
          apiReady = await cdp.evaluate(
            "typeof chrome !== 'undefined' && Boolean(chrome.declarativeNetRequest)",
          );
        } catch {
          apiReady = false;
        }
        if (!apiReady) await sleep(250);
      }
      if (!apiReady) console.log('  APIs do worker não ficaram prontas a tempo');

      // As listas estáticas são lidas de forma assíncrona: espera o orçamento
      // cair de 330.000 (nenhuma regra carregada) para o valor real.
      const started = Date.now();
      let available = 330000;
      while (Date.now() - started < 90000) {
        available = await cdp.evaluate('chrome.declarativeNetRequest.getAvailableStaticRuleCount()');
        if (typeof available === 'number' && available < 300000) break;
        await sleep(1000);
      }
      check(
        'listas estáticas carregadas',
        available < 300000,
        `${330000 - available} regras em ${((Date.now() - started) / 1000).toFixed(1)}s`,
      );

      const enabled = await cdp.evaluate('chrome.declarativeNetRequest.getEnabledRulesets()');
      const enabledList = Array.isArray(enabled) ? enabled.sort() : [];
      const declared = await cdp.evaluate(
        'chrome.runtime.getManifest().declarative_net_request.rule_resources.map((r) => r.id).sort()',
      );
      check(
        'rulesets ligados',
        enabledList.join(',') === declared.join(','),
        `${enabledList.length}/${declared.length}: ${enabledList.join(', ')}`,
      );

      const manifestVersion = await cdp.evaluate('chrome.runtime.getManifest().version');
      const expectedVersion = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8')).version;
      check('versão do manifest', manifestVersion === expectedVersion, String(manifestVersion));
    }

    // Agora a página de teste, com a extensão pronta.
    const pageTarget = await browserCdp.send('Target.createTarget', {
      url: `http://127.0.0.1:${HTTP_PORT}/`,
    });
    const page = await findTarget((target) => String(target.url).includes(`127.0.0.1:${HTTP_PORT}`), 12000);
    check('aba de teste aberta', Boolean(page), page?.url || 'não encontrada');

    if (page) {
      const pageCdp = new Cdp(page.webSocketDebuggerUrl);
      await pageCdp.connect();
      await pageCdp.send('Runtime.enable');
      await sleep(1500);
      const outcome = await pageCdp.evaluate('window.__e2e');
      check('requisição normal passa', outcome.normal === 'passou', outcome.normal);
      check('anúncio bloqueado', outcome.ad === 'bloqueado', outcome.ad);
      check('rastreador bloqueado', outcome.tracker === 'bloqueado', outcome.tracker);
      check('ocultação cosmética aplicada', outcome.cosmetic === 'none', `display: ${outcome.cosmetic}`);
      pageCdp.close();
    }
    if (pageTarget?.targetId) {
      await browserCdp.send('Target.closeTarget', { targetId: pageTarget.targetId }).catch(() => {});
    }

    // 2) Contador e telas, ainda com o service worker aberto.
    if (cdp) {
      await cdp.evaluate(`chrome.tabs.create({ url: 'http://127.0.0.1:${HTTP_PORT}/?badge=1' })`);
      await sleep(2500);
      const badge = await cdp.evaluate(`(async () => {
        const tabs = await chrome.tabs.query({ url: 'http://127.0.0.1:${HTTP_PORT}/*' });
        if (!tabs.length) return 'sem aba';
        let total = 0;
        for (const tab of tabs) total += Number(await chrome.action.getBadgeText({ tabId: tab.id })) || 0;
        return String(total);
      })()`);
      check('contador por aba registrou bloqueio', Number(badge) > 0, `selo: "${badge}"`);

      for (const [label, url] of [
        ['popup', popupUrl],
        ['opções', optionsUrl],
      ]) {
        const created = await browserCdp.send('Target.createTarget', { url });
        const uiTarget = await findTarget((target) => String(target.url).includes(url.split('/').pop()), 8000);
        let ok = false;
        let detail = 'alvo não encontrado';
        if (uiTarget) {
          const uiCdp = new Cdp(uiTarget.webSocketDebuggerUrl);
          try {
            await uiCdp.connect();
            await uiCdp.send('Runtime.enable');
            await sleep(900);
            const state = await uiCdp.evaluate(`({
              text: document.body.innerText.length,
              error: document.body.innerText.includes('Erro ao carregar') ? document.body.innerText.slice(0, 120) : '',
            })`);
            ok = state.text > 30 && !state.error;
            detail = state.error || `${state.text} caracteres`;
          } catch (error) {
            detail = error.message;
          } finally {
            uiCdp.close();
          }
        }
        check(`página de ${label} carrega`, ok, detail);
        if (created?.targetId) await browserCdp.send('Target.closeTarget', { targetId: created.targetId }).catch(() => {});
      }
      cdp.close();
    }

    // 4) Ocultação personalizada: criar regra e removê-la pela interface —
    //    é o fluxo que antes não existia (regra ficava invisível).
    if (extensionId) {
      const optionsTarget = await browserCdp.send('Target.createTarget', { url: optionsUrl });
      const optionsPage = await findTarget((target) => String(target.url) === optionsUrl, 10000);
      check('página de opções abre para o teste de ocultação', Boolean(optionsPage), optionsUrl.split('/').pop());

      if (optionsPage) {
        const pageCdp = new Cdp(optionsPage.webSocketDebuggerUrl);
        await pageCdp.connect();
        await pageCdp.send('Runtime.enable');
        await sleep(600);

        const created = await pageCdp.evaluate(`(async () => {
          const response = await chrome.runtime.sendMessage({
            type: 'pickElement',
            selector: 'div.adshield-teste-remover',
            host: 'exemplo.com.br',
          });
          return response && response.ok ? response.result.domain : String(response && response.error);
        })()`);
        check('regra criada pelo seletor', created === 'exemplo.com.br', String(created));

        await pageCdp.send('Page.enable').catch(() => {});
        await pageCdp.send('Page.reload', { ignoreCache: true });
        await sleep(1500);

        const listed = await pageCdp.evaluate(`(() => {
          const text = document.body.innerText;
          return {
            aparece: text.includes('adshield-teste-remover'),
            dominio: text.includes('exemplo.com.br'),
            vazio: text.includes('Nenhum elemento bloqueado'),
          };
        })()`);
        check(
          'regra aparece na lista de ocultação',
          listed.aparece && listed.dominio && !listed.vazio,
          `aparece=${listed.aparece} dominio=${listed.dominio}`,
        );

        const removed = await pageCdp.evaluate(`(async () => {
          const buttons = [...document.querySelectorAll('button')].filter((b) => b.textContent.trim() === 'remover');
          for (const button of buttons) {
            const row = button.closest('.list-row');
            if (row && row.textContent.includes('adshield-teste-remover')) {
              button.click();
              return true;
            }
          }
          return false;
        })()`);
        check('botão remover encontrado na lista', removed === true, String(removed));
        await sleep(1200);

        const stillThere = await pageCdp.evaluate(
          "document.body.innerText.includes('adshield-teste-remover')",
        );
        check('regra removida da interface', stillThere === false, `ainda aparece: ${stillThere}`);

        // Modo "remover": o caso do overlay que trava o scroll e é recriado.
        const stored = await pageCdp.evaluate(`(async () => {
          const response = await chrome.runtime.sendMessage({
            type: 'pickElement',
            host: '127.0.0.1',
            selector: '#adshield-overlay',
            mode: 'remove',
          });
          const data = await chrome.storage.local.get('customCosmetic');
          return { ok: Boolean(response && response.ok), custom: data.customCosmetic };
        })()`);
        check(
          'regra criada no modo remover',
          stored.ok && stored.custom?.['127.0.0.1']?.['#adshield-overlay'] === 'remove',
          JSON.stringify(stored.custom || null).slice(0, 90),
        );

        const overlayTarget = await browserCdp.send('Target.createTarget', {
          url: `http://127.0.0.1:${HTTP_PORT}/overlay`,
        });
        const overlayPage = await findTarget((target) => String(target.url).includes('/overlay'), 12000);
        check('página com overlay abriu', Boolean(overlayPage), overlayPage?.url || 'não abriu');

        if (overlayPage) {
          const overlayCdp = new Cdp(overlayPage.webSocketDebuggerUrl);
          await overlayCdp.connect();
          await overlayCdp.send('Runtime.enable');
          await sleep(1400);

          const first = await overlayCdp.evaluate(
            "Boolean(document.getElementById('adshield-overlay'))",
          );
          check('overlay removido do DOM', first === false, `ainda existe: ${first}`);

          // O site recria o overlay 1,5 s depois; o observador precisa pegar.
          await sleep(2600);
          const second = await overlayCdp.evaluate(`({
            existe: Boolean(document.getElementById('adshield-overlay')),
            overflow: document.body.style.overflow || '',
            scrollY: window.scrollY,
          })`);
          check('overlay recriado também é removido', second.existe === false, `reapareceu: ${second.existe}`);
          check('scroll liberado', second.overflow !== 'hidden', `overflow="${second.overflow}"`);
          overlayCdp.close();
        }
        await browserCdp.send('Target.closeTarget', { targetId: overlayTarget.targetId }).catch(() => {});

        // Formato antigo ({dominio: ["seletor"]}) precisa continuar funcionando.
        await pageCdp.evaluate(
          `chrome.storage.local.set({ customCosmetic: { '127.0.0.1': ['#adshield-overlay'] } })`,
        );
        const legacyTarget = await browserCdp.send('Target.createTarget', {
          url: `http://127.0.0.1:${HTTP_PORT}/overlay?legacy=1`,
        });
        const legacyPage = await findTarget((target) => String(target.url).includes('legacy=1'), 12000);
        if (legacyPage) {
          const legacyCdp = new Cdp(legacyPage.webSocketDebuggerUrl);
          await legacyCdp.connect();
          await legacyCdp.send('Runtime.enable');
          await sleep(1500);
          const legacy = await legacyCdp.evaluate(`(() => {
            const node = document.getElementById('adshield-overlay');
            return { existe: Boolean(node), display: node ? getComputedStyle(node).display : null };
          })()`);
          check(
            'formato antigo vira modo esconder',
            legacy.existe === true && legacy.display === 'none',
            `existe=${legacy.existe} display=${legacy.display}`,
          );
          legacyCdp.close();
        }
        await browserCdp.send('Target.closeTarget', { targetId: legacyTarget.targetId }).catch(() => {});

        await pageCdp.evaluate("chrome.runtime.sendMessage({ type: 'clearCustomCosmetic' })");
        await sleep(300);

        pageCdp.close();
      }
      if (optionsTarget?.targetId) {
        await browserCdp.send('Target.closeTarget', { targetId: optionsTarget.targetId }).catch(() => {});
      }
    }

    // 3) Sanitizador do YouTube: registrado como content script MAIN e limpa
    //    a resposta do player antes da página usá-la.
    if (serviceWorker && extensionId) {
      const swCdp = new Cdp(serviceWorker.webSocketDebuggerUrl);
      await swCdp.connect();
      await swCdp.send('Runtime.enable');
      const registered = await swCdp.evaluate(
        'chrome.scripting.getRegisteredContentScripts().then((list) => list.map((entry) => entry.id))',
      );
      check(
        'script MAIN do YouTube registrado',
        Array.isArray(registered) && registered.includes('adshield-youtube-main'),
        (registered || []).join(', ') || '(nenhum)',
      );
      swCdp.close();
    }

    const ytSource = readFileSync(join(ROOT, 'src', 'content', 'youtube-main.js'), 'utf8');
    const ytTarget = await browserCdp.send('Target.createTarget', {
      url: `http://127.0.0.1:${HTTP_PORT}/?youtube=1`,
    });
    const ytPage = await findTarget((target) => String(target.url).includes('youtube=1'), 12000);
    if (ytPage) {
      const ytCdp = new Cdp(ytPage.webSocketDebuggerUrl);
      await ytCdp.connect();
      await ytCdp.send('Runtime.enable');
      await sleep(800);
      await ytCdp.evaluate(`(() => {
        window.fetch = async () => new Response(JSON.stringify({
          streamingData: { formats: [{ itag: 18 }] },
          adPlacements: [{ ad: 1 }, { ad: 2 }],
          playerAds: [{ a: 1 }],
          adSlots: [{ s: 1 }],
          playabilityStatus: { status: 'OK' },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      })()`);
      await ytCdp.evaluate(ytSource);
      const played = await ytCdp.evaluate(`(async () => {
        const response = await fetch('https://www.youtube.com/youtubei/v1/player?key=abc');
        const data = await response.json();
        return {
          ads: (data.adPlacements || []).length,
          playerAds: (data.playerAds || []).length,
          slots: (data.adSlots || []).length,
          streaming: Boolean(data.streamingData),
        };
      })()`);
      check(
        'sanitizador limpa a resposta do player',
        played.ads === 0 && played.playerAds === 0 && played.slots === 0 && played.streaming,
        `ads=${played.ads} playerAds=${played.playerAds} slots=${played.slots} streaming=${played.streaming}`,
      );

      const initial = await ytCdp.evaluate(`(() => {
        window.ytInitialPlayerResponse = { adPlacements: [1, 2], streamingData: { formats: [] } };
        const value = window.ytInitialPlayerResponse;
        return { ads: (value.adPlacements || []).length, streaming: Boolean(value.streamingData) };
      })()`);
      check(
        'sanitizador limpa ytInitialPlayerResponse',
        initial.ads === 0 && initial.streaming,
        `ads=${initial.ads} streaming=${initial.streaming}`,
      );
      const hardened = await ytCdp.evaluate(`(() => {
        const value = window.__adshieldYoutube.sanitize({ adPlacements: [1], playerAds: [2], streamingData: {} });
        value.adPlacements = [9, 9];
        return { ads: value.adPlacements, streaming: Boolean(value.streamingData) };
      })()`);
      check(
        'campos de anúncio ficam travados em undefined',
        hardened.ads === undefined && hardened.streaming,
        `ads=${hardened.ads}`,
      );

      const trusted = await ytCdp.evaluate(`(() => {
        const button = document.createElement('button');
        document.body.append(button);
        let seen = null;
        button.addEventListener('click', (event) => {
          seen = event.isTrusted;
        });
        window.__adshieldYoutube.trustedClick(button);
        button.remove();
        return seen;
      })()`);
      check('clique sintético chega como confiável', trusted === true, String(trusted));
      ytCdp.close();
    }
    if (ytTarget?.targetId) {
      await browserCdp.send('Target.closeTarget', { targetId: ytTarget.targetId }).catch(() => {});
    }
  } finally {
    try {
      browserCdp?.close();
    } catch {
      /* ignore */
    }
    try {
      child.kill();
    } catch {
      /* ignore */
    }
    server.close();
    await sleep(500);
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  }

  const failed = results.filter((entry) => !entry.ok);
  console.log(`\n${results.length - failed.length}/${results.length} verificações passaram`);
  if (failed.length) process.exitCode = 1;
}

await main();



