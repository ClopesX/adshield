#!/usr/bin/env node
/**
 * Gera as capturas do popup e da página de opções para a documentação.
 * Carrega a extensão num perfil temporário, abre as telas em segundo plano
 * (para o popup enxergar a aba de teste como ativa) e salva PNGs em docs/.
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'docs');
const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome',
].find((candidate) => existsSync(candidate));
const PORT = 9551;
const HTTP_PORT = 8191;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>portal de notícias</title></head>
<body style="font:16px system-ui;padding:40px;background:#f6f7fb">
<h1>Portal de exemplo</h1>
<div class="adslot" style="height:60px;background:#e6e8ef;border-radius:8px">espaço de anúncio</div>
<p>Conteúdo da página.</p>
<script>
(async () => {
  for (const url of [
    'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js',
    'https://www.google-analytics.com/analytics.js',
  ]) { try { await fetch(url, { mode: 'no-cors', cache: 'no-store' }); } catch {} }
})();
</script></body></html>`;

class Cdp {
  constructor(url) {
    this.url = url;
    this.id = 0;
    this.pending = new Map();
  }
  async connect() {
    this.ws = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve);
      this.ws.addEventListener('error', reject);
    });
    this.ws.addEventListener('message', (event) => {
      const frame = JSON.parse(event.data);
      const entry = this.pending.get(frame.id);
      if (!entry) return;
      this.pending.delete(frame.id);
      frame.error ? entry.reject(new Error(frame.error.message)) : entry.resolve(frame.result);
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`timeout ${method}`));
      }, 30000);
    });
  }
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || 'erro');
    return result.result.value;
  }
}

const server = createServer((request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end(PAGE);
});
await new Promise((resolve) => server.listen(HTTP_PORT, '127.0.0.1', resolve));
await mkdir(OUT, { recursive: true });

const profile = await mkdtemp(join(tmpdir(), 'adshield-shots-'));
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--enable-unsafe-extension-debugging',
    '--hide-scrollbars',
    '--force-color-profile=srgb',
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${PORT}`,
  ],
  { stdio: 'ignore', windowsHide: true },
);

try {
  await sleep(4000);
  const version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
  const browser = new Cdp(version.webSocketDebuggerUrl);
  await browser.connect();

  const { id: extensionId } = await browser.send('Extensions.loadUnpacked', { path: ROOT });
  let ready = false;
  for (let attempt = 0; attempt < 60 && !ready; attempt++) {
    await sleep(500);
    const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const sw = targets.find((t) => String(t.url).includes(`${extensionId}/src/background/service-worker.js`));
    if (sw) {
      const cdp = new Cdp(sw.webSocketDebuggerUrl);
      await cdp.connect();
      await cdp.send('Runtime.enable');
      try {
        const available = await cdp.evaluate('chrome.declarativeNetRequest.getAvailableStaticRuleCount()');
        ready = typeof available === 'number' && available < 300000;
      } catch {
        ready = false;
      }
      cdp.ws.close();
    }
  }
  console.log(`listas prontas: ${ready}`);

  // Aba de conteúdo ativa (o popup usa a aba ativa para mostrar o site).
  const pageTarget = await browser.send('Target.createTarget', { url: `http://127.0.0.1:${HTTP_PORT}/` });
  await sleep(2500);

  async function shoot(url, { width, height, out, fullPage = false, settle = 1200 }) {
    const created = await browser.send('Target.createTarget', { url, background: true });
    await sleep(settle);
    const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const target = targets.find((t) => t.id === created.targetId) ||
      targets.find((t) => String(t.url).includes(url.split('/').pop()));
    if (!target) throw new Error(`alvo não encontrado para ${url}`);
    const cdp = new Cdp(target.webSocketDebuggerUrl);
    await cdp.connect();
    await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 2,
      mobile: false,
    });
    await sleep(600);
    const shot = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: fullPage,
    });
    await writeFile(join(OUT, out), Buffer.from(shot.data, 'base64'));
    cdp.ws.close();
    await browser.send('Target.closeTarget', { targetId: created.targetId }).catch(() => {});
    console.log(`docs/${out}`);
  }

  await shoot(`chrome-extension://${extensionId}/src/popup/popup.html`, {
    width: 340,
    height: 430,
    out: 'popup.png',
  });
  await shoot(`chrome-extension://${extensionId}/src/options/options.html`, {
    width: 900,
    height: 1250,
    out: 'options.png',
    fullPage: true,
    settle: 1800,
  });

  await browser.send('Target.closeTarget', { targetId: pageTarget.targetId }).catch(() => {});
  browser.ws.close();
} finally {
  chrome.kill();
  server.close();
  await sleep(400);
  await rm(profile, { recursive: true, force: true }).catch(() => {});
}
