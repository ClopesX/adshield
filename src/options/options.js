/**
 * AdShield — página de opções.
 * Toda a lógica de estado vive no service worker; aqui só há apresentação.
 */

const $ = (id) => document.getElementById(id);

async function send(type, payload = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...payload });
  if (!response) throw new Error('sem resposta do service worker');
  if (!response.ok) throw new Error(response.error || 'falha desconhecida');
  return response.result;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function row(...children) {
  const div = el('div', 'list-row');
  for (const child of children) div.append(child);
  return div;
}

/** Nome em cima, detalhe embaixo, em uma coluna que cresce. */
function labeled(name, meta) {
  const box = el('div', 'grow');
  box.append(name, meta);
  return box;
}

/* ------------------------------------------------------------------ */

async function renderStats() {
  const stats = await send('stats');
  const today = new Date();
  const key = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(
    today.getDate(),
  ).padStart(2, '0')}`;
  const todayEntry = stats.days?.[key];

  $('statTotal').textContent = String(stats.total || 0);
  $('statToday').textContent = String(todayEntry?.blocked || 0);
  $('statDays').textContent = String(Object.keys(stats.days || {}).length);

  const table = $('topDomains');
  table.textContent = '';
  const domains = Object.entries(todayEntry?.domains || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);
  if (!domains.length) return;
  const header = el('tr');
  header.append(el('td', 'small muted', 'domínios com bloqueios hoje'), el('td', 'small muted', ''));
  table.append(header);
  for (const [host, count] of domains) {
    const tr = el('tr');
    tr.append(el('td', 'truncate', host), el('td', '', String(count)));
    table.append(tr);
  }
}

function renderLists(report) {
  const container = $('lists');
  container.textContent = '';
  if (!report) {
    container.append(el('p', 'small muted', 'rules/report.json não encontrado — rode o build.'));
    return;
  }
  $('builtAt').textContent = `compilado em ${new Date(report.generatedAt).toLocaleString('pt-BR')}`;

  for (const list of report.lists || []) {
    const name = el('div', 'name', list.title);
    const meta = el(
      'div',
      'small muted truncate',
      `${list.networkRules.toLocaleString('pt-BR')} regras · ${(list.bytes / 1048576).toFixed(1)} MB · fonte: ${list.source === 'download' ? 'baixada' : 'cache'}`,
    );
    container.append(row(labeled(name, meta)));
  }

  const totals = report.totals || {};
  const lines = [
    `${(totals.networkRulesKept || 0).toLocaleString('pt-BR')} regras de rede ativas (${(
      totals.networkExceptions || 0
    ).toLocaleString('pt-BR')} exceções)`,
    `${(totals.genericCosmeticSelectors || 0).toLocaleString('pt-BR')} seletores cosméticos genéricos`,
    `${(totals.domainCosmeticRules || 0).toLocaleString('pt-BR')} domínios com ocultação específica`,
    `${(totals.networkDroppedForBudget || 0).toLocaleString('pt-BR')} regras fora do orçamento de 30 mil do Chrome`,
  ];
  $('compileStats').textContent = lines.join(' · ');
}

function renderSubs(subscriptions) {
  const list = $('subs');
  list.textContent = '';
  for (const sub of subscriptions) {
    const name = el('div', 'name truncate', sub.title || sub.url);
    const meta = el(
      'div',
      'small muted truncate',
      sub.error
        ? `erro: ${sub.error}`
        : `${sub.ruleCount || 0} regras · ${sub.lastUpdated ? new Date(sub.lastUpdated).toLocaleString('pt-BR') : 'nunca baixada'}`,
    );
    if (sub.error) meta.classList.add('badge-err');
    const remove = el('button', 'ghost small', 'remover');
    remove.addEventListener('click', async () => {
      remove.disabled = true;
      try {
        await send('removeSubscription', { url: sub.url });
        await load();
      } catch (error) {
        alert(`Erro ao remover: ${error.message}`);
      }
    });
    list.append(row(labeled(name, meta), remove));
  }
}

function renderAllowlist(allowlist) {
  const list = $('allowlist');
  list.textContent = '';
  for (const host of allowlist) {
    const remove = el('button', 'ghost small', 'remover');
    remove.addEventListener('click', async () => {
      remove.disabled = true;
      try {
        await send('toggleSite', { host });
        await load();
      } catch (error) {
        alert(`Erro: ${error.message}`);
      }
    });
    const cell = el('div', 'grow');
    cell.append(el('span', 'mono', host));
    list.append(row(cell, remove));
  }
}

/** Regras criadas com "Bloquear elemento", com o modo de cada uma. */
function renderCustomCosmetic(customCosmetic) {
  const list = $('customCosmeticList');
  list.textContent = '';
  const entries = Object.entries(customCosmetic || {});
  let total = 0;

  const MODES = [
    ['hide', 'Esconder (display: none)'],
    ['remove', 'Remover da página'],
  ];

  for (const [domain, rules] of entries.sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    for (const [selector, mode] of Object.entries(rules || {})) {
      total += 1;
      const name = el('div', 'name mono truncate', domain);
      name.title = domain;
      const code = el('div', 'small muted truncate', selector);
      code.title = selector;

      const select = document.createElement('select');
      select.className = 'mode-select';
      select.title =
        'Esconder: aplica display:none (o elemento continua na página). Remover: apaga o nó do DOM — use quando o elemento trava o scroll.';
      for (const [value, label] of MODES) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = label;
        select.append(option);
      }
      select.value = mode === 'remove' ? 'remove' : 'hide';
      select.addEventListener('change', async () => {
        select.disabled = true;
        try {
          await send('setCosmeticMode', { domain, selector, mode: select.value });
          await load();
        } catch (error) {
          alert(`Erro ao mudar o modo: ${error.message}`);
          select.disabled = false;
        }
      });

      const remove = el('button', 'ghost small', 'remover');
      remove.addEventListener('click', async () => {
        remove.disabled = true;
        try {
          await send('removeCustomCosmetic', { domain, selector });
          await load();
        } catch (error) {
          alert(`Erro ao remover: ${error.message}`);
          remove.disabled = false;
        }
      });
      list.append(row(labeled(name, code), select, remove));
    }
  }

  if (!total) {
    list.append(el('li', 'small muted', 'Nenhum elemento bloqueado por você.'));
  }
  $('clearCosmetic').disabled = total === 0;
}

/* ------------------------------------------------------------------ */

let currentInfo = null;

async function load() {
  const [info, state] = await Promise.all([send('info'), send('state', { tabId: -1 })]);
  currentInfo = { ...info, settings: state.settings, allowlist: info.allowlist || [] };

  await renderStats();
  renderLists(info.report);
  renderSubs(info.subscriptions || []);
  renderAllowlist(currentInfo.allowlist);
  renderCustomCosmetic(info.customCosmetic);

  $('customFilters').value = info.customFilters || '';
  $('optCosmetic').checked = Boolean(state.settings.cosmetic);
  $('optYoutube').checked = Boolean(state.settings.youtube);
}

/* ------------------------------------------------------------------ */

$('saveFilters').addEventListener('click', async () => {
  const button = $('saveFilters');
  button.disabled = true;
  $('customResult').textContent = 'aplicando…';
  try {
    const result = await send('setCustomFilters', { text: $('customFilters').value });
    const skipped = Object.entries(result.skipped || {})
      .filter(([, count]) => count > 0)
      .slice(0, 3)
      .map(([reason, count]) => `${reason} (${count})`)
      .join('; ');
    $('customResult').textContent =
      `${result.applied} regra(s) aplicada(s)` +
      (result.truncated ? ' — limite de 2.500 atingido' : '') +
      (skipped ? ` · ignoradas: ${skipped}` : '');
  } catch (error) {
    $('customResult').textContent = `Erro: ${error.message}`;
  } finally {
    button.disabled = false;
  }
});

$('addSub').addEventListener('click', async () => {
  const url = $('subUrl').value.trim();
  if (!url) return;
  const button = $('addSub');
  button.disabled = true;
  try {
    await send('addSubscription', { url });
    $('subUrl').value = '';
    await load();
  } catch (error) {
    alert(`Erro ao adicionar: ${error.message}`);
  } finally {
    button.disabled = false;
  }
});

$('addAllow').addEventListener('click', async () => {
  const host = $('allowInput').value.trim().toLowerCase().replace(/^https?:\/\//, '').split('/')[0];
  if (!host) return;
  try {
    await send('toggleSite', { host });
    $('allowInput').value = '';
    await load();
  } catch (error) {
    alert(`Erro: ${error.message}`);
  }
});

$('optCosmetic').addEventListener('change', async (event) => {
  await send('updateSettings', { patch: { cosmetic: event.target.checked } });
  await load();
});

$('optYoutube').addEventListener('change', async (event) => {
  await send('updateSettings', { patch: { youtube: event.target.checked } });
  await load();
});

$('clearCosmetic').addEventListener('click', async () => {
  const button = $('clearCosmetic');
  button.disabled = true;
  try {
    await send('clearCustomCosmetic', {});
    await load();
  } catch (error) {
    alert(`Erro: ${error.message}`);
    button.disabled = false;
  }
});

$('resetStats').addEventListener('click', async () => {
  if (!confirm('Zerar todos os contadores locais?')) return;
  await send('resetStats');
  await renderStats();
});

$('exportConfig').addEventListener('click', async () => {
  const info = await send('info');
  const state = await send('state', { tabId: -1 });
  const payload = {
    application: 'AdShield',
    exportedAt: new Date().toISOString(),
    settings: state.settings,
    allowlist: info.allowlist || [],
    customFilters: info.customFilters || '',
    customCosmetic: info.customCosmetic || {},
    subscriptions: (info.subscriptions || []).map(({ url, title, enabled }) => ({ url, title, enabled })),
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `adshield-config-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  URL.revokeObjectURL(link.href);
});

$('importConfig').addEventListener('click', () => $('importFile').click());

$('importFile').addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    const payload = JSON.parse(await file.text());
    if (payload.application !== 'AdShield') throw new Error('arquivo não é do AdShield');
    if (payload.settings) await send('updateSettings', { patch: payload.settings });
    if (Array.isArray(payload.allowlist)) {
      for (const host of payload.allowlist) {
        await send('toggleSite', { host }).catch(() => {});
      }
    }
    if (typeof payload.customFilters === 'string') {
      await send('setCustomFilters', { text: payload.customFilters });
    }
    if (payload.customCosmetic) {
      const current = (await send('info')).customCosmetic || {};
      await chrome.storage.local.set({ customCosmetic: { ...current, ...payload.customCosmetic } });
    }
    for (const sub of payload.subscriptions || []) {
      await send('addSubscription', { url: sub.url, title: sub.title }).catch(() => {});
    }
    await load();
    alert('Configuração importada.');
  } catch (error) {
    alert(`Falha ao importar: ${error.message}`);
  } finally {
    event.target.value = '';
  }
});

void load().catch((error) => {
  document.body.insertAdjacentHTML(
    'afterbegin',
    `<p class="card" style="margin:0 0 14px;border-color:#6b2b32">Erro ao carregar: ${String(error.message).replace(/</g, '&lt;')}</p>`,
  );
});
