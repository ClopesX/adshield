#!/usr/bin/env node
/**
 * AdShield — conferência no YouTube real.
 *
 * Abre a mesma página de vídeo em dois Chrome headless: sem a extensão e com a
 * extensão, e compara o que o player recebeu de anúncio.
 *
 * Depende de rede e do que o YouTube entrega para este IP/navegador — é uma
 * conferência de campo, não um teste determinístico (esse é o tools/e2e.mjs).
 *
 * Uso: node tools/youtube-check.mjs [url]
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
const URL_TO_TEST = process.argv[2] || 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

const PROBE = `(() => {
  const response = window.ytInitialPlayerResponse || null;
  const player = document.querySelector('#movie_player, .html5-video-player');
  const video = document.querySelector('video');
  const adsInDom = document.querySelectorAll(
    '.video-ads .ytp-ad-module, .ytp-ad-overlay-slot, ytd-ad-slot-renderer, #masthead-ad'
  ).length;
  return {
    title: (document.title || '').slice(0, 60),
    hasResponse: Boolean(response),
    adPlacements: response && Array.isArray(response.adPlacements) ? response.adPlacements.length : null,
    playerAds: response && Array.isArray(response.playerAds) ? response.playerAds.length : null,
    adSlots: response && Array.isArray(response.adSlots) ? response.adSlots.length : null,
    hasStreaming: Boolean(response && response.streamingData),
    playability: response && response.playabilityStatus && response.playabilityStatus.status,
    adShowing: Boolean(player && player.classList.contains('ad-showing')),
    videoReady: video ? video.readyState : null,
    videoTime: video ? Math.round(video.currentTime * 10) / 10 : null,
    adsInDom,
  };
})()`;

async function run(label, { withExtension }) {
  const profile = await mkdtemp(join(tmpdir(), 'adshield-yt-'));
  const port = 9600 + (withExtension ? 1 : 0);
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

  try {
    await sleep(4000);
    const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    const browser = new Cdp(version.webSocketDebuggerUrl);
    await browser.connect();

    if (withExtension) {
      const { id } = await browser.send('Extensions.loadUnpacked', { path: ROOT });
      // espera as regras carregarem
      for (let attempt = 0; attempt < 60; attempt++) {
        await sleep(500);
        const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        const sw = targets.find((t) => String(t.url).includes(`${id}/src/background/service-worker.js`));
        if (!sw) continue;
        const swCdp = new Cdp(sw.webSocketDebuggerUrl);
        await swCdp.connect();
        await swCdp.send('Runtime.enable');
        try {
          const available = await swCdp.evaluate('chrome.declarativeNetRequest.getAvailableStaticRuleCount()');
          if (typeof available === 'number' && available < 300000) {
            swCdp.close();
            break;
          }
        } catch {
          /* ainda subindo */
        }
        swCdp.close();
      }
    }

    const target = await browser.send('Target.createTarget', { url: URL_TO_TEST });
    await sleep(9000);
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const page = targets.find((t) => t.id === target.targetId);
    const cdp = new Cdp(page.webSocketDebuggerUrl);
    await cdp.connect();
    await cdp.send('Runtime.enable');
    await sleep(1500);
    const probe = await cdp.evaluate(PROBE);
    cdp.close();
    browser.close();
    return probe;
  } finally {
    try {
      child.kill();
    } catch {
      /* ignore */
    }
    await sleep(400);
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  }
}

console.log(`URL: ${URL_TO_TEST}\n`);
const without = await run('sem extensão', { withExtension: false });
console.log('sem extensão:');
console.log(JSON.stringify(without, null, 2));
const withExt = await run('com AdShield', { withExtension: true });
console.log('\ncom AdShield:');
console.log(JSON.stringify(withExt, null, 2));

console.log('\n=== comparação ===');
const rows = [
  ['adPlacements', without.adPlacements, withExt.adPlacements],
  ['playerAds', without.playerAds, withExt.playerAds],
  ['adSlots', without.adSlots, withExt.adSlots],
  ['ad-showing', without.adShowing, withExt.adShowing],
  ['anúncios no DOM', without.adsInDom, withExt.adsInDom],
  ['vídeo pronto', without.videoReady, withExt.videoReady],
];
for (const [name, before, after] of rows) {
  console.log(`${name.padEnd(18)} sem: ${String(before).padEnd(6)} com: ${after}`);
}
