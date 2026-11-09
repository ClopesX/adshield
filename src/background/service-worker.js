/**
 * AdShield — service worker.
 *
 * Responsabilidades:
 *  - ligar/desligar as listas estáticas de declarativeNetRequest;
 *  - regras de sessão para allowlist por site e pausa por aba;
 *  - compilar filtros personalizados e assinaturas para regras dinâmicas;
 *  - contador por aba, estatísticas locais e selo do ícone;
 *  - responder ao popup, às opções e ao seletor de elemento.
 *
 * Nenhuma requisição sai daqui, exceto quando o usuário adiciona uma
 * assinatura de lista e pede para baixá-la.
 */

import { compileText, validateDnrRule } from '../common/abp.js';
import { hostCandidates, registrableDomain } from '../common/domain.js';

/**
 * Rulesets vêm do manifest: as listas de rede ficam em várias partes
 * (base-1..base-N) e o YouTube tem a sua, que pode ser desligada sozinha.
 */
const ALL_RULESETS = (
  chrome.runtime.getManifest().declarative_net_request?.rule_resources || []
).map((resource) => resource.id);
const YOUTUBE_RULESET = 'youtube';
const BASE_RULESETS = ALL_RULESETS.filter((id) => id !== YOUTUBE_RULESET);

const SITE_RULE_BASE = 1; // 1..4999
const TAB_RULE_BASE = 90000; // 90000 + tabId
const CUSTOM_RULE_BASE = 1; // dinâmicas: 1..2499
const CUSTOM_RULE_LIMIT = 2500;
const SUB_RULE_BASE = 2500; // dinâmicas: 2500..5000
const SUB_RULE_LIMIT = 2500;

const DEFAULT_SETTINGS = {
  enabled: true,
  cosmetic: true,
  youtube: true,
};

const STORAGE = {
  settings: 'settings',
  allowlist: 'siteAllowlist',
  customFilters: 'customFilters',
  customCosmetic: 'customCosmetic',
  subscriptions: 'subscriptions',
  stats: 'stats',
};

let cosmeticCache = null;
let statsCache = null;
let statsFlushTimer = null;
const tabCounts = new Map();
const badgeTimers = new Map();

/* ------------------------------------------------------------------ */
/* Armazenamento                                                       */
/* ------------------------------------------------------------------ */

async function getSettings() {
  const stored = await chrome.storage.local.get(STORAGE.settings);
  return { ...DEFAULT_SETTINGS, ...(stored[STORAGE.settings] || {}) };
}

async function saveSettings(patch) {
  const next = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ [STORAGE.settings]: next });
  return next;
}

async function getAllowlist() {
  const stored = await chrome.storage.local.get(STORAGE.allowlist);
  return Array.isArray(stored[STORAGE.allowlist]) ? stored[STORAGE.allowlist] : [];
}

async function setAllowlist(list) {
  const unique = [...new Set(list.filter(Boolean).map((item) => item.toLowerCase()))];
  await chrome.storage.local.set({ [STORAGE.allowlist]: unique });
  await rebuildSiteRules();
  return unique;
}

function todayKey() {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

async function loadStats() {
  if (statsCache) return statsCache;
  const stored = await chrome.storage.local.get(STORAGE.stats);
  statsCache = stored[STORAGE.stats] || { total: 0, days: {} };
  return statsCache;
}

function scheduleStatsFlush() {
  if (statsFlushTimer) return;
  statsFlushTimer = setTimeout(() => {
    statsFlushTimer = null;
    if (statsCache) void chrome.storage.local.set({ [STORAGE.stats]: statsCache });
  }, 4000);
}

/* ------------------------------------------------------------------ */
/* Regras de sessão: allowlist por site e pausa por aba                */
/* ------------------------------------------------------------------ */

async function rebuildSiteRules() {
  const allowlist = await getAllowlist();
  const existing = await chrome.declarativeNetRequest.getSessionRules();
  const ours = existing
    .filter((rule) => rule.id < TAB_RULE_BASE)
    .map((rule) => rule.id);

  const addRules = allowlist.slice(0, 4000).map((domain, index) => ({
    id: SITE_RULE_BASE + index,
    priority: 1000,
    action: { type: 'allowAllRequests' },
    condition: {
      requestDomains: [domain],
      resourceTypes: ['main_frame', 'sub_frame'],
    },
  }));

  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: ours,
    addRules,
  });
}

async function setTabPaused(tabId, paused) {
  const ruleId = TAB_RULE_BASE + tabId;
  if (paused) {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [ruleId],
      addRules: [
        {
          id: ruleId,
          priority: 1000,
          action: { type: 'allowAllRequests' },
          condition: {
            tabIds: [tabId],
            resourceTypes: ['main_frame', 'sub_frame'],
          },
        },
      ],
    });
  } else {
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ruleId] });
  }
  tabCounts.set(tabId, 0);
  await updateBadge(tabId);
}

async function isTabPaused(tabId) {
  const rules = await chrome.declarativeNetRequest.getSessionRules();
  return rules.some((rule) => rule.id === TAB_RULE_BASE + tabId);
}

/* ------------------------------------------------------------------ */
/* Listas estáticas                                                    */
/* ------------------------------------------------------------------ */

/**
 * Script de bloqueio do YouTube (mundo MAIN).
 *
 * É registrado em tempo de execução, e não no manifest, para poder ser
 * desligado junto com a chave "youtube" das opções. `world: "MAIN"` é o que
 * permite limpar a resposta do player antes da página usá-la.
 */
const YOUTUBE_SCRIPT_ID = 'adshield-youtube-main';

async function syncYoutubeScript(settings) {
  const wanted = Boolean(settings.enabled && settings.youtube);
  let registered = [];
  try {
    registered = await chrome.scripting.getRegisteredContentScripts({ ids: [YOUTUBE_SCRIPT_ID] });
  } catch {
    registered = [];
  }
  const isRegistered = registered.length > 0;

  try {
    if (wanted && !isRegistered) {
      await chrome.scripting.registerContentScripts([
        {
          id: YOUTUBE_SCRIPT_ID,
          matches: ['*://*.youtube.com/*'],
          js: ['src/content/youtube-main.js'],
          css: ['src/content/youtube.css'],
          runAt: 'document_start',
          allFrames: false,
          world: 'MAIN',
          persistAcrossSessions: true,
        },
      ]);
    } else if (!wanted && isRegistered) {
      await chrome.scripting.unregisterContentScripts({ ids: [YOUTUBE_SCRIPT_ID] });
    }
  } catch (error) {
    console.warn('[AdShield] script do YouTube:', error);
  }
}

async function applyStaticRulesets(settings) {
  const enable = [];
  const disable = [];
  const youtubeOn = settings.enabled && settings.youtube;

  if (settings.enabled) enable.push(...BASE_RULESETS);
  else disable.push(...BASE_RULESETS);
  if (youtubeOn) enable.push(YOUTUBE_RULESET);
  else disable.push(YOUTUBE_RULESET);

  try {
    await chrome.declarativeNetRequest.updateEnabledRulesets({
      enableRulesetIds: enable,
      disableRulesetIds: disable,
    });
  } catch (error) {
    console.error('[AdShield] falha ao alternar listas:', error);
  }
  await syncYoutubeScript(settings);
}

/* ------------------------------------------------------------------ */
/* Filtros personalizados e assinaturas (regras dinâmicas)             */
/* ------------------------------------------------------------------ */

async function applyCustomFilters(text) {
  const source = typeof text === 'string' ? text : '';
  const compiled = compileText(source, { startId: CUSTOM_RULE_BASE, maxRules: CUSTOM_RULE_LIMIT });
  const rules = compiled.rules.filter((rule) => validateDnrRule(rule).length === 0);
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = existing
    .filter((rule) => rule.id >= CUSTOM_RULE_BASE && rule.id < SUB_RULE_BASE)
    .map((rule) => rule.id);

  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds,
    addRules: rules.map((rule) => ({
      id: rule.id,
      priority: rule.priority,
      action: rule.action,
      condition: rule.condition,
    })),
  });

  return {
    applied: rules.length,
    truncated: compiled.rules.length >= CUSTOM_RULE_LIMIT,
    skipped: Object.fromEntries(compiled.skipped),
  };
}

async function getSubscriptions() {
  const stored = await chrome.storage.local.get(STORAGE.subscriptions);
  return Array.isArray(stored[STORAGE.subscriptions]) ? stored[STORAGE.subscriptions] : [];
}

async function downloadList(url) {
  const response = await fetch(url, { credentials: 'omit', redirect: 'follow' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const text = await response.text();
  if (text.length < 64) throw new Error('lista vazia');
  return text;
}

async function refreshSubscriptions(report = {}) {
  const subscriptions = await getSubscriptions();
  const enabled = subscriptions.filter((sub) => sub.enabled !== false);
  const addRules = [];
  let nextId = SUB_RULE_BASE;
  const failures = [];

  for (const sub of enabled) {
    if (nextId - SUB_RULE_BASE >= SUB_RULE_LIMIT) break;
    try {
      const text = await downloadList(sub.url);
      const compiled = compileText(text, {
        startId: nextId,
        maxRules: Math.min(600, SUB_RULE_LIMIT - (nextId - SUB_RULE_BASE)),
      });
      for (const rule of compiled.rules) {
        if (validateDnrRule(rule).length) continue;
        if (nextId - SUB_RULE_BASE >= SUB_RULE_LIMIT) break;
        addRules.push({
          id: nextId,
          priority: rule.priority,
          action: rule.action,
          condition: rule.condition,
        });
        nextId += 1;
      }
      sub.lastUpdated = new Date().toISOString();
      sub.ruleCount = compiled.rules.length;
      sub.error = null;
      report[sub.url] = 'ok';
    } catch (error) {
      sub.error = error.message;
      failures.push(`${sub.url}: ${error.message}`);
    }
  }

  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = existing
    .filter((rule) => rule.id >= SUB_RULE_BASE)
    .map((rule) => rule.id);

  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules });
  await chrome.storage.local.set({ [STORAGE.subscriptions]: subscriptions });
  if (failures.length) console.warn('[AdShield] assinaturas com erro:', failures.join(' | '));
  return { rules: addRules.length, subscriptions, failures };
}

/* ------------------------------------------------------------------ */
/* Cosmético                                                           */
/* ------------------------------------------------------------------ */

async function loadCosmetic() {
  if (cosmeticCache) return cosmeticCache;
  try {
    const response = await fetch(chrome.runtime.getURL('rules/cosmetic-domains.json'));
    const data = await response.json();
    cosmeticCache = { domains: data.domains || {}, unhide: data.unhide || {} };
  } catch (error) {
    console.warn('[AdShield] cosmetic-domains.json indisponível:', error);
    cosmeticCache = { domains: {}, unhide: {} };
  }
  return cosmeticCache;
}

async function cosmeticFor(host, settings) {
  if (!settings.cosmetic || !host) return { hide: [], remove: [], unhide: [] };
  const { domains, unhide } = await loadCosmetic();
  const candidates = hostCandidates(host);
  const hide = new Set();
  const remove = new Set();
  const unhideSet = new Set();

  for (const candidate of candidates) {
    const entry = domains[candidate];
    if (entry) for (const selector of entry.split(',')) hide.add(selector.trim());
    const exclusions = unhide[candidate];
    if (exclusions) for (const selector of exclusions) unhideSet.add(selector.trim());
  }

  const custom = await readCustomCosmetic();
  for (const candidate of candidates) {
    for (const [selector, mode] of Object.entries(custom[candidate] || {})) {
      if (mode === 'remove') remove.add(selector);
      else hide.add(selector);
    }
  }

  const hideList = [...hide].filter((selector) => selector && !unhideSet.has(selector) && !remove.has(selector));
  return { hide: hideList, remove: [...remove], unhide: [...unhideSet] };
}

/** Modos de uma regra personalizada: esconder (CSS) ou tirar do DOM. */
const COSMETIC_MODES = new Set(['hide', 'remove']);

/**
 * Aceita o formato antigo (`{dominio: ["seletor"]}`) e o novo
 * (`{dominio: {"seletor": "hide" | "remove"}}`), sempre devolvendo o novo.
 */
function normalizeCustomCosmetic(raw) {
  const result = {};
  if (!raw || typeof raw !== 'object') return result;
  for (const [domain, value] of Object.entries(raw)) {
    if (!domain || typeof domain !== 'string') continue;
    const rules = {};
    if (Array.isArray(value)) {
      for (const selector of value) {
        if (typeof selector === 'string' && selector) rules[selector] = 'hide';
      }
    } else if (value && typeof value === 'object') {
      for (const [selector, mode] of Object.entries(value)) {
        if (typeof selector === 'string' && selector) {
          rules[selector] = COSMETIC_MODES.has(mode) ? mode : 'hide';
        }
      }
    }
    if (Object.keys(rules).length) result[domain] = rules;
  }
  return result;
}

async function readCustomCosmetic() {
  const stored = await chrome.storage.local.get(STORAGE.customCosmetic);
  return normalizeCustomCosmetic(stored[STORAGE.customCosmetic]);
}

async function writeCustomCosmetic(custom) {
  const clean = normalizeCustomCosmetic(custom);
  await chrome.storage.local.set({ [STORAGE.customCosmetic]: clean });
  return clean;
}

async function addCustomCosmetic(host, selector, mode = 'hide') {
  const custom = await readCustomCosmetic();
  const base = registrableDomain(host) || host;
  const rules = custom[base] || {};
  rules[selector] = COSMETIC_MODES.has(mode) ? mode : 'hide';
  custom[base] = rules;
  const next = await writeCustomCosmetic(custom);
  return { domain: base, mode: rules[selector], rules: next[base] || {}, customCosmetic: next };
}

async function applyCosmeticMode(domain, selector, mode) {
  if (!COSMETIC_MODES.has(mode)) throw new Error(`modo inválido: ${mode}`);
  const custom = await readCustomCosmetic();
  if (!custom[domain] || !(selector in custom[domain])) throw new Error('regra não encontrada');
  custom[domain][selector] = mode;
  return writeCustomCosmetic(custom);
}

async function deleteCosmeticRule(domain, selector) {
  const custom = await readCustomCosmetic();
  if (custom[domain]) delete custom[domain][selector];
  return writeCustomCosmetic(custom);
}

async function deleteCosmeticRules(domain) {
  const custom = await readCustomCosmetic();
  if (domain) delete custom[domain];
  else for (const key of Object.keys(custom)) delete custom[key];
  return writeCustomCosmetic(custom);
}

/* ------------------------------------------------------------------ */
/* Contador e selo                                                     */
/* ------------------------------------------------------------------ */

async function updateBadge(tabId) {
  try {
    const count = tabCounts.get(tabId) || 0;
    await chrome.action.setBadgeText({ tabId, text: count ? String(count) : '' });
    await chrome.action.setBadgeBackgroundColor({ tabId, color: '#2f6fed' });
  } catch {
    /* aba pode ter fechado */
  }
}

function scheduleBadge(tabId) {
  if (badgeTimers.has(tabId)) return;
  badgeTimers.set(
    tabId,
    setTimeout(() => {
      badgeTimers.delete(tabId);
      void updateBadge(tabId);
    }, 400),
  );
}

async function recordBlock(request) {
  const tabId = request.tabId;
  if (typeof tabId === 'number' && tabId >= 0) {
    tabCounts.set(tabId, (tabCounts.get(tabId) || 0) + 1);
    scheduleBadge(tabId);
  }

  const stats = await loadStats();
  const key = todayKey();
  const day = stats.days[key] || { blocked: 0, domains: {} };
  day.blocked += 1;

  let host = '';
  try {
    host = new URL(request.initiator || request.documentUrl || request.url).hostname;
  } catch {
    host = '';
  }
  if (host) {
    day.domains[host] = (day.domains[host] || 0) + 1;
    const entries = Object.entries(day.domains);
    if (entries.length > 120) {
      entries.sort((a, b) => b[1] - a[1]);
      day.domains = Object.fromEntries(entries.slice(0, 80));
    }
  }
  stats.days[key] = day;
  stats.total = (stats.total || 0) + 1;

  const days = Object.keys(stats.days);
  if (days.length > 60) {
    days.sort();
    for (const stale of days.slice(0, days.length - 60)) delete stats.days[stale];
  }
  scheduleStatsFlush();
}

function installCounter() {
  const api = chrome.declarativeNetRequest;
  if (!api || !api.onRuleMatchedDebug) {
    console.info('[AdShield] contador exato indisponível (onRuleMatchedDebug ausente).');
    return;
  }
  api.onRuleMatchedDebug.addListener((info) => {
    try {
      if (info.rule && info.rule.rulesetId === '_session') return; // allowlist/pausa
      void recordBlock(info.request);
    } catch (error) {
      console.warn('[AdShield] contador:', error);
    }
  });
}

/* ------------------------------------------------------------------ */
/* Estado para popup/opções                                            */
/* ------------------------------------------------------------------ */

function hostFromUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    return parsed.hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function matchesAllowlist(host, allowlist) {
  if (!host) return false;
  return allowlist.some((entry) => host === entry || host.endsWith(`.${entry}`));
}

async function buildState(tabId) {
  const settings = await getSettings();
  const allowlist = await getAllowlist();
  let tab = null;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    tab = null;
  }
  const host = tab ? hostFromUrl(tab.url || '') : '';
  const stats = await loadStats();
  const today = stats.days[todayKey()] || { blocked: 0, domains: {} };

  return {
    settings,
    host,
    siteAllowlisted: matchesAllowlist(host, allowlist),
    tabPaused: tabId >= 0 ? await isTabPaused(tabId) : false,
    count: tabCounts.get(tabId) || 0,
    totalToday: today.blocked,
    totalAll: stats.total || 0,
    allowlistCount: allowlist.length,
    counterAvailable: Boolean(chrome.declarativeNetRequest.onRuleMatchedDebug),
    version: chrome.runtime.getManifest().version,
  };
}

/* ------------------------------------------------------------------ */
/* Mensagens                                                           */
/* ------------------------------------------------------------------ */

const handlers = {
  async state(message, sender) {
    const tabId = message.tabId ?? sender.tab?.id ?? -1;
    return buildState(tabId);
  },

  async toggleGlobal(message) {
    const settings = await getSettings();
    const next = await saveSettings({ enabled: !settings.enabled });
    await applyStaticRulesets(next);
    return buildState(message.tabId ?? -1);
  },

  async toggleSite(message, sender) {
    const tabId = message.tabId ?? sender.tab?.id ?? -1;
    const host = message.host || '';
    if (!host) return buildState(tabId);
    const allowlist = await getAllowlist();
    const index = allowlist.findIndex((entry) => host === entry || host.endsWith(`.${entry}`));
    if (index >= 0) allowlist.splice(index, 1);
    else allowlist.push(host);
    await setAllowlist(allowlist);
    return buildState(tabId);
  },

  async toggleTabPause(message, sender) {
    const tabId = message.tabId ?? sender.tab?.id ?? -1;
    if (tabId < 0) throw new Error('aba inválida');
    const paused = await isTabPaused(tabId);
    await setTabPaused(tabId, !paused);
    return buildState(tabId);
  },

  async cosmetic(message) {
    const settings = await getSettings();
    return cosmeticFor(message.host || '', settings);
  },

  async pickElement(message, sender) {
    const tabId = message.tabId ?? sender.tab?.id ?? -1;
    const host = message.host || (sender.tab ? hostFromUrl(sender.tab.url || '') : '');
    if (!host || !message.selector) throw new Error('seleção inválida');
    const result = await addCustomCosmetic(host, message.selector, message.mode || 'hide');
    return { ok: true, tabId, domain: result.domain, mode: result.mode, rules: result.rules };
  },

  async setCosmeticMode(message) {
    const domain = String(message.domain || '');
    const selector = String(message.selector || '');
    const mode = String(message.mode || '');
    if (!domain || !selector) throw new Error('regra inválida');
    const customCosmetic = await applyCosmeticMode(domain, selector, mode);
    return { ok: true, customCosmetic };
  },

  async undoPick(message) {
    const domain = String(message.domain || '');
    const selector = String(message.selector || '');
    if (!domain || !selector) throw new Error('regra inválida');
    const customCosmetic = await deleteCosmeticRule(domain, selector);
    return { ok: true, customCosmetic };
  },

  async removeCustomCosmetic(message) {
    const domain = String(message.domain || '');
    const selector = String(message.selector || '');
    if (!domain || !selector) throw new Error('regra inválida');
    const customCosmetic = await deleteCosmeticRule(domain, selector);
    return { ok: true, customCosmetic };
  },

  async clearCustomCosmetic(message) {
    const customCosmetic = await deleteCosmeticRules(message.domain ? String(message.domain) : '');
    return { ok: true, customCosmetic };
  },

  async stats() {
    const stats = await loadStats();
    return stats;
  },

  async resetStats() {
    statsCache = { total: 0, days: {} };
    await chrome.storage.local.set({ [STORAGE.stats]: statsCache });
    return statsCache;
  },

  async info() {
    const subscriptions = await getSubscriptions();
    const allowlist = await getAllowlist();
    const stored = await chrome.storage.local.get([STORAGE.customFilters, STORAGE.customCosmetic]);
    let report = null;
    try {
      report = await (await fetch(chrome.runtime.getURL('rules/report.json'))).json();
    } catch {
      report = null;
    }
    return {
      report,
      subscriptions,
      allowlist,
      customFilters: stored[STORAGE.customFilters] || '',
      customCosmetic: stored[STORAGE.customCosmetic] || {},
    };
  },

  async setCustomFilters(message) {
    const text = typeof message.text === 'string' ? message.text : '';
    await chrome.storage.local.set({ [STORAGE.customFilters]: text });
    return applyCustomFilters(text);
  },

  async addSubscription(message) {
    const url = String(message.url || '').trim();
    if (!/^https?:\/\//i.test(url)) throw new Error('URL precisa começar com http:// ou https://');
    const subscriptions = await getSubscriptions();
    if (subscriptions.some((sub) => sub.url === url)) throw new Error('essa assinatura já existe');
    subscriptions.push({
      url,
      title: message.title || url,
      enabled: true,
      lastUpdated: null,
      ruleCount: 0,
      error: null,
    });
    await chrome.storage.local.set({ [STORAGE.subscriptions]: subscriptions });
    return refreshSubscriptions();
  },

  async removeSubscription(message) {
    const url = String(message.url || '');
    const subscriptions = (await getSubscriptions()).filter((sub) => sub.url !== url);
    await chrome.storage.local.set({ [STORAGE.subscriptions]: subscriptions });
    return refreshSubscriptions();
  },

  async refreshSubscriptions() {
    return refreshSubscriptions();
  },

  async updateSettings(message) {
    const settings = await saveSettings(message.patch || {});
    await applyStaticRulesets(settings);
    return settings;
  },

  async openOptions() {
    await chrome.runtime.openOptionsPage();
    return { ok: true };
  },
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = handlers[message?.type];
  if (!handler) {
    sendResponse({ error: `mensagem desconhecida: ${message?.type}` });
    return false;
  }
  Promise.resolve(handler(message, sender))
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error) => {
      console.error(`[AdShield] ${message.type}:`, error);
      sendResponse({ ok: false, error: error.message });
    });
  return true; // resposta assíncrona
});

/* ------------------------------------------------------------------ */
/* Ciclo de vida                                                       */
/* ------------------------------------------------------------------ */

async function bootstrap() {
  const settings = await getSettings();
  await applyStaticRulesets(settings);
  await rebuildSiteRules();

  const stored = await chrome.storage.local.get(STORAGE.customFilters);
  if (stored[STORAGE.customFilters]) {
    try {
      await applyCustomFilters(stored[STORAGE.customFilters]);
    } catch (error) {
      console.warn('[AdShield] filtros personalizados:', error);
    }
  }

  const subscriptions = await getSubscriptions();
  if (subscriptions.some((sub) => sub.enabled !== false)) {
    chrome.alarms.create('refresh-subscriptions', { periodInMinutes: 24 * 60 });
  }
}

chrome.runtime.onInstalled.addListener((details) => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'adshield-block-element',
      title: 'Bloquear este elemento (AdShield)',
      contexts: ['page', 'frame', 'selection', 'image'],
    });
  });
  void bootstrap().catch((error) => console.error('[AdShield] bootstrap:', error));
  if (details.reason === 'install') {
    console.info('[AdShield] instalado. Nenhuma requisição de rede é feita.');
  }
});

chrome.runtime.onStartup.addListener(() => {
  void bootstrap().catch((error) => console.error('[AdShield] startup:', error));
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'adshield-block-element' || !tab?.id) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'startPicker' }, { frameId: info.frameId ?? 0 });
  } catch {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id, frameIds: [info.frameId ?? 0] },
        files: ['src/content/cosmetic.js'],
      });
      await chrome.tabs.sendMessage(tab.id, { type: 'startPicker' }, { frameId: info.frameId ?? 0 });
    } catch (error) {
      console.warn('[AdShield] seletor indisponível nesta página:', error);
    }
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    tabCounts.set(tabId, 0);
    void updateBadge(tabId);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabCounts.delete(tabId);
  const timer = badgeTimers.get(tabId);
  if (timer) clearTimeout(timer);
  badgeTimers.delete(tabId);
  void chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [TAB_RULE_BASE + tabId] });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'refresh-subscriptions') {
    void refreshSubscriptions().catch((error) => console.warn('[AdShield] assinaturas:', error));
  }
});

installCounter();
void bootstrap().catch((error) => console.error('[AdShield] bootstrap inicial:', error));





