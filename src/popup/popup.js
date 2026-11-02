/**
 * AdShield — popup.
 * Fala com o service worker por mensagens; não acessa nada diretamente.
 */

const els = {
  globalPill: document.getElementById('globalPill'),
  globalLabel: document.getElementById('globalLabel'),
  host: document.getElementById('host'),
  siteToggle: document.getElementById('siteToggle'),
  siteHint: document.getElementById('siteHint'),
  tabCount: document.getElementById('tabCount'),
  todayCount: document.getElementById('todayCount'),
  totalCount: document.getElementById('totalCount'),
  globalToggle: document.getElementById('globalToggle'),
  tabToggle: document.getElementById('tabToggle'),
  pickButton: document.getElementById('pickButton'),
  optionsButton: document.getElementById('optionsButton'),
  privacy: document.getElementById('privacy'),
  version: document.getElementById('version'),
};

let activeTab = null;
let state = null;

async function send(type, payload = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...payload });
  if (!response) throw new Error('sem resposta do service worker');
  if (!response.ok) throw new Error(response.error || 'falha desconhecida');
  return response.result;
}

function formatCount(value) {
  if (value === undefined || value === null) return '0';
  if (value >= 100000) return `${Math.round(value / 1000)}k`;
  return String(value);
}

function render() {
  if (!state) return;
  const { settings, host, siteAllowlisted, tabPaused, count, totalToday, totalAll } = state;

  els.host.textContent = host || 'Página interna';
  els.tabCount.textContent = formatCount(count);
  els.todayCount.textContent = formatCount(totalToday);
  els.totalCount.textContent = formatCount(totalAll);
  els.version.textContent = `v${state.version}`;

  const active = settings.enabled && !siteAllowlisted && !tabPaused;
  els.globalPill.className = `pill ${active ? 'good' : 'warn'}`;
  els.globalLabel.textContent = active ? 'Ativo' : settings.enabled ? 'Pausado' : 'Desligado';
  els.globalToggle.checked = settings.enabled;
  els.siteToggle.checked = !siteAllowlisted;
  els.tabToggle.checked = !tabPaused;
  els.siteToggle.disabled = !host;
  els.tabToggle.disabled = !host;

  if (!host) {
    els.siteHint.textContent = 'Funciona só em páginas http e https.';
  } else if (siteAllowlisted) {
    els.siteHint.textContent = 'Este site está na lista de exceções: nada é bloqueado aqui.';
  } else if (tabPaused) {
    els.siteHint.textContent = 'Aba pausada temporariamente (vale só enquanto ela estiver aberta).';
  } else {
    els.siteHint.textContent = '';
  }

  if (!state.counterAvailable) {
    els.privacy.textContent = '100% local · contador exige modo desenvolvedor';
  }
}

async function refresh() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTab = tab || null;
  state = await send('state', { tabId: activeTab?.id ?? -1 });
  render();
}

async function withBusy(button, action) {
  button.disabled = true;
  try {
    await action();
  } catch (error) {
    console.error(error);
    els.siteHint.textContent = `Erro: ${error.message}`;
  } finally {
    button.disabled = false;
  }
}

els.globalToggle.addEventListener('change', () =>
  withBusy(els.globalToggle, async () => {
    state = await send('toggleGlobal', { tabId: activeTab?.id ?? -1 });
    render();
  }),
);

els.siteToggle.addEventListener('change', () =>
  withBusy(els.siteToggle, async () => {
    state = await send('toggleSite', { tabId: activeTab?.id ?? -1, host: state?.host || '' });
    render();
  }),
);

els.tabToggle.addEventListener('change', () =>
  withBusy(els.tabToggle, async () => {
    state = await send('toggleTabPause', { tabId: activeTab?.id ?? -1 });
    render();
  }),
);

els.pickButton.addEventListener('click', async () => {
  if (!activeTab?.id) return;
  await withBusy(els.pickButton, async () => {
    try {
      await chrome.tabs.sendMessage(activeTab.id, { type: 'startPicker' });
    } catch {
      await chrome.scripting.executeScript({
        target: { tabId: activeTab.id },
        files: ['src/content/cosmetic.js'],
      });
      await chrome.tabs.sendMessage(activeTab.id, { type: 'startPicker' });
    }
    window.close();
  });
});

els.optionsButton.addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
  window.close();
});

void refresh().catch((error) => {
  els.siteHint.textContent = `Erro ao carregar: ${error.message}`;
});
