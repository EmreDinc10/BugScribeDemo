(function () {
  if (window.__bugscribeConsoleHooked) return;
  window.__bugscribeConsoleHooked = true;
  const stringify = (v, limit = 2000) => {
    try {
      const s = typeof v === 'string' ? v : JSON.stringify(v);
      return s.length > limit ? s.slice(0, limit) + '...[truncated ' + (s.length - limit) + ']' : s;
    } catch (e) {
      return String(v);
    }
  };
  ['log', 'warn', 'error', 'info'].forEach((level) => {
    const orig = window.console[level];
    window.console[level] = function (...args) {
      try {
        window.postMessage(
          {
            source: 'bugscribe',
            kind: 'console-log',
            payload: {
              level,
              args: args.map((v) => stringify(v)),
              stack: (new Error().stack || '').split('\n').slice(2, 8).join('\n')
            }
          },
          '*'
        );
      } catch (e) {
        // ignore
      }
      return orig.apply(window.console, args);
    };
  });
  window.addEventListener('error', (event) => {
    try {
      window.postMessage(
        {
          source: 'bugscribe',
          kind: 'console-log',
          payload: {
            level: 'error',
            args: [stringify(event.message || 'Error'), stringify(event.filename) + ':' + event.lineno + ':' + event.colno],
            stack: event.error && event.error.stack ? String(event.error.stack) : ''
          }
        },
        '*'
      );
    } catch (e) {
      // ignore
    }
  });
  window.addEventListener('unhandledrejection', (event) => {
    try {
      window.postMessage(
        {
          source: 'bugscribe',
          kind: 'console-log',
          payload: {
            level: 'error',
            args: ['Unhandled rejection', stringify(event.reason)],
            stack: event.reason && event.reason.stack ? String(event.reason.stack) : ''
          }
        },
        '*'
      );
    } catch (e) {
      // ignore
    }
  });
})();
