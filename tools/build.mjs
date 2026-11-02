#!/usr/bin/env node
/**
 * AdShield — build das regras.
 *
 * Baixa EasyList + EasyPrivacy (ou usa o cache local), compila com
 * src/common/abp.js e grava:
 *   rules/base.json            regras declarativeNetRequest (rede)
 *   rules/youtube.json         regras específicas do YouTube
 *   rules/cosmetic-generic.css ocultação genérica (injetada via content_scripts.css)
 *   rules/cosmetic-domains.json ocultação por domínio (consultada pelo service worker)
 *   rules/report.json          estatísticas do build (mostradas na página de opções)
 *
 * Uso:
 *   node tools/build.mjs            # usa cache se existir
 *   node tools/build.mjs --refresh  # força novo download
 *   node tools/build.mjs --offline  # só cache, falha se não houver
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import https from 'node:https';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  compileText,
  cosmeticToJson,
  parseNetworkFilter,
  toDnrRule,
  ruleKey,
  validateDnrRule,
} from '../src/common/abp.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = join(ROOT, 'data', 'cache');
const RULES = join(ROOT, 'rules');

/**
 * Orçamento de regras estáticas.
 *
 * O piso garantido do Chrome é 30.000 regras, mas extensões carregadas sem
 * empacotar (modo desenvolvedor) recebem 330.000. O padrão aqui usa esse
 * espaço extra; use `--budget 28000` para gerar um pacote portável.
 */
const DEFAULT_BUDGET = 290000;
const GENERIC_COSMETIC_LIMIT = 20000;

/**
 * Tamanho de cada arquivo de regras. O Chrome recomenda até 30.000 regras por
 * ruleset e carrega os arquivos em paralelo — dividir também acelera a
 * ativação inicial.
 */
const CHUNK_SIZE = 25000;
const BASE_SLOTS = 6;

const LISTS = [
  {
    key: 'easylist',
    title: 'EasyList',
    url: 'https://easylist.to/easylist/easylist.txt',
    home: 'https://easylist.to/',
    license: 'CC BY-SA 3.0',
  },
  {
    key: 'easyprivacy',
    title: 'EasyPrivacy',
    url: 'https://easylist.to/easylist/easyprivacy.txt',
    home: 'https://easylist.to/',
    license: 'CC BY-SA 3.0',
  },
  {
    // O AdBlock 6.51.0 liga esta lista por padrão (visto em abp:pref /
    // ewe:subscriptionLedger): sites em português.
    key: 'easylistportuguese',
    title: 'EasyList Português',
    url: 'https://easylist-downloads.adblockplus.org/easylistportuguese.txt',
    home: 'https://easylist.to/',
    license: 'CC BY-SA 3.0',
  },
];

const YOUTUBE_RULES = [
  // Mesma base que o AdBlock 6.51.0 usa nas listas dele (conferido no pacote
  // instalado): pedido de bloco de anúncio, estatística de anúncio e pings.
  { urlFilter: '||youtube.com/youtubei/v1/player/ad_break', types: ['xmlhttprequest'] },
  { urlFilter: '||youtube.com/api/stats/ads', types: ['xmlhttprequest', 'ping', 'image'] },
  { urlFilter: '||youtube.com/ptracking', types: ['image', 'xmlhttprequest', 'ping'] },
  // Extras nossos, conservadores.
  { urlFilter: '||youtube.com/youtubei/v1/log_event', types: ['xmlhttprequest'] },
  { urlFilter: '||googlevideo.com/videoplayback*&adformat=', types: ['xmlhttprequest', 'media'] },
  { urlFilter: '||googlevideo.com/videogoodput', types: ['xmlhttprequest', 'ping'] },
  { urlFilter: '||youtube.com/get_video_info*adformat=', types: ['xmlhttprequest'] },
  { urlFilter: '||doubleclick.net/pixel*', types: ['image', 'xmlhttprequest'] },
];

function parseArgs(argv) {
  const budgetIndex = argv.indexOf('--budget');
  const budgetValue = budgetIndex >= 0 ? Number(argv[budgetIndex + 1]) : DEFAULT_BUDGET;
  return {
    refresh: argv.includes('--refresh'),
    offline: argv.includes('--offline'),
    budget: Number.isFinite(budgetValue) && budgetValue > 1000 ? Math.floor(budgetValue) : DEFAULT_BUDGET,
  };
}

/** GET simples com node:https (o fetch do Node quebra sob o sandbox desta máquina). */
function httpsGet(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) {
      reject(new Error('excesso de redirecionamentos'));
      return;
    }
    https
      .get(url, { headers: { 'user-agent': 'AdShield/1.0 (+build local)' } }, (response) => {
        const status = response.statusCode ?? 0;
        if (status >= 300 && status < 400 && response.headers.location) {
          response.resume();
          resolve(httpsGet(new URL(response.headers.location, url).href, redirects + 1));
          return;
        }
        if (status !== 200) {
          response.resume();
          reject(new Error(`HTTP ${status}`));
          return;
        }
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        response.on('error', reject);
      })
      .on('error', reject);
  });
}

async function fileAgeMs(path) {
  try {
    const info = await stat(path);
    return Date.now() - info.mtimeMs;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

async function loadList(list, options) {
  await mkdir(CACHE, { recursive: true });
  const cachePath = join(CACHE, `${list.key}.txt`);
  const age = await fileAgeMs(cachePath);
  const fresh = age < 24 * 60 * 60 * 1000;

  if (options.offline) {
    if (age === Number.POSITIVE_INFINITY) throw new Error(`sem cache para ${list.key} (--offline)`);
    return { text: await readFile(cachePath, 'utf8'), source: 'cache' };
  }
  if (fresh && !options.refresh) {
    return { text: await readFile(cachePath, 'utf8'), source: 'cache' };
  }
  try {
    const text = await httpsGet(list.url);
    if (text.length < 1000) throw new Error(`resposta suspeita (${text.length} bytes)`);
    await writeFile(cachePath, text, 'utf8');
    return { text, source: 'download' };
  } catch (error) {
    if (age !== Number.POSITIVE_INFINITY) {
      console.warn(`[aviso] download de ${list.key} falhou (${error.message}); usando cache`);
      return { text: await readFile(cachePath, 'utf8'), source: 'cache' };
    }
    throw error;
  }
}

/** Chaves das regras que um `$badfilter` remove. */
function collectBadfilterKeys(text) {
  const keys = new Set();
  let count = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.includes('$badfilter')) continue;
    const stripped = line.replace(/,badfilter\b/g, '').replace(/\$badfilter,?/, '$').replace(/\$$/, '');
    const filter = parseNetworkFilter(stripped);
    if (!filter || filter.skip) continue;
    const rule = toDnrRule({ ...filter, options: { ...filter.options, badfilter: false } }, 1);
    if (validateDnrRule(rule).length) continue;
    keys.add(ruleKey(rule));
    count += 1;
  }
  return { keys, count };
}

function scoreRule(rule) {
  const pattern = rule.condition.urlFilter || '';
  let score = 0;
  if (pattern.startsWith('||')) score += 1000;
  if (pattern.endsWith('^')) score += 250;
  if (pattern.includes('*')) score -= 200;
  if (pattern.length > 80) score -= 150;
  if (rule.condition.domainType === 'thirdParty') score += 100;
  if (rule.condition.initiatorDomains) score += 150;
  if (pattern.length < 8) score += 50;
  return score;
}

function buildCosmeticCss(selectors) {
  const chunks = selectors.map((selector) => `${selector} { display: none !important; }`);
  return `/* Gerado por tools/build.mjs — ocultação genérica (EasyList/EasyPrivacy) */\n${chunks.join('\n')}\n`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  await mkdir(RULES, { recursive: true });

  const report = { generatedAt: new Date().toISOString(), lists: [], totals: {} };
  const allRules = [];
  const cosmetic = { generic: [], domains: new Map(), unhide: [], excluded: new Map() };
  const badfilterKeys = new Set();
  let badfilterCount = 0;
  const skipped = new Map();

  const bump = (reason, times) => skipped.set(reason, (skipped.get(reason) || 0) + times);

  for (const list of LISTS) {
    const { text, source } = await loadList(list, options);
    const badfilters = collectBadfilterKeys(text);
    for (const key of badfilters.keys) badfilterKeys.add(key);
    badfilterCount += badfilters.count;

    const compiled = compileText(text, { startId: allRules.length + 1, maxRules: 400000 });
    allRules.push(...compiled.rules);
    cosmetic.generic.push(...compiled.cosmetic.generic);
    for (const [domain, selectors] of compiled.cosmetic.domains) {
      if (!cosmetic.domains.has(domain)) cosmetic.domains.set(domain, new Set());
      for (const selector of selectors) cosmetic.domains.get(domain).add(selector);
    }
    cosmetic.unhide.push(...compiled.cosmetic.unhide);
    for (const [reason, times] of compiled.skipped) bump(reason, times);

    report.lists.push({
      ...list,
      source,
      bytes: Buffer.byteLength(text),
      networkRules: compiled.rules.length,
      sha256: createHash('sha256').update(text).digest('hex'),
      checkedAt: new Date().toISOString(),
    });
    console.log(`[lista] ${list.title}: ${compiled.rules.length} regras de rede (${source})`);
  }

  // Deduplica mantendo a primeira ocorrência e descarta alvos de $badfilter.
  const unique = new Map();
  for (const rule of allRules) {
    const key = ruleKey(rule);
    if (badfilterKeys.has(key)) continue;
    if (unique.has(key)) continue;
    unique.set(key, rule);
  }

  const candidates = [...unique.values()].map((rule, index) => ({ rule, index }));
  const exceptions = candidates.filter(({ rule }) => rule.action.type === 'allow');
  const blocks = candidates.filter(({ rule }) => rule.action.type !== 'allow');

  // Prioriza regras ancoradas em domínio e mantém a ordem original das listas
  // como desempate (as listas já vêm ordenadas por relevância).
  blocks.sort((a, b) => scoreRule(b.rule) - scoreRule(a.rule) || a.index - b.index);

  const youtubeBudget = YOUTUBE_RULES.length;
  const blockBudget = Math.max(0, options.budget - exceptions.length - youtubeBudget);
  const keptBlocks = blocks.slice(0, blockBudget);
  const droppedBlocks = blocks.length - keptBlocks.length;

  // Renumera: base tem ids próprios e youtube começa depois dele.
  const baseRules = [...exceptions.map((entry) => entry.rule), ...keptBlocks.map((entry) => entry.rule)].map(
    (rule, index) => {
      const { __raw, ...clean } = rule;
      return { ...clean, id: index + 1 };
    },
  );

  for (const rule of baseRules) {
    const problems = validateDnrRule(rule);
    if (problems.length) throw new Error(`regra inválida no build: ${problems[0]}`);
  }

  const youtubeRules = YOUTUBE_RULES.map((entry, index) => ({
    id: index + 1,
    priority: 2,
    action: { type: 'block' },
    condition: { urlFilter: entry.urlFilter, resourceTypes: entry.types },
  }));
  for (const rule of youtubeRules) {
    const problems = validateDnrRule(rule);
    if (problems.length) throw new Error(`regra do YouTube inválida: ${problems[0]}`);
  }

  const cosmeticJson = cosmeticToJson({
    generic: cosmetic.generic,
    domains: cosmetic.domains,
    unhide: cosmetic.unhide,
    excluded: cosmetic.excluded,
  });

  const genericSelectors = [...new Set(cosmeticJson.generic)].slice(0, GENERIC_COSMETIC_LIMIT);

  const chunks = [];
  for (let index = 0; index < baseRules.length; index += CHUNK_SIZE) {
    chunks.push(baseRules.slice(index, index + CHUNK_SIZE));
  }
  while (chunks.length < BASE_SLOTS) chunks.push([]);
  if (chunks.length > BASE_SLOTS) {
    throw new Error(
      `${baseRules.length} regras não cabem em ${BASE_SLOTS} arquivos de ${CHUNK_SIZE}; aumente BASE_SLOTS ou use --budget menor`,
    );
  }

  report.totals = {
    networkRulesKept: baseRules.length,
    networkExceptions: exceptions.length,
    networkBlocks: keptBlocks.length,
    networkDroppedForBudget: droppedBlocks,
    badfilters: badfilterCount,
    youtubeRules: youtubeRules.length,
    rulesetFiles: chunks.filter((chunk) => chunk.length).length,
    genericCosmeticSelectors: genericSelectors.length,
    domainCosmeticRules: Object.keys(cosmeticJson.domains).length,
    genericCosmeticTruncated: Math.max(0, cosmeticJson.generic.length - genericSelectors.length),
    skipped: Object.fromEntries([...skipped.entries()].sort((a, b) => b[1] - a[1])),
  };

  for (const [index, chunk] of chunks.entries()) {
    await writeFile(join(RULES, `base-${index + 1}.json`), JSON.stringify(chunk), 'utf8');
  }
  await writeFile(join(RULES, 'youtube.json'), JSON.stringify(youtubeRules), 'utf8');
  await writeFile(join(RULES, 'cosmetic-generic.css'), buildCosmeticCss(genericSelectors), 'utf8');
  await writeFile(
    join(RULES, 'cosmetic-domains.json'),
    JSON.stringify({ generatedAt: report.generatedAt, domains: cosmeticJson.domains, unhide: cosmeticJson.unhide }),
    'utf8',
  );
  await writeFile(join(RULES, 'report.json'), JSON.stringify(report, null, 2), 'utf8');

  console.log(`\n=== AdShield: build concluído ===`);
  console.log(`regras de rede   : ${baseRules.length} (${exceptions.length} exceções)`);
  console.log(`arquivos         : ${chunks.filter((chunk) => chunk.length).length} de ${BASE_SLOTS} partes`);
  console.log(`descartadas      : ${droppedBlocks} por orçamento de ${options.budget}`);
  console.log(`youtube          : ${youtubeRules.length}`);
  console.log(`cosmético genérico: ${genericSelectors.length} seletores`);
  console.log(`cosmético por domínio: ${Object.keys(cosmeticJson.domains).length} domínios`);

  const probes = [
    'doubleclick.net',
    'googlesyndication.com',
    'google-analytics.com',
    'adnxs.com',
    'amazon-adsystem.com',
    'googletagmanager.com',
    'facebook.net',
    'scorecardresearch.com',
  ];
  const present = probes
    .map((host) => {
      const hit = baseRules.some((rule) => (rule.condition.urlFilter || '').startsWith(`||${host}`));
      return `${host}:${hit ? 'ok' : 'faltando'}`;
    })
    .join('  ');
  console.log(`amostra          : ${present}`);

  if (droppedBlocks > 0) {
    console.log('  (o orçamento de regras estáticas do Chrome é o limite; veja rules/report.json)');
  }
}

main().catch((error) => {
  console.error(`[erro] ${error.message}`);
  process.exitCode = 1;
});

