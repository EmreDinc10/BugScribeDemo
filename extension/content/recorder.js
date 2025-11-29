(() => {
  const stringify = (value, limit = 2000) => {
    try {
      const str = typeof value === 'string' ? value : JSON.stringify(value);
      if (str.length > limit) return `${str.slice(0, limit)}...[truncated ${str.length - limit}]`;
      return str;
    } catch (err) {
      return String(value);
    }
  };

  const send = (message) => chrome.runtime.sendMessage(message).catch(() => {});

  const buildSelector = (element) => {
    if (!element || !element.tagName) return '';
    const parts = [];
    let node = element;
    while (node && node.tagName && parts.length < 4) {
      let part = node.tagName.toLowerCase();
      if (node.id) part += `#${node.id}`;
      if (node.classList?.length) part += '.' + Array.from(node.classList).slice(0, 2).join('.');
      parts.unshift(part);
      node = node.parentElement;
    }
    return parts.join(' > ');
  };

  const injectConsoleHook = () => {
    const src = chrome.runtime.getURL('content/console-hook.js');
    const script = document.createElement('script');
    script.id = 'bugscribe-console-hook';
    script.src = src;
    (document.head || document.documentElement).appendChild(script);
  };

  const patchFetch = () => {
    const nativeFetch = window.fetch;
    window.fetch = async (...args) => {
      const [input, init = {}] = args;
      const url = typeof input === 'string' ? input : input.url;
      const method = init.method || (typeof input === 'object' && input.method) || 'GET';
      const started = performance.now();
      let requestBody = '';
      if (typeof init.body === 'string') requestBody = stringify(init.body);
      try {
        const res = await nativeFetch(...args);
        const duration = performance.now() - started;
        const clone = res.clone();
        let responseBody = '';
        try {
          responseBody = await clone.text();
          responseBody = stringify(responseBody, 8000);
        } catch (err) {
          responseBody = '[unreadable body]';
        }
        const responseHeaders = {};
        try {
          clone.headers.forEach((value, key) => {
            responseHeaders[key] = value;
          });
        } catch (err) {
          // ignore
        }
        send({
          type: 'network-log',
          payload: {
            kind: 'fetch',
            url,
            method,
            status: res.status,
            durationMs: Math.round(duration),
            requestBody,
            responseHeaders,
            responseBody
          }
        });
        return res;
      } catch (err) {
        send({
          type: 'network-log',
          payload: {
            kind: 'fetch',
            url,
            method,
            status: 'error',
            error: stringify(err.message || err)
          }
        });
        throw err;
      }
    };
  };

  const patchXHR = () => {
    const OriginalXHR = window.XMLHttpRequest;
    function WrappedXHR() {
      const xhr = new OriginalXHR();
      let url = '';
      let method = 'GET';
      let started = 0;
      let requestBody = '';

      const ready = () => {
        if (xhr.readyState === 4) {
          const duration = performance.now() - started;
          let responseBody = '';
          try {
            responseBody = stringify(xhr.responseText, 8000);
          } catch (err) {
            responseBody = '[unreadable body]';
          }
          send({
            type: 'network-log',
            payload: {
              kind: 'xhr',
              url,
              method,
              status: xhr.status,
              durationMs: Math.round(duration),
              requestBody,
              responseHeaders: xhr.getAllResponseHeaders(),
              responseBody
            }
          });
        }
      };

      xhr.open = function (m, u, ...rest) {
        method = m;
        url = u;
        return OriginalXHR.prototype.open.call(xhr, m, u, ...rest);
      };
      xhr.send = function (body) {
        started = performance.now();
        if (typeof body === 'string') requestBody = stringify(body);
        xhr.addEventListener('readystatechange', ready);
        return OriginalXHR.prototype.send.call(xhr, body);
      };
      return xhr;
    }
    window.XMLHttpRequest = WrappedXHR;
  };

  const trackInteractions = () => {
    document.addEventListener('click', (event) => {
      const target = event.target;
      send({
        type: 'interaction-log',
        payload: {
          kind: 'click',
          selector: buildSelector(target),
          text: (target?.innerText || '').slice(0, 120)
        }
      });
      send({
        type: 'dom-snapshot',
        payload: {
          selector: buildSelector(target),
          outerHTML: stringify(target?.outerHTML || '', 4000)
        }
      });
    });
    document.addEventListener('keydown', (event) => {
      send({
        type: 'interaction-log',
        payload: {
          kind: 'keydown',
          key: event.key,
          selector: buildSelector(event.target)
        }
      });
    });
  };

  const collectStorage = () => {
    const safeCopy = (storage) => {
      const out = {};
      for (let i = 0; i < storage.length; i += 1) {
        const key = storage.key(i);
        out[key] = storage.getItem(key);
      }
      return out;
    };
    return {
      local: safeCopy(window.localStorage),
      session: safeCopy(window.sessionStorage)
    };
  };

  const collectPerformance = () => {
    const nav = performance.getEntriesByType('navigation');
    const resources = performance
      .getEntriesByType('resource')
      .filter((entry) => entry.initiatorType === 'xmlhttprequest' || entry.initiatorType === 'fetch')
      .slice(-10)
      .map((entry) => ({
        name: entry.name,
        initiatorType: entry.initiatorType,
        duration: entry.duration
      }));
    return { navigation: nav[0], resources };
  };

  const showActionButton = () => {
    const existing = document.getElementById('bugscribe-launcher');
    if (existing) return existing;
    const btn = document.createElement('button');
    btn.id = 'bugscribe-launcher';
    btn.textContent = '?';
    Object.assign(btn.style, {
      position: 'fixed',
      bottom: '20px',
      right: '20px',
      width: '46px',
      height: '46px',
      borderRadius: '50%',
      border: '1px solid #0f172a',
      background: '#f8fafc',
      color: '#0f172a',
      fontSize: '20px',
      boxShadow: '0 12px 30px rgba(0,0,0,0.12)',
      cursor: 'pointer',
      zIndex: 2147483647
    });
    btn.title = 'Report a bug';
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = '…';
      const pageContext = {
        url: window.location.href,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        userAgent: navigator.userAgent
      };
      const storageSnapshot = collectStorage();
      const performanceData = collectPerformance();
      try {
        const result = await chrome.runtime.sendMessage({
          type: 'prepare-report',
          pageContext,
          storageSnapshot,
          performanceData
        });
        if (!result?.ok) {
          console.warn('Report failed', result?.error);
          alert('Could not prepare report: ' + (result?.error || 'Unknown error'));
        }
      } finally {
        btn.disabled = false;
        btn.textContent = '?';
      }
    });
    document.body.appendChild(btn);
    return btn;
  };

  const init = () => {
    send({ type: 'page-active' });
    injectConsoleHook();
    patchFetch();
    patchXHR();
    trackInteractions();
    showActionButton();
    window.addEventListener('message', (event) => {
      if (event.source !== window) return;
      const data = event.data;
      if (!data || data.source !== 'bugscribe') return;
      if (data.kind === 'console-log') {
        send({ type: 'console-log', payload: data.payload });
      }
    });
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
