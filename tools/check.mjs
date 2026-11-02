#!/usr/bin/env node
/**
 * AdShield — verificação estática da extensão.
 *
 * Confere o manifest, os arquivos referenciados e cada regra declarativeNetRequest.
 * Roda rápido e falha com código 1 quando algo está inconsistente.
 */

import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateDnrRule } from '../src/common/abp.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const errors = [];
const notes = [];

async function exists(relative) {
  try {
    const info = await stat(join(ROOT, relative));
    return info.isFile();
  } catch {
    return false;
  }
}

async function mustExist(relative, label) {
  if (!(await exists(relative))) errors.push(`${label}: arquivo ausente "${relative}"`);
}

async function main() {
  const manifest = JSON.parse(await readFile(join(ROOT, 'manifest.json'), 'utf8'));

  if (manifest.manifest_version !== 3) errors.push('manifest_version precisa ser 3');
  if (!/^\d+\.\d+\.\d+$/.test(manifest.version || '')) errors.push('version fora do padrão x.y.z');
  if (!manifest.name) errors.push('name ausente');

  await mustExist(manifest.background?.service_worker, 'background');
  await mustExist(manifest.action?.default_popup, 'popup');
  await mustExist(manifest.options_ui?.page, 'options');

  for (const [size, path] of Object.entries(manifest.icons || {})) {
    await mustExist(path, `ícone ${size}`);
  }

  for (const script of manifest.content_scripts || []) {
    for (const file of script.js || []) await mustExist(file, 'content script');
    for (const file of script.css || []) await mustExist(file, 'css de content script');
  }

  // O bloqueio do YouTube é registrado em tempo de execução (mundo MAIN),
  // então não aparece no manifest — mas os arquivos precisam existir.
  for (const file of ['src/content/youtube-main.js', 'src/content/youtube.css']) {
    await mustExist(file, 'bloqueio do YouTube');
  }

  const rulesets = manifest.declarative_net_request?.rule_resources || [];
  if (!rulesets.length) errors.push('nenhum ruleset declarativeNetRequest declarado');

  let totalRules = 0;
  for (const ruleset of rulesets) {
    if (!(await exists(ruleset.path))) {
      errors.push(`ruleset "${ruleset.id}": arquivo ausente "${ruleset.path}"`);
      continue;
    }
    let rules;
    try {
      rules = JSON.parse(await readFile(join(ROOT, ruleset.path), 'utf8'));
    } catch (error) {
      errors.push(`ruleset "${ruleset.id}": JSON inválido (${error.message})`);
      continue;
    }
    if (!Array.isArray(rules)) {
      errors.push(`ruleset "${ruleset.id}": precisa ser um array`);
      continue;
    }
    const ids = new Set();
    for (const [index, rule] of rules.entries()) {
      const problems = validateDnrRule(rule);
      for (const problem of problems) {
        errors.push(`ruleset "${ruleset.id}" regra #${index} (id ${rule.id}): ${problem}`);
      }
      if (ids.has(rule.id)) errors.push(`ruleset "${ruleset.id}": id duplicado ${rule.id}`);
      ids.add(rule.id);
    }
    totalRules += rules.length;
    notes.push(`ruleset ${ruleset.id}: ${rules.length} regras`);
  }

  // Extensões carregadas sem empacotar recebem 330.000 regras estáticas; o
  // piso de 30.000 vale para pacotes publicados na loja.
  if (totalRules > 320000) {
    errors.push(`${totalRules} regras estáticas passam do limite de 330.000 do Chrome`);
  } else if (totalRules > 30000) {
    notes.push(`atenção: ${totalRules} regras só carregam em modo desenvolvedor (limite da loja: 30.000)`);
  }

  for (const file of ['rules/cosmetic-generic.css', 'rules/cosmetic-domains.json', 'rules/report.json']) {
    await mustExist(file, 'artefato do build');
  }
  try {
    const cosmetic = JSON.parse(await readFile(join(ROOT, 'rules/cosmetic-domains.json'), 'utf8'));
    notes.push(`cosmético: ${Object.keys(cosmetic.domains || {}).length} domínios`);
  } catch {
    errors.push('rules/cosmetic-domains.json inválido');
  }

  const cssPath = join(ROOT, 'rules/cosmetic-generic.css');
  if (await exists('rules/cosmetic-generic.css')) {
    const css = await readFile(cssPath, 'utf8');
    notes.push(`css genérico: ${(css.match(/display: none/g) || []).length} regras, ${(css.length / 1024).toFixed(0)} KB`);
    if (!css.includes('display: none !important')) errors.push('css genérico sem regras de ocultação');
  }

  const hash = createHash('sha256');
  for (const ruleset of rulesets) {
    if (await exists(ruleset.path)) hash.update(await readFile(join(ROOT, ruleset.path)));
  }
  notes.push(`total de regras: ${totalRules}`);
  notes.push(`sha256(listas): ${hash.digest('hex').slice(0, 16)}…`);

  console.log('AdShield — verificação');
  for (const note of notes) console.log(`  · ${note}`);
  if (errors.length) {
    console.error(`\n${errors.length} problema(s):`);
    for (const error of errors.slice(0, 30)) console.error(`  ✗ ${error}`);
    process.exitCode = 1;
  } else {
    console.log('\n  ✓ extensão consistente');
  }
}

await main();
