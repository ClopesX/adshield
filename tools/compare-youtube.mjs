#!/usr/bin/env node
/**
 * AdShield — comparação de campo: AdBlock 6.51.0 × AdShield no YouTube.
 *
 * Para cada extensão, abre a mesma página de vídeo num Chrome headless com
 * perfil temporário e coleta:
 *   - as regras que a extensão realmente tem ativas (estáticas, dinâmicas e de sessão);
 *   - cada requisição bloqueada (CDP Network.loadingFailed);
 *   - o estado do player ao longo de 20 s (anúncio tocando, tempo do vídeo, DOM de anúncio).
 *
 * Uso: node tools/compare-youtube.mjs [url]
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome',
].find((candidate) => existsSync(candidate));

const ADBLOCK = join(
  process.env.LOCALAPPDATA || '',
  'Google/Chrome/User Data/Profile 1/Extensions/gighmmpiobklfepjocnamgkkbiglidom/6.51.0_0',
);

const URL_TO_TEST = process.argv[2] || 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const SAMPLE_MS = 20000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class Cdp {
  constructor(url) {
    this.url = url;
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Map();
  }
  async connect() {
    this.ws = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve);
      this.ws.addEventListener('error', reject);
    });
    this.ws.addEventListener('message', (event) => {
      const frame = JSON.parse(event.data);
      if (frame.id) {
        const entry = this.pending.get(frame.id);
        if (!entry) return;
        this.pending.delete(frame.id);
        frame.error ? entry.reject(new Error(frame.error.message)) : entry.resolve(frame.result);
        return;
      }
      const list = this.handlers.get(frame.method);
      if (list) for (const handler of list) handler(frame.params);
    });
  }
  on(method, handler) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(handler);
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`timeout ${method}`));
      }, 40000);
    });
  }
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || 'erro');
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

const RULES_PROBE = `(async () => {
  const dnr = chrome.declarativeNetRequest;
  const out = { enabled: [], available: null, dynamic: 0, session: 0, youtubeDynamic: [], youtubeStatic: null };
  try { out.enabled = await dnr.getEnabledRulesets(); } catch (e) { out.enabled = 'erro: ' + e.message; }
  try { out.available = await dnr.getAvailableStaticRuleCount(); } catch {}
  try { out.dynamic = (await dnr.getDynamicRules()).length; } catch {}
  try { out.session = (await dnr.getSessionRules()).length; } catch {}
  try {
    const rules = await dnr.getDynamicRules();
    out.youtubeDynamic = rules
      .filter((r) => /youtube|googlevideo/i.test(JSON.stringify(r.condition)))
      .slice(0, 12)
      .map((r) => ({ action: r.action.type, url: r.condition.urlFilter || r.condition.regexFilter, types: r.condition.resourceTypes }));
  } catch {}
  return out;
})()`;

const PLAYER_PROBE = `(() => {
  const response = window.ytInitialPlayerResponse || null;
  const player = document.querySelector('#movie_player, .html5-video-player');
  const video = document.querySelector('video');
  return {
    adPlacements: response && Array.isArray(response.adPlacements) ? response.adPlacements.length : null,
    hasStreaming: Boolean(response && response.streamingData),
    adShowing: Boolean(player && (player.classList.contains('ad-showing') || player.classList.contains('ad-interrupting'))),
    adModuleChildren: document.querySelectorAll('.video-ads .ytp-ad-module > *').length,
    skipButton: Boolean(document.querySelector('.ytp-skip-ad-button, .ytp-ad-skip-button')),
    time: video ? Math.round(video.currentTime * 10) / 10 : null,
  };
})()`;

async function run(name, extensionPath) {
  const profile = await mkdtemp(join(tmpdir(), 'adshield-cmp-'));
  const port = 9700 + Math.floor(Math.random() * 200);
  const child = spawn(
    CHROME,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--mute-audio',
      '--enable-unsafe-extension-debugging',
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${port}`,
    ],
    { stdio: 'ignore', windowsHide: true },
  );

  const report = { name, rules: null, blocked: new Map(), samples: [], final: null, storageKeys: null };
  try {
    await sleep(3500);
    const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    const browser = new Cdp(version.webSocketDebuggerUrl);
    await browser.connect();

    if (extensionPath) {
      const { id } = await browser.send('Extensions.loadUnpacked', { path: extensionPath });
      // espera o service worker ficar pronto
      let sw = null;
      for (let attempt = 0; attempt < 60 && !sw; attempt++) {
        await sleep(500);
        const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        sw = targets.find((t) => String(t.url).includes(id) && t.type === 'service_worker');
      }
      if (sw) {
        const swCdp = new Cdp(sw.webSocketDebuggerUrl);
        await swCdp.connect();
        await swCdp.send('Runtime.enable');
        // O AdBlock leva ~20 s para ligar as listas e compilar as regras dinâmicas.
        await sleep(25000);
        report.rules = await swCdp.evaluate(RULES_PROBE).catch((error) => ({ error: error.message }));
        report.storageKeys = await swCdp
          .evaluate('chrome.storage.local.get(null).then((all) => Object.keys(all).sort())')
          .catch(() => null);
        swCdp.close();
      } else {
        report.rules = { error: 'service worker não apareceu' };
      }
    }

    const target = await browser.send('Target.createTarget', { url: 'about:blank' });
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const page = targets.find((t) => t.id === target.targetId);
    const cdp = new Cdp(page.webSocketDebuggerUrl);
    await cdp.connect();

    const requests = new Map();
    cdp.on('Network.requestWillBeSent', (params) => requests.set(params.requestId, params.request.url));
    cdp.on('Network.loadingFailed', (params) => {
      const url = requests.get(params.requestId) || '(desconhecida)';
      const key = `${params.errorText} ${url}`;
      report.blocked.set(key, (report.blocked.get(key) || 0) + 1);
    });
    await cdp.send('Network.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Page.navigate', { url: URL_TO_TEST });

    const started = Date.now();
    while (Date.now() - started < SAMPLE_MS) {
      await sleep(2000);
      try {
        const sample = await cdp.evaluate(PLAYER_PROBE);
        report.samples.push({ at: Math.round((Date.now() - started) / 1000), ...sample });
      } catch {
        /* página navegando */
      }
    }
    report.final = await cdp.evaluate(PLAYER_PROBE).catch(() => null);
    cdp.close();
    browser.close();
  } finally {
    try {
      child.kill();
    } catch {
      /* ignore */
    }
    await sleep(300);
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  }
  return report;
}

function summarize(report) {
  console.log(`\n===== ${report.name} =====`);
  if (report.rules) {
    console.log('rulesets ligados :', JSON.stringify(report.rules.enabled));
    console.log('regras disponíveis:', report.rules.available, '| dinâmicas:', report.rules.dynamic, '| sessão:', report.rules.session);
    if (report.rules.youtubeDynamic && report.rules.youtubeDynamic.length) {
      console.log('regras dinâmicas com youtube:');
      for (const rule of report.rules.youtubeDynamic) console.log('  ', rule.action, rule.url, (rule.types || []).join(','));
    } else {
      console.log('regras dinâmicas com youtube: nenhuma');
    }
  }
  if (report.storageKeys) console.log('chaves no storage:', report.storageKeys.slice(0, 12).join(', '));

  const blocked = [...report.blocked.entries()].filter(([key]) => /youtube|googlevideo|doubleclick|googleads/.test(key));
  console.log(`requisições bloqueadas no YouTube: ${blocked.reduce((sum, [, n]) => sum + n, 0)}`);
  for (const [key, count] of blocked.slice(0, 10)) console.log(`   ${count}× ${key.slice(0, 150)}`);

  const adsSeen = report.samples.filter((sample) => sample.adShowing || sample.adModuleChildren > 0);
  console.log(`amostras com anúncio tocando: ${adsSeen.length}/${report.samples.length}`);
  if (report.samples.length) {
    const times = report.samples.map((sample) => sample.time);
    console.log(`tempo do vídeo nas amostras: ${times.join(' → ')}`);
    console.log(`adPlacements inicial: ${report.samples[0].adPlacements} | final: ${report.final?.adPlacements}`);
  }
  return { blockedCount: blocked.reduce((sum, [, n]) => sum + n, 0), adsSeen: adsSeen.length };
}

console.log(`URL: ${URL_TO_TEST}`);
const adblockReport = await run('AdBlock 6.51.0', ADBLOCK);
const adshieldReport = await run('AdShield 1.1.0', ROOT);

const a = summarize(adblockReport);
const b = summarize(adshieldReport);

console.log('\n===== resumo =====');
console.log(`bloqueios no YouTube  AdBlock: ${a.blockedCount}   AdShield: ${b.blockedCount}`);
console.log(`amostras com anúncio  AdBlock: ${a.adsSeen}   AdShield: ${b.adsSeen}`);


