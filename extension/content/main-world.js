// main-world.ts — Overrides console in MAIN world
(() => {
    const orig = {
        log: console.log,
        error: console.error,
        warn: console.warn,
        info: console.info
    };
    const sendLog = (level, args) => {
        let stack = '';
        try {
            const err = new Error();
            stack = err.stack
                ?.split('\n')
                .slice(2)
                .map(line => line.trim())
                .join('\n') || '';
        }
        catch {
            stack = 'stack unavailable';
        }
        const entry = {
            level,
            message: args.map(a => String(a)).join(' '),
            url: location.href,
            timestamp: Date.now(),
            stack
        };
        orig.log('%c[MAIN] SENDING LOG', 'color:#0066ff;font-weight:bold', entry);
        window.postMessage({ type: 'CONSOLE_LOG', entry }, '*');
    };
    console.log = (...a) => { sendLog('log', a); orig.log(...a); };
    console.error = (...a) => { sendLog('error', a); orig.error(...a); };
    console.warn = (...a) => { sendLog('warn', a); orig.warn(...a); };
    console.info = (...a) => { sendLog('info', a); orig.info(...a); };
})();
