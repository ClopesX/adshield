/**
 * AdShield — analisador de filtros no formato ABP (Adblock Plus / EasyList).
 *
 * Módulo único usado por:
 *  - tools/build.mjs  (compila EasyList/EasyPrivacy em regras declarativeNetRequest)
 *  - service worker   (compila filtros personalizados e assinaturas em tempo de execução)
 *
 * Nada aqui faz rede, avalia código ou conhece a extensão alvo. É só texto -> objeto.
 */

export const DNR_RESOURCE_TYPES = [
  'main_frame',
  'sub_frame',
  'stylesheet',
  'script',
  'image',
  'font',
  'object',
  'xmlhttprequest',
  'ping',
  'csp_report',
  'media',
  'websocket',
  'webtransport',
  'webbundle',
  'other',
];

/** Todos os tipos menos main_frame: semântica de filtro ABP sem opção de tipo. */
export const NON_DOCUMENT_TYPES = DNR_RESOURCE_TYPES.filter((t) => t !== 'main_frame');

const TYPE_ALIASES = {
  script: 'script',
  image: 'image',
  stylesheet: 'stylesheet',
  css: 'stylesheet',
  object: 'object',
  'object-subrequest': 'object',
  xmlhttprequest: 'xmlhttprequest',
  xhr: 'xmlhttprequest',
  subdocument: 'sub_frame',
  frame: 'sub_frame',
  document: 'main_frame',
  doc: 'main_frame',
  media: 'media',
  font: 'font',
  websocket: 'websocket',
  webtransport: 'webtransport',
  webbundle: 'webbundle',
  ping: 'ping',
  beacon: 'ping',
  other: 'other',
  'csp-report': 'csp_report',
};

/** Opções conhecidas que não têm equivalente em declarativeNetRequest. */
const UNSUPPORTED_OPTIONS = new Set([
  'redirect',
  'redirect-rule',
  'rewrite',
  'csp',
  'removeparam',
  'removeheader',
  'replace',
  'empty',
  'mp4',
  'inline-script',
  'inline-font',
  'webrtc',
  'elemhide',
  'ehide',
  'specifichide',
  'shide',
  'genericblock',
  'generichide',
  'popup',
  'popunder',
  'content',
  'permissions',
  'urltransform',
  'method',
  'to',
  'from',
  'denyallow',
  'header',
  'strict1p',
  'strict3p',
]);

const SELECTOR_OPERATORS = ['##', '#@#', '#?#', '#@?#', '#$#', '#@$#', '#%#'];

function isAscii(value) {
  for (let i = 0; i < value.length; i++) {
    if (value.charCodeAt(i) > 127) return false;
  }
  return true;
}

function isValidDomain(value) {
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i.test(value);
}

/**
 * Separa o padrão das opções no último "$" cujo sufixo parece uma lista de opções.
 * Um "$" literal em filtros é raro e sempre vem escapado em listas reais.
 */
function splitOptions(body) {
  const match = /^(.*?)\$((?:~?[a-z][a-z0-9-]*(?:=[^,$]*)?)(?:,(?:~?[a-z][a-z0-9-]*(?:=[^,$]*)?))*)$/i.exec(
    body,
  );
  if (!match) return { pattern: body, options: '' };
  return { pattern: match[1], options: match[2] };
}

export function parseOptions(rawOptions) {
  const options = {
    resourceTypes: null,
    excludedResourceTypes: null,
    domainType: null,
    initiatorDomains: null,
    excludedInitiatorDomains: null,
    important: false,
    matchCase: false,
    badfilter: false,
    exceptionTypes: false,
    unsupported: null,
  };

  const include = new Set();
  const exclude = new Set();
  const includeDomains = [];
  const excludeDomains = [];

  for (const raw of rawOptions.split(',')) {
    const token = raw.trim();
    if (!token) continue;
    const negated = token.startsWith('~');
    const name = (negated ? token.slice(1) : token).toLowerCase();
    const eq = name.indexOf('=');
    const key = eq === -1 ? name : name.slice(0, eq);
    const value = eq === -1 ? '' : name.slice(eq + 1);

    if (key === 'third-party') {
      options.domainType = negated ? 'firstParty' : 'thirdParty';
      continue;
    }
    if (key === 'first-party') {
      options.domainType = negated ? 'thirdParty' : 'firstParty';
      continue;
    }
    if (key === 'important') {
      options.important = !negated;
      continue;
    }
    if (key === 'match-case') {
      options.matchCase = !negated;
      continue;
    }
    if (key === 'badfilter') {
      options.badfilter = true;
      continue;
    }
    if (key === 'domain' || key === 'from') {
      for (const entry of value.split('|')) {
        const item = entry.trim();
        if (!item) continue;
        const isNeg = item.startsWith('~');
        const domain = (isNeg ? item.slice(1) : item).toLowerCase();
        if (!isValidDomain(domain)) {
          options.unsupported = `domain inválido: ${domain}`;
          return options;
        }
        if (isNeg) excludeDomains.push(domain);
        else includeDomains.push(domain);
      }
      continue;
    }
    if (key === 'all') {
      options.resourceTypes = [...DNR_RESOURCE_TYPES];
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(TYPE_ALIASES, key)) {
      if (negated) exclude.add(TYPE_ALIASES[key]);
      else include.add(TYPE_ALIASES[key]);
      continue;
    }
    if (UNSUPPORTED_OPTIONS.has(key)) {
      options.unsupported = key;
      return options;
    }
    options.unsupported = key;
    return options;
  }

  if (include.size) options.resourceTypes = [...include];
  if (exclude.size) options.excludedResourceTypes = [...exclude];
  if (includeDomains.length) options.initiatorDomains = includeDomains;
  if (excludeDomains.length) options.excludedInitiatorDomains = excludeDomains;

  // Filtro sem opção de tipo: vale para tudo menos o documento principal.
  if (!options.resourceTypes && !options.excludedResourceTypes) {
    options.resourceTypes = [...NON_DOCUMENT_TYPES];
  }
  // "$document" sozinho já vale só para main_frame; quando combinado com
  // excluídos explícitos deixamos o DNR resolver.
  if (options.resourceTypes && options.excludedResourceTypes) {
    options.resourceTypes = options.resourceTypes.filter(
      (t) => !options.excludedResourceTypes.includes(t),
    );
    if (!options.resourceTypes.length) options.resourceTypes = ['other'];
    options.excludedResourceTypes = null;
  }

  return options;
}

/**
 * Analisa uma linha de filtro de rede.
 * Devolve null quando a linha não é um filtro de rede utilizável.
 */
export function parseNetworkFilter(line) {
  let text = line.trim();
  if (!text || text.startsWith('!') || text.startsWith('[') || text.startsWith('#')) return null;

  const exception = text.startsWith('@@');
  if (exception) text = text.slice(2).trim();
  if (!text) return null;

  const { pattern, options: rawOptions } = splitOptions(text);
  const parsedPattern = pattern.trim();
  if (!parsedPattern) return null;

  const options = parseOptions(rawOptions);
  if (options.unsupported) return { skip: `opção não suportada: ${options.unsupported}` };

  // Regex no estilo /.../ — declarativeNetRequest aceita, mas o custo e o teto
  // de 1000 regras regex tornam o ganho pequeno; ficam de fora nesta versão.
  if (parsedPattern.length > 2 && parsedPattern.startsWith('/') && parsedPattern.endsWith('/')) {
    return { skip: 'filtro regex' };
  }

  if (!isAscii(parsedPattern)) return { skip: 'padrão não-ASCII' };
  if (parsedPattern.length > 2000) return { skip: 'padrão longo demais' };
  if (!/^(?:\|\|?|\*)?[^|]*$/.test(parsedPattern.replace(/\|$/, ''))) return { skip: 'âncora inválida' };
  if (parsedPattern === '*' || parsedPattern === '|' || parsedPattern === '||') {
    return { skip: 'padrão universal' };
  }

  return {
    kind: 'network',
    exception,
    pattern: parsedPattern,
    options,
    raw: line.trim(),
  };
}

/** Analisa uma linha cosmética (ocultação de elementos). */
export function parseCosmeticFilter(line) {
  const text = line.trim();
  if (!text || text.startsWith('!') || text.startsWith('[')) return null;

  const operator = SELECTOR_OPERATORS.find((op) => text.includes(op));
  if (!operator) return null;

  const index = text.indexOf(operator);
  const domainPart = text.slice(0, index).trim();
  const body = text.slice(index + operator.length).trim();
  if (!body) return { skip: 'seletor vazio' };

  // Regras procedurais, de estilo e de scriptlet exigem execução de código na
  // página; não são compiladas para CSS.
  if (operator !== '##' && operator !== '#@#') {
    return { skip: `operador não suportado: ${operator}` };
  }
  if (body.startsWith('+js(') || body.startsWith('^')) return { skip: 'scriptlet' };
  if (body.startsWith('{') || body.includes('remove-attr') || body.includes('remove-class')) {
    return { skip: 'regra de ação' };
  }

  const include = [];
  const exclude = [];
  if (domainPart) {
    for (const entry of domainPart.split(',')) {
      const item = entry.trim().toLowerCase();
      if (!item) continue;
      const negated = item.startsWith('~');
      const domain = negated ? item.slice(1) : item;
      if (!isValidDomain(domain)) return { skip: `domínio inválido: ${domain}` };
      if (negated) exclude.push(domain);
      else include.push(domain);
    }
  }

  return {
    kind: 'cosmetic',
    unhide: operator === '#@#',
    domains: include,
    excludedDomains: exclude,
    selector: body,
    raw: line.trim(),
  };
}

/**
 * Converte um filtro de rede analisado em uma regra declarativeNetRequest.
 * `id` precisa ser único e >= 1.
 */
export function toDnrRule(filter, id) {
  const { options, exception, pattern } = filter;
  const condition = { urlFilter: pattern };
  if (options.matchCase) condition.isUrlFilterCaseSensitive = true;
  if (options.resourceTypes) condition.resourceTypes = [...options.resourceTypes];
  if (options.excludedResourceTypes) {
    condition.excludedResourceTypes = [...options.excludedResourceTypes];
  }
  if (options.domainType) condition.domainType = options.domainType;
  if (options.initiatorDomains) condition.initiatorDomains = [...options.initiatorDomains];
  if (options.excludedInitiatorDomains) {
    condition.excludedInitiatorDomains = [...options.excludedInitiatorDomains];
  }

  let priority = exception ? 200 : 1;
  if (options.important) priority = exception ? 400 : 300;

  return {
    id,
    priority,
    action: { type: exception ? 'allow' : 'block' },
    condition,
  };
}

export function ruleKey(rule) {
  const c = rule.condition;
  return JSON.stringify([
    rule.action.type,
    c.urlFilter || '',
    (c.resourceTypes || []).join(','),
    (c.excludedResourceTypes || []).join(','),
    c.domainType || '',
    (c.initiatorDomains || []).join(','),
    (c.excludedInitiatorDomains || []).join(','),
    Boolean(c.isUrlFilterCaseSensitive),
  ]);
}

/**
 * Valida uma regra contra as restrições documentadas do declarativeNetRequest.
 * Usado pelo build (falha cedo) e pelo service worker (filtros do usuário).
 */
export function validateDnrRule(rule) {
  const problems = [];
  if (!Number.isInteger(rule.id) || rule.id < 1) problems.push('id inválido');
  if (!Number.isInteger(rule.priority) || rule.priority < 1) problems.push('priority inválida');
  if (!rule.action || !['block', 'allow', 'redirect', 'upgradeScheme', 'modifyHeaders'].includes(rule.action.type)) {
    problems.push('action inválida');
  }
  const c = rule.condition || {};
  const hasFilter = Boolean(c.urlFilter || c.regexFilter);
  if (!hasFilter) problems.push('condição sem urlFilter/regexFilter');
  if (c.urlFilter !== undefined) {
    if (typeof c.urlFilter !== 'string' || !c.urlFilter.length) problems.push('urlFilter vazio');
    if (c.urlFilter && c.urlFilter.length > 2000) problems.push('urlFilter > 2000');
    if (c.urlFilter && !isAscii(c.urlFilter)) problems.push('urlFilter não-ASCII');
  }
  for (const key of ['resourceTypes', 'excludedResourceTypes']) {
    if (c[key] === undefined) continue;
    if (!Array.isArray(c[key]) || !c[key].length) problems.push(`${key} vazio`);
    for (const type of c[key] || []) {
      if (!DNR_RESOURCE_TYPES.includes(type)) problems.push(`tipo inválido: ${type}`);
    }
  }
  if (c.resourceTypes && c.excludedResourceTypes) problems.push('tipos incluídos e excluídos juntos');
  for (const key of ['initiatorDomains', 'excludedInitiatorDomains', 'requestDomains', 'excludedRequestDomains']) {
    if (c[key] === undefined) continue;
    if (!Array.isArray(c[key]) || !c[key].length) problems.push(`${key} vazio`);
    for (const domain of c[key] || []) {
      if (!isValidDomain(domain)) problems.push(`${key} inválido: ${domain}`);
    }
  }
  if (c.domainType && !['firstParty', 'thirdParty'].includes(c.domainType)) {
    problems.push(`domainType inválido: ${c.domainType}`);
  }
  return problems;
}

/** Chave estável para aplicar `$badfilter` (remove a regra equivalente). */
export function badfilterTarget(rule) {
  return ruleKey(rule);
}

/**
 * Compila um bloco de texto ABP (lista ou filtros do usuário) para regras DNR.
 * Devolve regras numeradas a partir de `startId` e um relatório do que foi ignorado.
 */
export function compileText(text, { startId = 1, maxRules = 30000 } = {}) {
  const rules = [];
  const cosmetic = { generic: [], domains: new Map(), unhide: [], excluded: new Map() };
  const skipped = new Map();
  let nextId = startId;
  const seen = new Set();

  const skip = (reason) => skipped.set(reason, (skipped.get(reason) || 0) + 1);

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const cosmeticFilter = parseCosmeticFilter(line);
    if (cosmeticFilter) {
      if (cosmeticFilter.skip) {
        skip(cosmeticFilter.skip);
        continue;
      }
      if (cosmeticFilter.unhide) {
        cosmetic.unhide.push(cosmeticFilter);
        continue;
      }
      if (!cosmeticFilter.domains.length) {
        cosmetic.generic.push(cosmeticFilter.selector);
        continue;
      }
      for (const domain of cosmeticFilter.domains) {
        if (!cosmetic.domains.has(domain)) cosmetic.domains.set(domain, new Set());
        cosmetic.domains.get(domain).add(cosmeticFilter.selector);
      }
      for (const domain of cosmeticFilter.excludedDomains) {
        if (!cosmetic.excluded.has(domain)) cosmetic.excluded.set(domain, new Set());
        for (const d of cosmeticFilter.domains) cosmetic.excluded.get(domain).add(d);
      }
      continue;
    }

    const filter = parseNetworkFilter(line);
    if (!filter) {
      if (line.startsWith('!') || line.startsWith('[')) continue;
      skip('linha não reconhecida');
      continue;
    }
    if (filter.skip) {
      skip(filter.skip);
      continue;
    }

    const rule = toDnrRule(filter, nextId);
    const problems = validateDnrRule(rule);
    if (problems.length) {
      skip(`regra inválida: ${problems[0]}`);
      continue;
    }
    if (filter.options.badfilter) {
      skip('badfilter (tratado no build)');
      continue;
    }
    const key = ruleKey(rule);
    if (seen.has(key)) {
      skip('duplicada');
      continue;
    }
    seen.add(key);
    rule.__raw = filter.raw;
    rules.push(rule);
    nextId += 1;
    if (rules.length >= maxRules) {
      skip('limite de regras atingido');
      break;
    }
  }

  return { rules, cosmetic, skipped, nextId };
}

/** Converte o acumulador cosmético em estruturas serializáveis. */
export function cosmeticToJson(cosmetic) {
  const domains = {};
  for (const [domain, selectors] of [...cosmetic.domains.entries()].sort((a, b) =>
    a[0] < b[0] ? -1 : 1,
  )) {
    const hidden = [...selectors];
    if (!hidden.length) continue;
    domains[domain] = hidden.join(', ');
  }
  const unhide = {};
  for (const rule of cosmetic.unhide) {
    for (const domain of rule.domains) {
      if (!unhide[domain]) unhide[domain] = [];
      unhide[domain].push(rule.selector);
    }
  }
  return {
    generic: [...new Set(cosmetic.generic)].sort(),
    domains,
    unhide,
  };
}
