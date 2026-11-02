#!/usr/bin/env node
/**
 * AdShield — inspeção do estado em tempo de execução do AdBlock 6.51.0.
 *
 * Carrega o pacote instalado num perfil novo, deixa inicializar por 45 s e
 * pergunta ao próprio service worker: regras ligadas, regras dinâmicas, e o
 * conteúdo das preferências (assinaturas de filtro incluídas).
 *
 * Uso: node tools/adblock-state.mjs
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const ADBLOCK = join(
  process.env.LOCALAPPDATA || '',
  'Google/Chrome/User Data/Profile 1/Extensions/gighmmpiobklfepjocnamgkkbiglidom/6.51.0_0',
);
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

const profile = await mkdtemp(join(tmpdir(), 'adblock-state-'));
const port = 9811;
const child = spawn(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--enable-unsafe-extension-debugging',
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${port}`,
  ],
  { stdio: 'ignore', windowsHide: true },
);

try {
  console.log(`pacote: ${ADBLOCK}\n`);
  await sleep(4000);
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const browser = new Cdp(version.webSocketDebuggerUrl);
  await browser.connect();
  const { id } = await browser.send('Extensions.loadUnpacked', { path: ADBLOCK });

  let swTarget = null;
  for (let attempt = 0; attempt < 40 && !swTarget; attempt++) {
    await sleep(500);
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    swTarget = targets.find((t) => String(t.url).includes(id) && t.type === 'service_worker');
  }
  if (!swTarget) throw new Error('service worker não apareceu');

  const sw = new Cdp(swTarget.webSocketDebuggerUrl);
  await sw.connect();
  await sw.send('Runtime.enable');

  for (const seconds of [5, 20, 45]) {
    await sleep(seconds === 5 ? 5000 : (seconds - (seconds === 20 ? 5 : 20)) * 1000);
    const state = await sw.evaluate(`(async () => {
      const dnr = chrome.declarativeNetRequest;
      const out = {};
      try { out.enabled = await dnr.getEnabledRulesets(); } catch (e) { out.enabled = 'erro'; }
      try { out.available = await dnr.getAvailableStaticRuleCount(); } catch {}
      try { out.dynamic = (await dnr.getDynamicRules()).length; } catch {}
      try { out.session = (await dnr.getSessionRules()).length; } catch {}
      return out;
    })()`);
    console.log(`t=${seconds}s  rulesets=${JSON.stringify(state.enabled)}  disponíveis=${state.available}  dinâmicas=${state.dynamic}  sessão=${state.session}`);
  }

  // Preferências e assinaturas guardadas dentro da extensão.
  const prefs = await sw.evaluate(`(async () => {
    const all = await chrome.storage.local.get(null);
    const out = {};
    for (const [key, value] of Object.entries(all)) {
      if (!/pref|subscri|filter|settings/i.test(key)) continue;
      let text;
      try { text = JSON.stringify(value); } catch { text = String(value); }
      out[key] = text.length > 1500 ? text.slice(0, 1500) + '…' : text;
    }
    return out;
  })()`);
  console.log('\n=== preferências relevantes ===');
  for (const [key, value] of Object.entries(prefs)) {
    console.log(`\n[${key}]\n${value}`);
  }

  // Procura conteúdo de filtro com sintaxe de snippet ou de YouTube.
  const search = await sw.evaluate(`(async () => {
    const all = await chrome.storage.local.get(null);
    const haystack = JSON.stringify(all);
    return {
      bytes: haystack.length,
      snippetSyntax: (haystack.match(/#\\$?#\\?\\?#?\\+js\\(/g) || []).length,
      plusJs: (haystack.match(/\\+js\\(/g) || []).length,
      youtubeMentions: (haystack.match(/youtube\\.com/g) || []).length,
      adPlacements: haystack.includes('adPlacements'),
    };
  })()`);
  console.log('\n=== busca no storage ===\n', JSON.stringify(search, null, 2));

  sw.close();
  browser.close();
} finally {
  child.kill();
  await sleep(300);
  await rm(profile, { recursive: true, force: true }).catch(() => {});
}
