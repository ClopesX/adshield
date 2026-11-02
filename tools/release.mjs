#!/usr/bin/env node
/**
 * AdShield — publicar uma versão.
 *
 * Faz, em sequência, tudo o que uma atualização exige:
 *   1. sobe a versão no manifest.json e no package.json;
 *   2. roda os testes e a verificação de consistência;
 *   3. monta dist/adshield-<versão>.zip com a extensão pronta;
 *   4. commit + push no branch atual;
 *   5. cria a tag v<versão> e a release no GitHub com o zip anexado.
 *
 * Uso:
 *   node tools/release.mjs                 sobe o patch (1.2.0 -> 1.2.1)
 *   node tools/release.mjs minor           sobe o minor (1.2.0 -> 1.3.0)
 *   node tools/release.mjs none            mesma versão, só troca o zip da release
 *   node tools/release.mjs patch --dry-run mostra o que faria, sem enviar nada
 *   --notes "texto"                        notas da release (padrão: "AdShield <versão>")
 *   --message "texto"                      mensagem do commit (padrão: "release: v<versão>")
 *
 * Pré-requisitos: git e gh no PATH, com `gh auth login` já feito.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createZip } from './zip.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const EXCLUDE_DIRS = new Set(['.git', 'dist', 'data', 'node_modules', '_metadata', '.github']);
const EXCLUDE_FILES = new Set(['.gitignore', '.gitattributes']);

/**
 * Resolve git/gh mesmo quando o terminal foi aberto antes da instalação
 * (PATH velho), o que é comum no Windows logo depois do winget.
 */
function resolveTool(name, candidates) {
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return name;
}

const LOCAL = process.env.LOCALAPPDATA || '';
const GIT = resolveTool('git', [
  'C:\\Program Files\\Git\\cmd\\git.exe',
  join(LOCAL, 'Programs', 'Git', 'cmd', 'git.exe'),
  '/usr/bin/git',
]);
const GH = resolveTool('gh', [
  'C:\\Program Files\\GitHub CLI\\gh.exe',
  join(LOCAL, 'Programs', 'GitHub CLI', 'gh.exe'),
  '/usr/bin/gh',
]);

const args = process.argv.slice(2);
const bump = args.find((arg) => ['patch', 'minor', 'major', 'none'].includes(arg)) || 'patch';
const dryRun = args.includes('--dry-run');

function flag(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] || '' : '';
}

function run(command, commandArgs) {
  const result = spawnSync(command, commandArgs, { cwd: ROOT, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`falhou: ${command} ${commandArgs.join(' ')}`);
}

function output(command, commandArgs) {
  const result = spawnSync(command, commandArgs, { cwd: ROOT, encoding: 'utf8' });
  if (result.status !== 0) return '';
  return (result.stdout || '').trim();
}

function bumpVersion(version, type) {
  const [major, minor, patch] = version.split('.').map(Number);
  if (type === 'major') return `${major + 1}.0.0`;
  if (type === 'minor') return `${major}.${minor + 1}.0`;
  if (type === 'none') return version;
  return `${major}.${minor}.${patch + 1}`;
}

async function collectFiles(directory, list = []) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDE_DIRS.has(entry.name)) continue;
      await collectFiles(full, list);
      continue;
    }
    if (EXCLUDE_FILES.has(entry.name)) continue;
    list.push({ full, name: `adshield/${relative(ROOT, full).replace(/\\/g, '/')}` });
  }
  return list;
}

async function main() {
  if (!existsSync(join(ROOT, 'manifest.json'))) throw new Error('manifest.json não encontrado');
  if (!output(GIT, ['rev-parse', '--is-inside-work-tree'])) {
    throw new Error('esta pasta não é um repositório git');
  }
  if (!output(GH, ['--version'])) {
    throw new Error('GitHub CLI (gh) não encontrado. Instale com: winget install GitHub.cli');
  }

  const manifestPath = join(ROOT, 'manifest.json');
  const packagePath = join(ROOT, 'package.json');
  const manifestRaw = await readFile(manifestPath, 'utf8');
  const currentVersion = JSON.parse(manifestRaw).version;
  const nextVersion = bumpVersion(currentVersion, bump);
  const tag = `v${nextVersion}`;

  console.log(`\nversão: ${currentVersion} → ${nextVersion}${dryRun ? '   (dry-run)' : ''}\n`);

  if (nextVersion !== currentVersion && !dryRun) {
    await writeFile(
      manifestPath,
      manifestRaw.replace(`"version": "${currentVersion}"`, `"version": "${nextVersion}"`),
      'utf8',
    );
    const packageRaw = await readFile(packagePath, 'utf8');
    await writeFile(packagePath, packageRaw.replace(/"version":\s*"[^"]+"/, `"version": "${nextVersion}"`), 'utf8');
  }

  console.log('[1/5] testes do compilador');
  run(process.execPath, [join(ROOT, 'tests', 'abp.test.mjs')]);
  console.log('[2/5] manifest, arquivos e regras');
  run(process.execPath, [join(ROOT, 'tools', 'check.mjs')]);

  console.log('[3/5] montando o pacote');
  await mkdir(DIST, { recursive: true });
  const files = await collectFiles(ROOT);
  const entries = [];
  for (const file of files) entries.push({ name: file.name, data: await readFile(file.full) });
  const zipPath = join(DIST, `adshield-${nextVersion}.zip`);
  await writeFile(zipPath, createZip(entries));
  const sizeMb = ((await stat(zipPath)).size / 1048576).toFixed(2);
  console.log(`      ${files.length} arquivos, ${sizeMb} MB → dist/adshield-${nextVersion}.zip`);

  if (dryRun) {
    console.log('\n[dry-run] nada foi commitado nem enviado.');
    return;
  }

  console.log('[4/5] commit e push');
  const branch = output(GIT, ['rev-parse', '--abbrev-ref', 'HEAD']) || 'main';
  run(GIT, ['add', '-A']);
  if (output(GIT, ['status', '--porcelain']).length > 0) {
    run(GIT, ['commit', '-m', flag('--message') || `release: v${nextVersion}`]);
  } else {
    console.log('      nada novo para commitar');
  }
  run(GIT, ['push', 'origin', branch]);

  console.log('[5/5] tag e release no GitHub');
  if (!output(GIT, ['tag', '-l', tag])) {
    run(GIT, ['tag', '-a', tag, '-m', `AdShield ${nextVersion}`]);
    run(GIT, ['push', 'origin', tag]);
  }

  if (output(GH, ['release', 'view', tag, '--json', 'tagName'])) {
    run(GH, ['release', 'upload', tag, zipPath, '--clobber']);
    console.log(`      pacote trocado na release ${tag}`);
  } else {
    run(GH, ['release', 'create', tag, zipPath, '--title', `AdShield ${nextVersion}`, '--notes', flag('--notes') || `AdShield ${nextVersion}`]);
  }

  const url = output(GH, ['release', 'view', tag, '--json', 'url', '--jq', '.url']);
  const repo = output(GH, ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']);
  console.log(`\n✓ publicado: ${url || `https://github.com/${repo}/releases/tag/${tag}`}`);
}

main().catch((error) => {
  console.error(`\n[erro] ${error.message}`);
  process.exitCode = 1;
});
