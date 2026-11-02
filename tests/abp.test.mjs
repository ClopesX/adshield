/**
 * Testes do compilador ABP -> declarativeNetRequest.
 * Rodam sem navegador: `npm test`.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  compileText,
  cosmeticToJson,
  parseCosmeticFilter,
  parseNetworkFilter,
  ruleKey,
  toDnrRule,
  validateDnrRule,
} from '../src/common/abp.js';

test('bloqueio de domínio simples', () => {
  const filter = parseNetworkFilter('||doubleclick.net^');
  assert.equal(filter.exception, false);
  const rule = toDnrRule(filter, 1);
  assert.equal(rule.action.type, 'block');
  assert.equal(rule.condition.urlFilter, '||doubleclick.net^');
  assert.ok(rule.condition.resourceTypes.includes('script'));
  assert.ok(!rule.condition.resourceTypes.includes('main_frame'));
  assert.deepEqual(validateDnrRule(rule), []);
});

test('exceção ganha prioridade maior que bloqueio', () => {
  const block = toDnrRule(parseNetworkFilter('||ads.exemplo.com^'), 1);
  const allow = toDnrRule(parseNetworkFilter('@@||ads.exemplo.com^$script'), 2);
  assert.equal(allow.action.type, 'allow');
  assert.ok(allow.priority > block.priority);
});

test('$important sobe a prioridade no bloqueio e na exceção', () => {
  const block = toDnrRule(parseNetworkFilter('||ads.exemplo.com^$important'), 1);
  const allow = toDnrRule(parseNetworkFilter('@@||ads.exemplo.com^$important'), 2);
  assert.equal(block.priority, 300);
  assert.equal(allow.priority, 400);
});

test('terceira parte vira domainType', () => {
  const filter = parseNetworkFilter('||tracker.com^$third-party');
  const rule = toDnrRule(filter, 1);
  assert.equal(rule.condition.domainType, 'thirdParty');
});

test('$domain vira initiatorDomains e exclusões', () => {
  const filter = parseNetworkFilter('||ads.com^$domain=site.com|~jogo.site.com');
  const rule = toDnrRule(filter, 1);
  assert.deepEqual(rule.condition.initiatorDomains, ['site.com']);
  assert.deepEqual(rule.condition.excludedInitiatorDomains, ['jogo.site.com']);
});

test('tipos de recurso são mapeados para os nomes do Chrome', () => {
  const filter = parseNetworkFilter('||ads.com^$script,image,xhr');
  const rule = toDnrRule(filter, 1);
  assert.deepEqual(rule.condition.resourceTypes.sort(), ['image', 'script', 'xmlhttprequest']);
});

test('tipos excluídos viram excludedResourceTypes', () => {
  const filter = parseNetworkFilter('||ads.com^$~script,~image');
  const rule = toDnrRule(filter, 1);
  assert.ok(rule.condition.excludedResourceTypes.includes('script'));
  assert.ok(!rule.condition.resourceTypes);
});

test('documento principal só entra com $document', () => {
  const plain = toDnrRule(parseNetworkFilter('||ads.com^'), 1);
  assert.ok(!plain.condition.resourceTypes.includes('main_frame'));
  const doc = toDnrRule(parseNetworkFilter('||ads.com^$document'), 2);
  assert.deepEqual(doc.condition.resourceTypes, ['main_frame']);
});

test('opções sem equivalente são ignoradas com motivo', () => {
  for (const line of ['||ads.com^$removeparam=utm', '||ads.com^$redirect=noop.js', '||ads.com^$csp=script-src']) {
    const filter = parseNetworkFilter(line);
    assert.ok(filter.skip, `deveria pular: ${line}`);
  }
});

test('regex e padrão não-ASCII são recusados', () => {
  assert.ok(parseNetworkFilter('/ad[0-9]+banner/').skip);
  assert.ok(parseNetworkFilter('||anúncio.com^').skip);
});

test('padrão universal é recusado', () => {
  assert.ok(parseNetworkFilter('*').skip);
});

test('cosmético genérico e por domínio', () => {
  const generic = parseCosmeticFilter('##.ad-banner');
  assert.deepEqual(generic.domains, []);
  assert.equal(generic.selector, '.ad-banner');

  const scoped = parseCosmeticFilter('site.com,outro.com##div.ads');
  assert.deepEqual(scoped.domains, ['site.com', 'outro.com']);

  const excluded = parseCosmeticFilter('site.com##.ad');
  assert.deepEqual(excluded.excludedDomains, []);
});

test('scriptlet e regra de ação não viram CSS', () => {
  assert.ok(parseCosmeticFilter('##+js(set-constant, x, 1)').skip);
  assert.ok(parseCosmeticFilter('site.com#$#body { color: red }').skip);
});

test('exceção cosmética é separada', () => {
  const filter = parseCosmeticFilter('site.com#@#.ad');
  assert.equal(filter.unhide, true);
});

test('compileText junta rede e cosmético e ignora comentários', () => {
  const text = [
    '[Adblock Plus 2.0]',
    '! comentário',
    '||ads.com^',
    '##.ad',
    'site.com##.promo',
    '||ads.com^',
  ].join('\n');
  const result = compileText(text);
  assert.equal(result.rules.length, 1, 'duplicata removida');
  assert.deepEqual(result.cosmetic.generic, ['.ad']);
  assert.ok(result.cosmetic.domains.get('site.com').has('.promo'));
  assert.equal(result.skipped.get('duplicada'), 1);
});

test('ids são sequenciais e únicos', () => {
  const result = compileText('||a.com^\n||b.com^\n||c.com^', { startId: 10 });
  assert.deepEqual(
    result.rules.map((rule) => rule.id),
    [10, 11, 12],
  );
});

test('limite de regras interrompe a compilação', () => {
  const text = Array.from({ length: 20 }, (_, i) => `||site${i}.com^`).join('\n');
  const result = compileText(text, { maxRules: 5 });
  assert.equal(result.rules.length, 5);
  assert.ok(result.skipped.get('limite de regras atingido'));
});

test('chave de regra distingue tipos e domínios', () => {
  const a = toDnrRule(parseNetworkFilter('||ads.com^'), 1);
  const b = toDnrRule(parseNetworkFilter('||ads.com^$script'), 2);
  const c = toDnrRule(parseNetworkFilter('||ads.com^$domain=site.com'), 3);
  assert.notEqual(ruleKey(a), ruleKey(b));
  assert.notEqual(ruleKey(a), ruleKey(c));
  assert.equal(ruleKey(a), ruleKey(toDnrRule(parseNetworkFilter('||ads.com^'), 9)));
});

test('cosmeticToJson serializa domínios sem vazios', () => {
  const compiled = compileText('site.com##.a\nsite.com##.b\n##.gen');
  const json = cosmeticToJson(compiled.cosmetic);
  assert.deepEqual(json.generic, ['.gen']);
  assert.equal(json.domains['site.com'], '.a, .b');
});

test('validateDnrRule detecta problemas', () => {
  assert.ok(validateDnrRule({ id: 0, priority: 1, action: { type: 'block' }, condition: { urlFilter: 'x' } }).length);
  assert.ok(validateDnrRule({ id: 1, priority: 0, action: { type: 'block' }, condition: { urlFilter: 'x' } }).length);
  assert.ok(validateDnrRule({ id: 1, priority: 1, action: { type: 'block' }, condition: {} }).length);
  assert.ok(
    validateDnrRule({
      id: 1,
      priority: 1,
      action: { type: 'block' },
      condition: { urlFilter: 'x', resourceTypes: ['nao-existe'] },
    }).length,
  );
});
