/**
 * AdShield — script de conteúdo.
 *
 * 1. Injeta a ocultação de elementos por domínio (regras cosméticas do EasyList).
 * 2. Implementa o seletor de elemento ("Bloquear este elemento").
 *
 * Roda em todos os frames, em document_start, e não faz rede.
 */

(() => {
  const STYLE_ID = 'adshield-cosmetic';
  const BANNER_ID = 'adshield-picker-banner';
  const OVERLAY_ID = 'adshield-picker-overlay';

  if (window.__adshieldLoaded) return;
  window.__adshieldLoaded = true;

  /* ------------------------------------------------------------------ */
  /* Ocultação de elementos                                              */
  /* ------------------------------------------------------------------ */

  /** Seletores que escondemos com CSS (display:none). */
  const hideRules = new Set();
  /** Seletores que tiramos do DOM (o elemento deixa de existir). */
  const removeRules = new Set();
  let removeObserver = null;
  let removeTimer = null;

  function renderStyle() {
    let style = document.getElementById(STYLE_ID);
    if (!hideRules.size) {
      if (style) style.textContent = '';
      return;
    }
    if (!style) {
      style = document.createElement('style');
      style.id = STYLE_ID;
      (document.head || document.documentElement).appendChild(style);
    }
    style.textContent = [...hideRules]
      .map((selector) => `${selector} { display: none !important; }`)
      .join('\n');
  }

  /**
   * Quando o elemento removido cobre a tela inteira (overlay/modal), o site
   * costuma travar o scroll com `overflow: hidden` no html/body. Tirar o nó do
   * DOM não desfaz isso, então liberamos o scroll junto.
   */
  function releaseScrollLock(node) {
    try {
      const rect = node.getBoundingClientRect();
      const style = window.getComputedStyle(node);
      const coversViewport =
        rect.width >= window.innerWidth * 0.8 && rect.height >= window.innerHeight * 0.8;
      if (!coversViewport) return;
      if (style.position !== 'fixed' && style.position !== 'absolute') return;

      for (const target of [document.documentElement, document.body]) {
        if (!target) continue;
        const overflow = target.style.overflow;
        if (overflow && overflow !== 'visible') target.style.removeProperty('overflow');
        if (overflow === 'hidden') {
          target.style.removeProperty('padding-right');
        }
      }
    } catch {
      /* página em transição: ignora */
    }
  }

  /** Remove do DOM tudo que casar com as regras de modo "remove". */
  function applyRemovals() {
    if (!removeRules.size || !document.documentElement) return 0;
    let removed = 0;
    for (const selector of removeRules) {
      let nodes;
      try {
        nodes = document.querySelectorAll(selector);
      } catch {
        continue;
      }
      for (const node of nodes) {
        releaseScrollLock(node);
        node.remove();
        removed += 1;
      }
    }
    return removed;
  }

  function scheduleRemovals() {
    if (removeTimer || !removeRules.size) return;
    removeTimer = setTimeout(() => {
      removeTimer = null;
      applyRemovals();
    }, 120);
  }

  /**
   * O elemento pode reaparecer (YouTube recria overlays o tempo todo), então
   * além da remoção imediata observamos o DOM.
   */
  function startRemovalWatcher() {
    if (removeObserver || !removeRules.size) return;
    applyRemovals();
    removeObserver = new MutationObserver(scheduleRemovals);
    removeObserver.observe(document.documentElement, { childList: true, subtree: true });
    // Rede de segurança para re-renderizações que não disparam childList.
    setInterval(() => {
      if (removeRules.size) applyRemovals();
    }, 2000);
  }

  function stopRemovalWatcher() {
    if (!removeObserver) return;
    removeObserver.disconnect();
    removeObserver = null;
  }

  function syncRemovalWatcher() {
    if (removeRules.size) startRemovalWatcher();
    else stopRemovalWatcher();
  }

  function addHideRules(selectors) {
    for (const selector of selectors) if (selector) hideRules.add(selector);
    renderStyle();
  }

  function addRemoveRules(selectors) {
    for (const selector of selectors) if (selector) removeRules.add(selector);
    syncRemovalWatcher();
    applyRemovals();
  }

  function removeRule(selector) {
    hideRules.delete(selector);
    removeRules.delete(selector);
    renderStyle();
    syncRemovalWatcher();
  }

  function hideNow(selectors) {
    if (!selectors.length) return;
    if (document.documentElement) {
      addHideRules(selectors);
    } else {
      document.addEventListener('readystatechange', () => addHideRules(selectors), { once: true });
    }
  }

  async function requestCosmetics() {
    if (!/^https?:$/.test(location.protocol)) return;
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'cosmetic',
        host: location.hostname,
      });
      if (!response?.ok) return;
      const { hide = [], remove = [] } = response.result || {};
      if (Array.isArray(hide)) hideNow(hide);
      if (Array.isArray(remove) && remove.length) addRemoveRules(remove);
    } catch {
      /* service worker ainda acordando ou extensão recarregando */
    }
  }

  void requestCosmetics();

  /* ------------------------------------------------------------------ */
  /* Seletor de elemento                                                 */
  /* ------------------------------------------------------------------ */

  function toast(text) {
    const node = document.createElement('div');
    node.textContent = text;
    node.style.cssText = [
      'position:fixed',
      'right:16px',
      'bottom:16px',
      'z-index:2147483647',
      'background:#111827',
      'color:#f9fafb',
      'font:13px/1.4 system-ui,sans-serif',
      'padding:10px 14px',
      'border-radius:8px',
      'box-shadow:0 8px 24px rgba(0,0,0,.35)',
      'pointer-events:none',
    ].join(';');
    (document.body || document.documentElement).appendChild(node);
    setTimeout(() => node.remove(), 2600);
  }

  /** Aviso com botão "Desfazer" (fica 9 s na tela). */
  function undoToast(text, onUndo) {
    const node = document.createElement('div');
    node.style.cssText = [
      'position:fixed',
      'right:16px',
      'bottom:16px',
      'z-index:2147483647',
      'background:#111827',
      'color:#f9fafb',
      'font:13px/1.4 system-ui,sans-serif',
      'padding:10px 12px',
      'border-radius:8px',
      'box-shadow:0 8px 24px rgba(0,0,0,.35)',
      'display:flex',
      'gap:10px',
      'align-items:center',
      'max-width:min(460px,90vw)',
    ].join(';');

    const label = document.createElement('span');
    label.textContent = text;
    label.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap';

    const button = document.createElement('button');
    button.textContent = 'Desfazer';
    button.style.cssText =
      'background:#2f6fed;color:#fff;border:0;border-radius:6px;padding:5px 12px;cursor:pointer;font:inherit;flex:0 0 auto';

    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      node.remove();
    };

    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      finish();
      void onUndo();
    });

    node.append(label, button);
    (document.body || document.documentElement).appendChild(node);
    setTimeout(finish, 9000);
  }

  function selectorFor(element) {
    if (element.id && /^[A-Za-z][\w-]*$/.test(element.id)) {
      return `#${CSS.escape(element.id)}`;
    }
    const parts = [];
    let node = element;
    while (node && node.nodeType === 1 && parts.length < 4) {
      let part = node.tagName.toLowerCase();
      const classes = [...(node.classList || [])]
        .filter((name) => /^[A-Za-z][\w-]*$/.test(name))
        .slice(0, 3);
      if (classes.length) part += `.${classes.map((name) => CSS.escape(name)).join('.')}`;
      parts.unshift(part);
      const parent = node.parentElement;
      if (!parent || parent === document.documentElement || parent === document.body) break;
      const sameTag = [...parent.children].filter((child) => child.tagName === node.tagName);
      if (sameTag.length === 1) {
        node = parent;
        continue;
      }
      // Vários irmãos com a mesma tag: o caminho com classes costuma bastar.
      if (classes.length) {
        node = parent;
        continue;
      }
      const index = sameTag.indexOf(node) + 1;
      parts[0] = `${part}:nth-of-type(${index})`;
      node = parent;
    }
    return parts.join(' > ');
  }

  function isUsable(selector) {
    try {
      const matches = document.querySelectorAll(selector);
      return matches.length > 0 && matches.length < 500;
    } catch {
      return false;
    }
  }

  let pickerActive = false;
  let overlay = null;
  let banner = null;
  let currentTarget = null;

  function cleanupPicker() {
    pickerActive = false;
    overlay?.remove();
    banner?.remove();
    overlay = null;
    banner = null;
    currentTarget = null;
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKey, true);
  }

  function onMove(event) {
    if (!pickerActive) return;
    const element = document.elementFromPoint(event.clientX, event.clientY);
    if (!element || element === overlay || element === banner || banner?.contains(element)) return;
    currentTarget = element;
    const rect = element.getBoundingClientRect();
    overlay.style.left = `${rect.left}px`;
    overlay.style.top = `${rect.top}px`;
    overlay.style.width = `${rect.width}px`;
    overlay.style.height = `${rect.height}px`;
  }

  function onClick(event) {
    if (!pickerActive) return;
    if (banner?.contains(event.target)) return;
    event.preventDefault();
    event.stopPropagation();

    const element = currentTarget || event.target;
    let selector = selectorFor(element);
    if (!isUsable(selector)) {
      // Último recurso: caminho estrutural completo.
      const chain = [];
      let node = element;
      while (node && node.nodeType === 1 && chain.length < 8) {
        const parent = node.parentElement;
        if (!parent) break;
        const index = [...parent.children].indexOf(node) + 1;
        chain.unshift(`${node.tagName.toLowerCase()}:nth-child(${index})`);
        node = parent;
      }
      selector = chain.join(' > ');
    }

    cleanupPicker();
    if (!isUsable(selector)) {
      toast('AdShield: não consegui gerar um seletor estável para este elemento.');
      return;
    }

    addHideRules([selector]);
    void savePick(selector);
  }

  /**
   * Salva a regra e mostra o aviso com "Desfazer" — antes a regra era aplicada
   * em silêncio e não havia como ver ou remover depois.
   * O modo (esconder ou remover do DOM) é escolhido nas opções.
   */
  async function savePick(selector) {
    let domain = '';
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'pickElement',
        selector,
        host: location.hostname,
      });
      if (response?.ok) domain = response.result.domain || '';
      if (!response?.ok) throw new Error(response?.error || 'falha ao salvar');
    } catch (error) {
      removeRule(selector);
      toast(`AdShield: não consegui salvar (${error.message}).`);
      return;
    }

    undoToast(
      `AdShield: bloqueado (${selector.slice(0, 38)}${selector.length > 38 ? '…' : ''}) · modo "esconder"`,
      async () => {
        removeRule(selector);
        try {
          await chrome.runtime.sendMessage({ type: 'undoPick', domain, selector });
          toast('AdShield: bloqueio desfeito.');
        } catch {
          toast('AdShield: desfeito nesta página; recarregue se voltar.');
        }
      },
    );
  }

  function onKey(event) {
    if (event.key === 'Escape') {
      cleanupPicker();
      toast('AdShield: seleção cancelada');
    }
  }

  function startPicker() {
    if (pickerActive) return;
    if (!document.body) {
      document.addEventListener('DOMContentLoaded', startPicker, { once: true });
      return;
    }
    pickerActive = true;

    overlay = document.createElement('div');
    overlay.id = OVERLAY_ID;
    overlay.style.cssText = [
      'position:fixed',
      'z-index:2147483646',
      'border:2px solid #2f6fed',
      'background:rgba(47,111,237,.18)',
      'border-radius:3px',
      'pointer-events:none',
      'transition:all .04s linear',
    ].join(';');

    banner = document.createElement('div');
    banner.id = BANNER_ID;
    banner.style.cssText = [
      'position:fixed',
      'top:16px',
      'left:50%',
      'transform:translateX(-50%)',
      'z-index:2147483647',
      'background:#111827',
      'color:#f9fafb',
      'font:13px/1.4 system-ui,sans-serif',
      'padding:10px 14px',
      'border-radius:8px',
      'display:flex',
      'gap:12px',
      'align-items:center',
      'box-shadow:0 8px 24px rgba(0,0,0,.35)',
    ].join(';');
    const label = document.createElement('span');
    label.textContent = 'Clique no elemento que quer esconder · Esc cancela';
    const cancel = document.createElement('button');
    cancel.textContent = 'Cancelar';
    cancel.style.cssText =
      'background:#374151;color:#f9fafb;border:0;border-radius:6px;padding:4px 10px;cursor:pointer;font:inherit';
    cancel.addEventListener('click', (event) => {
      event.stopPropagation();
      cleanupPicker();
    });
    banner.append(label, cancel);

    (document.body || document.documentElement).append(overlay, banner);
    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKey, true);
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'startPicker') {
      startPicker();
      sendResponse({ ok: true });
    }
    return false;
  });
})();
