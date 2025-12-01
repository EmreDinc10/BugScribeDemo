// content.ts – Injects into web pages
console.log('Network Logger content script loaded');
// Listen for popup messages
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === "getContentLogs") {
        sendResponse({
            status: "Content script active",
            url: window.location.href,
            title: document.title
        });
    }
    return true;
});
(() => {
    console.log('%cISOLATED CONTENT SCRIPT LOADED FOR CONSOLE', 'color:orange;font-size:16px', location.href);
    // Build URL of main-world script
    const scriptUrl = chrome.runtime.getURL('content/main-world.js');
    const script = document.createElement('script');
    script.type = 'module';
    script.src = scriptUrl;
    script.onload = () => {
        console.log('%cMAIN-WORLD SCRIPT LOADED', 'color:green');
    };
    script.onerror = (e) => {
        console.error('%cFAILED TO LOAD MAIN-WORLD SCRIPT', 'color:red', e);
    };
    (document.head || document.documentElement).appendChild(script);
    // Listen for messages from main-world script
    window.addEventListener('message', (event) => {
        const data = event.data;
        if (event.source === window && data?.type === 'CONSOLE_LOG') {
            console.log('%cRECEIVED FROM MAIN WORLD', 'color:#ff6600', data.entry);
            try {
                chrome.runtime.sendMessage({
                    type: 'log-console-entry',  // <-- new unified type
                    payload: data.entry
                });
            }
            catch (err) {
                console.error('%cSEND FAILED', 'color:red', err);
            }
        }
    });
    setTimeout(() => console.log('ISOLATED TEST LOG'), 500);
})();
