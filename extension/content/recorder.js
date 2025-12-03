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

  const createChatPopup = () => {
    // Remove existing popup if any
    const existing = document.getElementById('bugscribe-chat-popup');
    if (existing) {
      existing.remove();
    }

    const popup = document.createElement('div');
    popup.id = 'bugscribe-chat-popup';
    Object.assign(popup.style, {
      position: 'fixed',
      bottom: '80px',
      right: '20px',
      width: '400px',
      maxHeight: '600px',
      background: '#0b1224',
      color: '#e5e7eb',
      border: '1px solid #1f2a44',
      borderRadius: '12px',
      boxShadow: '0 20px 60px rgba(0, 0, 0, 0.35)',
      fontFamily: '"Inter", "Segoe UI", system-ui, -apple-system, sans-serif',
      zIndex: 2147483646,
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden'
    });

    // Header
    const header = document.createElement('div');
    header.style.cssText = 'padding: 12px 14px; border-bottom: 1px solid #1f2a44; font-weight: 600; display: flex; justify-content: space-between; align-items: center;';
    header.innerHTML = '<span>BugScribe Assistant</span><button id="bugscribe-close" style="background: none; border: none; color: #9ca3af; cursor: pointer; font-size: 20px; padding: 0; width: 24px; height: 24px;">×</button>';
    popup.appendChild(header);

    // Chat log
    const chatLog = document.createElement('div');
    chatLog.id = 'bugscribe-chat-log';
    chatLog.style.cssText = 'flex: 1; padding: 12px; overflow-y: auto; display: flex; flex-direction: column; gap: 10px; max-height: 400px;';
    popup.appendChild(chatLog);

    // Input area
    const inputArea = document.createElement('div');
    inputArea.style.cssText = 'padding: 12px; border-top: 1px solid #1f2a44; display: flex; flex-direction: column; gap: 8px;';
    
    const textarea = document.createElement('textarea');
    textarea.id = 'bugscribe-chat-input';
    textarea.placeholder = 'Describe what you\'re experiencing...';
    textarea.rows = 3;
    textarea.style.cssText = 'width: 100%; background: #0f172a; color: #e5e7eb; border: 1px solid #1f2a44; border-radius: 8px; padding: 8px 10px; font-size: 13px; resize: vertical; font-family: inherit;';
    inputArea.appendChild(textarea);

    const buttonRow = document.createElement('div');
    buttonRow.style.cssText = 'display: flex; gap: 8px;';
    
    const sendBtn = document.createElement('button');
    sendBtn.textContent = 'Send';
    sendBtn.style.cssText = 'flex: 1; background: linear-gradient(135deg, #2563eb, #1d4ed8); color: #fff; border: none; border-radius: 8px; padding: 9px 10px; font-weight: 600; cursor: pointer;';
    buttonRow.appendChild(sendBtn);

    const reportBtn = document.createElement('button');
    reportBtn.textContent = 'I want to report';
    reportBtn.style.cssText = 'background: #dc2626; color: #fff; border: none; border-radius: 8px; padding: 9px 10px; font-weight: 600; cursor: pointer;';
    buttonRow.appendChild(reportBtn);

    inputArea.appendChild(buttonRow);
    popup.appendChild(inputArea);

    document.body.appendChild(popup);

    // Close button handler will be added by restoreChatPopup
    return { popup, chatLog, textarea, sendBtn, reportBtn };
  };

  const addChatMessage = (chatLog, role, content) => {
    const msg = document.createElement('div');
    msg.style.cssText = `padding: 10px 12px; border-radius: 10px; line-height: 1.5; font-size: 13px; max-width: 85%; word-wrap: break-word; ${
      role === 'user' 
        ? 'background: #1d4ed8; align-self: flex-end; margin-left: auto;' 
        : 'background: #111827; border: 1px solid #1f2a44;'
    }`;
    msg.textContent = content;
    chatLog.appendChild(msg);
    chatLog.scrollTop = chatLog.scrollHeight;
  };

  const restoreChatPopup = async (savedChatHistory = []) => {
    const { popup, chatLog, textarea, sendBtn, reportBtn } = createChatPopup();
    
    let chatHistory = savedChatHistory.length > 0 ? [...savedChatHistory] : [];
    
    const currentUrl = window.location.href;
    
    // Restore chat history or show welcome message
    if (chatHistory.length > 0) {
      // Restore all messages from history
      chatHistory.forEach(msg => {
        addChatMessage(chatLog, msg.role, msg.content);
      });
    } else {
      // Add welcome message only if no history
      addChatMessage(chatLog, 'assistant', 'Hi! I\'m BugScribe Assistant. I can help you understand what\'s happening on this page. What seems to be the issue?');
    }

    // Save popup state as open
    chrome.runtime.sendMessage({
      type: 'save-popup-state',
      url: currentUrl,
      isOpen: true
    }).catch(err => console.warn('Could not save popup state:', err));

    // Close button handler - save state when closed
    const closeBtn = document.getElementById('bugscribe-close');
    if (closeBtn) {
      closeBtn.addEventListener('click', async () => {
        chrome.runtime.sendMessage({
          type: 'save-popup-state',
          url: currentUrl,
          isOpen: false
        }).catch(err => console.warn('Could not save popup state:', err));
        popup.remove();
      });
    }

      // Send button handler
      sendBtn.addEventListener('click', async () => {
        const userMessage = textarea.value.trim();
        if (!userMessage) return;

        addChatMessage(chatLog, 'user', userMessage);
        chatHistory.push({ role: 'user', content: userMessage });
        textarea.value = '';
        sendBtn.disabled = true;
        sendBtn.textContent = 'Sending...';

        const pageContext = {
          url: window.location.href,
          viewport: { width: window.innerWidth, height: window.innerHeight },
          userAgent: navigator.userAgent
        };
        const storageSnapshot = collectStorage();
        const performanceData = collectPerformance();

        try {
          const result = await chrome.runtime.sendMessage({
            type: 'chat-with-context',
            userMessage,
            chatHistory,
            pageContext,
            storageSnapshot,
            performanceData
          });

          if (result?.ok && result?.response) {
            addChatMessage(chatLog, 'assistant', result.response);
            chatHistory.push({ role: 'assistant', content: result.response });
            // Chat history is automatically saved in background.js after response
          } else {
            addChatMessage(chatLog, 'assistant', 'Sorry, I encountered an error. Please try again.');
          }
        } catch (err) {
          addChatMessage(chatLog, 'assistant', 'Sorry, I encountered an error. Please try again.');
        } finally {
          sendBtn.disabled = false;
          sendBtn.textContent = 'Send';
        }
      });

      // Enter key to send
      textarea.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          sendBtn.click();
        }
      });

      // Report button handler
      reportBtn.addEventListener('click', async () => {
        reportBtn.disabled = true;
        reportBtn.textContent = 'Preparing...';
        
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
            alert('Could not prepare report: ' + (result?.error || 'Unknown error'));
            reportBtn.disabled = false;
            reportBtn.textContent = 'I want to report';
          } else {
            // Close popup when successfully navigating to GitHub
            chrome.runtime.sendMessage({
              type: 'save-popup-state',
              url: currentUrl,
              isOpen: false
            }).catch(err => console.warn('Could not save popup state:', err));
            popup.remove();
          }
          // If successful, the background script will open GitHub page
        } catch (err) {
          alert('Error: ' + err.message);
          reportBtn.disabled = false;
          reportBtn.textContent = 'I want to report';
        }
      });

    return { popup, chatLog, textarea, sendBtn, reportBtn, chatHistory };
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
    btn.title = 'Get help with BugScribe';
    btn.addEventListener('click', async () => {
      // Load saved chat history
      let savedHistory = [];
      try {
        const historyResult = await chrome.runtime.sendMessage({
          type: 'load-chat-history',
          url: window.location.href
        });
        if (historyResult?.ok) {
          savedHistory = historyResult.chatHistory || [];
        }
      } catch (err) {
        console.warn('Could not load chat history:', err);
      }
      
      await restoreChatPopup(savedHistory);
    });
    document.body.appendChild(btn);
    return btn;
  };

  const init = async () => {
    send({ type: 'page-active' });
    injectConsoleHook();
    patchFetch();
    patchXHR();
    trackInteractions();
    showActionButton();
    
    // Restore popup if it was open before refresh
    try {
      const popupState = await chrome.runtime.sendMessage({
        type: 'load-popup-state',
        url: window.location.href
      });
      
      if (popupState?.ok && popupState.isOpen) {
        // Load chat history and restore popup
        const historyResult = await chrome.runtime.sendMessage({
          type: 'load-chat-history',
          url: window.location.href
        });
        const savedHistory = historyResult?.ok ? (historyResult.chatHistory || []) : [];
        await restoreChatPopup(savedHistory);
      }
    } catch (err) {
      console.warn('Could not restore popup state:', err);
    }
    
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
