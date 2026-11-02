/**
 * AdShield — bloqueio de anúncios no YouTube (mundo MAIN).
 *
 * Implementa, em código próprio, o que a lista anti-circumvention do AdBlock
 * (`abp-filters-anti-cv.txt`, assinatura que ele liga por padrão) faz por meio
 * de snippets:
 *
 *   override-property-read ytInitialPlayerResponse.adPlacements undefined
 *   skip-video '.video-stream' './/…ad-interrupting…'
 *   event-override click trusted; simulate-mouse-event 'button.ytp-skip-ad-button'
 *
 * Ou seja: (1) a leitura dos campos de anúncio devolve `undefined`, (2) o vídeo
 * do anúncio é avançado até o fim, (3) o botão "Pular" recebe clique com evento
 * marcado como confiável, que é o que o player exige.
 *
 * Roda antes dos scripts da página. Nada sai daqui para a rede.
 */

(() => {
  if (window.__adshieldYoutubeLoaded) return;
  window.__adshieldYoutubeLoaded = true;

  /** Campos que carregam anúncio dentro da resposta do player. */
  const AD_KEYS = [
    'adPlacements',
    'adSlots',
    'playerAds',
    'adBreakParams',
    'adBreakHeartbeatParams',
    'playerAdParams',
    'adThumbnail',
    'adInfoRenderer',
  ];

  const PLAYER_PATH = /\/youtubei\/v1\/player(\/|\?|$)/;

  /* ------------------------------------------------------------------ */
  /* Limpeza do JSON                                                     */
  /* ------------------------------------------------------------------ */

  function prune(value, depth = 0) {
    if (!value || typeof value !== 'object' || depth > 6) return value;
    if (Array.isArray(value)) {
      for (const item of value) prune(item, depth + 1);
      return value;
    }
    for (const key of AD_KEYS) {
      if (key in value) {
        try {
          delete value[key];
        } catch {
          /* não configurável: o harden cobre depois */
        }
      }
    }
    if (value.playerResponse && typeof value.playerResponse === 'object') {
      prune(value.playerResponse, depth + 1);
    }
    return value;
  }

  /**
   * Equivalente a `override-property-read`: mesmo que a página reatribua, a
   * leitura continua devolvendo `undefined`.
   */
  function harden(value) {
    if (!value || typeof value !== 'object') return value;
    for (const key of AD_KEYS) {
      try {
        Object.defineProperty(value, key, {
          configurable: true,
          enumerable: false,
          get() {
            return undefined;
          },
          set() {
            /* descarta silenciosamente */
          },
        });
      } catch {
        /* propriedade travada: ignora */
      }
    }
    return value;
  }

  function sanitize(value) {
    return harden(prune(value));
  }

  function looksLikePlayerResponse(url, data) {
    if (typeof url === 'string' && PLAYER_PATH.test(url)) return true;
    return Boolean(
      data &&
        typeof data === 'object' &&
        ('streamingData' in data || 'adPlacements' in data || 'playabilityStatus' in data),
    );
  }

  /* ------------------------------------------------------------------ */
  /* fetch                                                               */
  /* ------------------------------------------------------------------ */

  const nativeFetch = window.fetch;
  if (typeof nativeFetch === 'function') {
    window.fetch = function patchedFetch(input) {
      const url = typeof input === 'string' ? input : input && input.url ? input.url : '';
      const promise = nativeFetch.apply(this, arguments);
      if (!PLAYER_PATH.test(url)) return promise;
      return promise.then(async (response) => {
        try {
          const data = await response.clone().json();
          if (!looksLikePlayerResponse(url, data)) return response;
          sanitize(data);
          const headers = new Headers(response.headers);
          headers.delete('content-length');
          headers.delete('content-encoding');
          return new Response(JSON.stringify(data), {
            status: response.status,
            statusText: response.statusText,
            headers,
          });
        } catch {
          return response;
        }
      });
    };
  }

  /* ------------------------------------------------------------------ */
  /* XMLHttpRequest                                                      */
  /* ------------------------------------------------------------------ */

  if (window.XMLHttpRequest) {
    const proto = XMLHttpRequest.prototype;
    const nativeOpen = proto.open;
    const nativeSend = proto.send;

    proto.open = function patchedOpen(method, url) {
      this.__adshieldUrl = String(url || '');
      return nativeOpen.apply(this, arguments);
    };

    proto.send = function patchedSend() {
      const url = this.__adshieldUrl || '';
      if (PLAYER_PATH.test(url)) {
        this.addEventListener('readystatechange', () => {
          if (this.readyState !== 4) return;
          try {
            if (this.responseType === '' || this.responseType === 'text') {
              const text = this.responseText;
              if (!text || text[0] !== '{') return;
              const data = JSON.parse(text);
              if (!looksLikePlayerResponse(url, data)) return;
              sanitize(data);
              const patched = JSON.stringify(data);
              Object.defineProperty(this, 'responseText', { configurable: true, get: () => patched });
              Object.defineProperty(this, 'response', { configurable: true, get: () => patched });
            } else if (this.responseType === 'json' && this.response) {
              sanitize(this.response);
            }
          } catch {
            /* resposta inesperada: deixa como está */
          }
        });
      }
      return nativeSend.apply(this, arguments);
    };
  }

  /* ------------------------------------------------------------------ */
  /* ytInitialPlayerResponse e ytplayer.config                           */
  /* ------------------------------------------------------------------ */

  let initialResponse = window.ytInitialPlayerResponse;
  try {
    Object.defineProperty(window, 'ytInitialPlayerResponse', {
      configurable: true,
      get() {
        return initialResponse;
      },
      set(value) {
        initialResponse = sanitize(value);
      },
    });
  } catch {
    /* já definido pela página: o observer cobre */
  }

  function hardenYtplayerConfig() {
    try {
      const raw = window.ytplayer && window.ytplayer.config && window.ytplayer.config.args;
      if (raw && raw.raw_player_response) sanitize(raw.raw_player_response);
      if (raw && raw.player_response) {
        const parsed = typeof raw.player_response === 'string' ? JSON.parse(raw.player_response) : raw.player_response;
        sanitize(parsed);
        if (typeof raw.player_response === 'string') raw.player_response = JSON.stringify(parsed);
      }
    } catch {
      /* estrutura ausente */
    }
  }

  /* ------------------------------------------------------------------ */
  /* Eventos "confiáveis" — é o que o player exige para aceitar o clique  */
  /* ------------------------------------------------------------------ */

  /**
   * O Chrome cria `isTrusted` como propriedade não configurável em cada
   * evento, então não dá para falsificar no objeto. O caminho é o mesmo do
   * snippet `event-override click trusted`: marcar os eventos que nós
   * disparamos e entregar ao listener uma fachada que responde `true`.
   */
  const syntheticEvents = new WeakSet();
  const wrappedListeners = new WeakMap();
  const CLICK_TYPES = new Set(['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup']);
  const nativeAddEventListener = EventTarget.prototype.addEventListener;
  const nativeRemoveEventListener = EventTarget.prototype.removeEventListener;

  function markSynthetic(event) {
    syntheticEvents.add(event);
    return event;
  }

  function facadeFor(event) {
    return new Proxy(event, {
      get(target, property) {
        if (property === 'isTrusted') return true;
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }

  EventTarget.prototype.addEventListener = function patchedAdd(type, listener, options) {
    if (typeof listener !== 'function' || !CLICK_TYPES.has(type)) {
      return nativeAddEventListener.call(this, type, listener, options);
    }
    let byType = wrappedListeners.get(listener);
    if (!byType) {
      byType = new Map();
      wrappedListeners.set(listener, byType);
    }
    let wrapped = byType.get(type);
    if (!wrapped) {
      wrapped = function (event) {
        if (event && syntheticEvents.has(event)) return listener.call(this, facadeFor(event));
        return listener.call(this, event);
      };
      byType.set(type, wrapped);
    }
    return nativeAddEventListener.call(this, type, wrapped, options);
  };

  EventTarget.prototype.removeEventListener = function patchedRemove(type, listener, options) {
    const byType = typeof listener === 'function' ? wrappedListeners.get(listener) : null;
    const wrapped = byType && byType.get(type);
    if (wrapped) return nativeRemoveEventListener.call(this, type, wrapped, options);
    return nativeRemoveEventListener.call(this, type, listener, options);
  };

  function trustedClick(element) {
    const base = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      button: 0,
      buttons: 1,
      clientX: 0,
      clientY: 0,
    };
    const sequence = [
      ['pointerdown', window.PointerEvent || MouseEvent],
      ['mousedown', MouseEvent],
      ['pointerup', window.PointerEvent || MouseEvent],
      ['mouseup', MouseEvent],
      ['click', MouseEvent],
    ];
    for (const [type, Ctor] of sequence) {
      try {
        element.dispatchEvent(markSynthetic(new Ctor(type, base)));
      } catch {
        element.click();
        return;
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* DOM: pular anúncio, esconder slots, derrubar o muro                 */
  /* ------------------------------------------------------------------ */

  const SKIP_SELECTORS = [
    'button.ytp-skip-ad-button',
    '.ytp-skip-ad-button',
    '.ytp-ad-skip-button-modern',
    '.ytp-ad-skip-button',
    'button.ytp-ad-skip-button-container',
  ];
  const WALL_SELECTORS = ['ytd-enforcement-message-view-model'];

  function isAdPlaying(player) {
    return Boolean(
      player && (player.classList.contains('ad-showing') || player.classList.contains('ad-interrupting')),
    );
  }

  /**
   * `skip-video`: avança o vídeo do anúncio até o fim.
   * Só age quando o player declara explicitamente que está em anúncio.
   */
  function skipAdVideo(player) {
    if (!isAdPlaying(player)) return false;
    const adModule = document.querySelector('.video-ads .ytp-ad-module');
    const hasSkip = SKIP_SELECTORS.some((selector) => document.querySelector(selector));
    const hasAdChild = adModule ? adModule.childElementCount > 0 : false;
    if (!hasSkip && !hasAdChild) return false;

    const video = document.querySelector('video.html5-main-video') || document.querySelector('video');
    if (!video) return false;
    const duration = video.duration;
    try {
      if (Number.isFinite(duration) && duration > 0) {
        if (video.currentTime < duration - 0.3) {
          video.currentTime = duration - 0.05;
          return true;
        }
      } else if (video.playbackRate < 16) {
        video.playbackRate = 16;
        return true;
      }
    } catch {
      /* seek bloqueado */
    }
    return false;
  }

  function clickSkipButtons() {
    for (const selector of SKIP_SELECTORS) {
      const button = document.querySelector(selector);
      if (!button || button.disabled || button.getAttribute('aria-disabled') === 'true') continue;
      if (button.dataset.adshieldClicked === '1') continue;
      button.dataset.adshieldClicked = '1';
      trustedClick(button);
      return true;
    }
    return false;
  }

  function clearAdContainers() {
    for (const selector of ['.video-ads', '.ytp-ad-module', '#masthead-ad', '#player-ads']) {
      for (const node of document.querySelectorAll(selector)) {
        if (node.childElementCount) node.setAttribute('data-adshield-cleared', '1');
      }
    }
  }

  function dismissWall() {
    for (const selector of WALL_SELECTORS) {
      for (const node of document.querySelectorAll(selector)) {
        const text = (node.textContent || '').toLowerCase();
        const isAdblockWall =
          node.tagName === 'YTD-ENFORCEMENT-MESSAGE-VIEW-MODEL' ||
          /bloqueador de an[úu]ncios|ad blocker|adblock/i.test(text);
        if (!isAdblockWall) continue;
        node.remove();
        const video = document.querySelector('video');
        if (video && video.paused) void video.play().catch(() => {});
        const player = document.querySelector('#movie_player, .html5-video-player');
        if (player) player.classList.remove('ad-showing', 'ad-interrupting');
      }
    }
  }

  function tick() {
    try {
      const player = document.querySelector('#movie_player, .html5-video-player');
      clickSkipButtons();
      skipAdVideo(player);
      clearAdContainers();
      dismissWall();
      hardenYtplayerConfig();
    } catch {
      /* nunca derruba a página */
    }
  }

  let scheduled = false;
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      tick();
    }, 100);
  }

  function startDomWatchers() {
    tick();
    // Rápido durante anúncio, lento no resto do tempo.
    setInterval(() => {
      const player = document.querySelector('#movie_player, .html5-video-player');
      if (isAdPlaying(player)) tick();
    }, 250);
    setInterval(tick, 1500);
    const observer = new MutationObserver(schedule);
    observer.observe(document.documentElement || document, { childList: true, subtree: true });
  }

  startDomWatchers();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startDomWatchers, { once: true });
  }

  // Gancho para testes automatizados.
  Object.defineProperty(window, '__adshieldYoutube', {
    configurable: true,
    value: { prune, harden, sanitize, looksLikePlayerResponse, tick, trustedClick },
  });
})();
