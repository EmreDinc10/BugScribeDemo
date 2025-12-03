import { OPENAI_API_KEY } from './config.js';

const MAX_LOGS = 200;
const MAX_NETWORK = 200;
const MAX_INTERACTIONS = 200;
const MAX_DOM = 50;
const MAX_SCREENSHOTS = 2;

const state = {
  consoleLogs: [],
  networkLogs: [],
  interactions: [],
  domSnapshots: [],
  screenshots: [],
  lastDraft: null,
  chatHistory: [],
  isLogging: true
};

let trackedTabId = null;
let issueTabId = null;

// -------------------- Storage Management --------------------
const STORAGE_KEYS = {
  STATE: 'bugscribe_state',
  CHAT_HISTORY: 'bugscribe_chat_history',
  POPUP_STATE: 'bugscribe_popup_state'
};

const saveState = async () => {
  try {
    // Save state data (excluding screenshots data URLs which are too large)
    const stateToSave = {
      consoleLogs: state.consoleLogs,
      networkLogs: state.networkLogs,
      interactions: state.interactions,
      domSnapshots: state.domSnapshots,
      lastDraft: state.lastDraft,
      isLogging: state.isLogging,
      // Screenshots: only save metadata, not data URLs
      screenshots: state.screenshots.map(s => ({ capturedAt: s.capturedAt }))
    };
    await chrome.storage.local.set({ [STORAGE_KEYS.STATE]: stateToSave });
  } catch (err) {
    console.error('Failed to save state:', err);
  }
};

const loadState = async () => {
  try {
    const result = await chrome.storage.local.get(STORAGE_KEYS.STATE);
    if (result[STORAGE_KEYS.STATE]) {
      const saved = result[STORAGE_KEYS.STATE];
      state.consoleLogs = saved.consoleLogs || [];
      state.networkLogs = saved.networkLogs || [];
      state.interactions = saved.interactions || [];
      state.domSnapshots = saved.domSnapshots || [];
      state.lastDraft = saved.lastDraft || null;
      state.isLogging = saved.isLogging !== undefined ? saved.isLogging : true;
      // Screenshots data URLs are not restored (they're too large and can be regenerated)
      state.screenshots = saved.screenshots || [];
    }
  } catch (err) {
    console.error('Failed to load state:', err);
  }
};

const saveChatHistory = async (tabId, url, chatHistory) => {
  try {
    const key = `${STORAGE_KEYS.CHAT_HISTORY}_${tabId}_${url}`;
    await chrome.storage.local.set({ [key]: { chatHistory, timestamp: Date.now() } });
  } catch (err) {
    console.error('Failed to save chat history:', err);
  }
};

const loadChatHistory = async (tabId, url) => {
  try {
    const key = `${STORAGE_KEYS.CHAT_HISTORY}_${tabId}_${url}`;
    const result = await chrome.storage.local.get(key);
    if (result[key] && result[key].chatHistory) {
      return result[key].chatHistory;
    }
  } catch (err) {
    console.error('Failed to load chat history:', err);
  }
  return [];
};

const savePopupState = async (tabId, url, isOpen) => {
  try {
    const key = `${STORAGE_KEYS.POPUP_STATE}_${tabId}_${url}`;
    await chrome.storage.local.set({ [key]: { isOpen, timestamp: Date.now() } });
  } catch (err) {
    console.error('Failed to save popup state:', err);
  }
};

const loadPopupState = async (tabId, url) => {
  try {
    const key = `${STORAGE_KEYS.POPUP_STATE}_${tabId}_${url}`;
    const result = await chrome.storage.local.get(key);
    if (result[key]) {
      return result[key].isOpen || false;
    }
  } catch (err) {
    console.error('Failed to load popup state:', err);
  }
  return false;
};

// Clean up old chat histories (older than 24 hours)
const cleanupOldChatHistories = async () => {
  try {
    const allData = await chrome.storage.local.get(null);
    const now = Date.now();
    const oneDay = 24 * 60 * 60 * 1000;
    const keysToRemove = [];
    
    for (const key in allData) {
      if (key.startsWith(STORAGE_KEYS.CHAT_HISTORY) || key.startsWith(STORAGE_KEYS.POPUP_STATE)) {
        if (allData[key].timestamp && (now - allData[key].timestamp) > oneDay) {
          keysToRemove.push(key);
        }
      }
    }
    
    if (keysToRemove.length > 0) {
      await chrome.storage.local.remove(keysToRemove);
    }
  } catch (err) {
    console.error('Failed to cleanup old chat histories:', err);
  }
};

// Initialize: Load state on startup
loadState();
cleanupOldChatHistories();

// Save state periodically (every 30 seconds)
setInterval(() => {
  saveState();
}, 30000);

// -------------------- Network Capture --------------------
if (chrome.webRequest) {
  // Before request
  chrome.webRequest.onBeforeRequest.addListener((details) => {
    if (!state.isLogging) return;
    const logEntry = {
      id: details.requestId,
      url: details.url,
      method: details.method,
      type: details.type,
      timestamp: details.timeStamp,
      time: new Date(details.timeStamp).toISOString(),
      frameId: details.frameId,
      parentFrameId: details.parentFrameId
    };
    trimPush(state.networkLogs, logEntry, MAX_NETWORK);
  }, { urls: ["<all_urls>"] });

  // Before send headers
  chrome.webRequest.onBeforeSendHeaders.addListener((details) => {
    const idx = state.networkLogs.findIndex(log => log.id === details.requestId);
    if (idx !== -1) state.networkLogs[idx].requestHeaders = details.requestHeaders || [];
  }, { urls: ["<all_urls>"] }, ["requestHeaders", "extraHeaders"]);

  // Completed
  chrome.webRequest.onCompleted.addListener((details) => {
    const idx = state.networkLogs.findIndex(log => log.id === details.requestId);
    if (idx !== -1) {
      state.networkLogs[idx].responseStatusCode = details.statusCode;
      state.networkLogs[idx].responseHeaders = details.responseHeaders || [];
    }
  }, { urls: ["<all_urls>"] }, ["responseHeaders", "extraHeaders"]);

  // Error
  chrome.webRequest.onErrorOccurred.addListener((details) => {
    const idx = state.networkLogs.findIndex(log => log.id === details.requestId);
    if (idx !== -1) state.networkLogs[idx].error = details.error;
  }, { urls: ["<all_urls>"] });
}

setInterval(() => {
  const cutoff = Date.now() - 60000;
  state.networkLogs = state.networkLogs.filter(log => log.timestamp > cutoff);
  state.consoleLogs = state.consoleLogs.filter(log => log.timestamp > cutoff);
}, 5000);

const trimPush = (bucket, entry, cap) => {
  bucket.push(entry);
  if (bucket.length > cap) {
    bucket.shift();
  }
};

const captureScreenshot = async () => {
  if (trackedTabId === null) return;
  try {
    const tab = await chrome.tabs.get(trackedTabId);
    if (!tab.active) return;
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    const shot = { dataUrl, capturedAt: Date.now() };
    trimPush(state.screenshots, shot, MAX_SCREENSHOTS);
    // Save locally to avoid extra backend handling.
    chrome.downloads.download({
      url: dataUrl,
      filename: `bugscribe/screenshot-${shot.capturedAt}.png`,
      saveAs: false
    });
  } catch (err) {
    console.error('capture screenshot failed', err);
  }
};

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'bugscribe-capture') {
    await captureScreenshot();
  }
});

const startCapture = (tabId) => {
  trackedTabId = tabId;
  chrome.alarms.create('bugscribe-capture', { periodInMinutes: 0.0833 }); // ~5s
};

const stopCapture = (tabId) => {
  if (trackedTabId === tabId) {
    trackedTabId = null;
    chrome.alarms.clear('bugscribe-capture');
  }
};

chrome.tabs.onRemoved.addListener((tabId) => stopCapture(tabId));

const safeJSON = (value, limit = 5000) => {
  try {
    const str = typeof value === 'string' ? value : JSON.stringify(value);
    if (str.length > limit) return `${str.slice(0, limit)}...[truncated ${str.length - limit}]`;
    return str;
  } catch (err) {
    return String(value);
  }
};

const ensureKey = () => {
  if (!OPENAI_API_KEY) {
    throw new Error('Missing OPENAI_API_KEY in extension/config.js');
  }
};

const callLLM = async (messages, { jsonMode = false } = {}) => {
  ensureKey();
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      temperature: 0.3,
      messages,
      ...(jsonMode ? { response_format: { type: 'json_object' } } : {})
    })
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`LLM error ${response.status}: ${body}`);
  }
  const data = await response.json();
  return data.choices[0].message;
};

const buildPrompt = (payload) => {
  const { pageContext, storageSnapshot, performanceData } = payload;
  const screenshotNotes = state.screenshots.map((s) => `screenshot-${s.capturedAt}.png`);
  const system = {
    role: 'system',
    content: [
      'You prepare GitHub issue drafts and chat responses.',
      'Always respond with a single JSON object, no code fences, no extra text.',
      'If updating the issue, respond with {"type":"issue_update","title":"...","body":"..."} where body is Markdown with sections: Summary, Steps to Reproduce, Expected Result, Actual Result, Console, Network, User Actions, Screenshots, Environment. Keep concise bullet points.',
      'If the user is just chatting or you cannot update, respond with {"type":"chat","chat":"..."}',
      'Do not wrap the JSON in Markdown.'
    ].join(' ')
  };

  const user = {
    role: 'user',
    content: [
      `Page: ${pageContext.url}`,
      `Viewport: ${pageContext.viewport.width}x${pageContext.viewport.height}`,
      `User agent: ${pageContext.userAgent}`,
      `Captured at: ${new Date().toISOString()}`,
      `Recent console (${state.consoleLogs.length}):`,
      safeJSON(state.consoleLogs.slice(-20)),
      `Recent network (${state.networkLogs.length}):`,
      safeJSON(state.networkLogs.slice(-20)),
      `Recent interactions (${state.interactions.length}):`,
      safeJSON(state.interactions.slice(-15)),
      `DOM snapshot:`,
      safeJSON(state.domSnapshots.slice(-5)),
      `Storage snapshot:`,
      safeJSON(storageSnapshot, 4000),
      `Performance:`,
      safeJSON(performanceData, 2000),
      `Screenshots (filenames, already downloaded): ${screenshotNotes.join(', ') || 'none'}`,
      `Task: produce an issue_update JSON with title/body for the bug above.`
    ].join('\n')
  };

  return [system, user];
};

const draftIssue = async (payload) => {
  const messages = buildPrompt(payload);
  state.chatHistory = [...messages];
  const reply = await callLLM(messages, { jsonMode: true });
  state.chatHistory.push(reply);
  const parsed = (() => {
    try {
      return JSON.parse(reply.content);
    } catch (err) {
      return { type: 'chat', chat: reply.content };
    }
  })();
  if (parsed.type === 'issue_update') {
    state.lastDraft = { title: parsed.title, body: parsed.body };
  }
  return { draft: state.lastDraft, assistantContent: parsed };
};

const refineDraft = async (userMessage) => {
  if (!state.chatHistory.length && state.lastDraft) {
    state.chatHistory.push({
      role: 'assistant',
      content: JSON.stringify({ type: 'issue_update', ...state.lastDraft })
    });
  }
  state.chatHistory.push({ role: 'user', content: userMessage });
  const reply = await callLLM(state.chatHistory, { jsonMode: true });
  state.chatHistory.push(reply);
  const parsed = (() => {
    try {
      return JSON.parse(reply.content);
    } catch (err) {
      return { type: 'chat', chat: reply.content };
    }
  })();
  if (parsed.type === 'issue_update') {
    state.lastDraft = { title: parsed.title, body: parsed.body };
  }
  return { draft: state.lastDraft, assistantContent: parsed };
};

const chatWithContext = async (userMessage, chatHistory, payload) => {
  const { pageContext, storageSnapshot, performanceData } = payload;
  
  // Analyze recent errors and issues
  const recentErrors = state.consoleLogs
    .filter(log => log.level === 'error')
    .slice(-10);
  const failedRequests = state.networkLogs
    .filter(log => log.responseStatusCode >= 400 || log.error)
    .slice(-10);
  
  const systemPrompt = {
    role: 'system',
    content: [
      'You are BugScribe Assistant, a helpful AI that helps users understand issues on web pages.',
      '',
      'CRITICAL RULES:',
      '1. Respond in PLAIN TEXT ONLY - NO markdown, NO code blocks, NO formatting symbols like *, _, `, #, etc.',
      '2. Keep responses SHORT - aim for 1-3 sentences, maximum 50 words unless absolutely necessary',
      '3. Be conversational and friendly, like texting a colleague',
      '4. Use simple, clear language',
      '',
      'Your goal is to:',
      '- Understand what the user is experiencing by analyzing console logs, network requests, and user interactions',
      '- Determine if it\'s actually a bug or if it can be explained/solved',
      '- If it\'s not a bug, explain what\'s happening and how to resolve it briefly',
      '- If it might be a bug, help the user understand what might be wrong',
      '',
      'Examples of good responses:',
      'User: "The page is not loading"',
      'Assistant: "I see a 404 error for the API endpoint. The server might be down or the URL changed. Check your network tab."',
      '',
      'User: "Button is not working"',
      'Assistant: "No errors in console. The click handler might be missing. Check if the button has an event listener attached."',
      '',
      'User: "Why is this slow?"',
      'Assistant: "The API call is taking 5 seconds. That\'s the bottleneck. Consider caching or optimizing the backend."',
      '',
      'Remember: Plain text only, keep it short and helpful.'
    ].join('\n')
  };

  // Add few-shot examples if this is the first message (no chat history)
  const fewShotExamples = chatHistory && chatHistory.length === 0 ? [
    {
      role: 'user',
      content: 'The submit button is not working when I click it.'
    },
    {
      role: 'assistant',
      content: 'I see a JavaScript error in the console: "Cannot read property of undefined". The form handler is trying to access a field that doesn\'t exist. Check line 42 in your form.js file.'
    },
    {
      role: 'user',
      content: 'The page keeps refreshing'
    },
    {
      role: 'assistant',
      content: 'There\'s a form submission happening automatically. The form might be missing preventDefault() or the submit button type is wrong. Check your form event handlers.'
    },
    {
      role: 'user',
      content: 'I see a 500 error'
    },
    {
      role: 'assistant',
      content: 'The server is returning a 500 error on the /api/users endpoint. This is a backend issue, not a frontend bug. Check your server logs for the actual error.'
    }
  ] : [];

  // Build context information
  const contextInfo = [
    `Current page: ${pageContext.url}`,
    `Viewport: ${pageContext.viewport.width}x${pageContext.viewport.height}`,
    '',
    `Recent console errors (${recentErrors.length}):`,
    recentErrors.length > 0 
      ? safeJSON(recentErrors.map(e => ({ level: e.level, message: e.message, timestamp: e.timestamp })))
      : 'No recent console errors',
    '',
    `Failed network requests (${failedRequests.length}):`,
    failedRequests.length > 0
      ? safeJSON(failedRequests.map(r => ({ url: r.url, status: r.responseStatusCode || 'error', method: r.method })))
      : 'No failed network requests',
    '',
    `Recent console logs (last 10):`,
    safeJSON(state.consoleLogs.slice(-10).map(l => ({ level: l.level, message: l.message }))),
    '',
    `Recent interactions (last 5):`,
    safeJSON(state.interactions.slice(-5))
  ].join('\n');

  const messages = [systemPrompt];
  
  // Add few-shot examples only for the first message (no previous history)
  if (fewShotExamples.length > 0) {
    messages.push(...fewShotExamples);
  }
  
  // Build the user message with context
  const userMessageWithContext = {
    role: 'user',
    content: [
      contextInfo,
      '',
      `User's question: ${userMessage}`,
      '',
      'Based on this context, help the user understand what\'s happening. If it\'s not a bug, explain how to fix it. If it might be a bug, help them understand what might be wrong.'
    ].join('\n')
  };
  
  // Add previous chat history (excluding the last message if it's the current userMessage)
  if (chatHistory && chatHistory.length > 0) {
    // Add all messages except the last one (which is the current userMessage we're processing)
    const previousHistory = chatHistory.slice(0, -1);
    if (previousHistory.length > 0) {
      messages.push(...previousHistory);
    }
  }
  
  // Add the current user message with context
  messages.push(userMessageWithContext);

  const reply = await callLLM(messages, { jsonMode: false });
  
  // Post-process to ensure plain text (remove any markdown that might slip through)
  let cleanedResponse = reply.content;
  
  // Remove markdown code blocks
  cleanedResponse = cleanedResponse.replace(/```[\s\S]*?```/g, (match) => {
    // Extract just the content without the code fence
    return match.replace(/```[a-z]*\n?/g, '').replace(/```/g, '');
  });
  
  // Remove markdown headers
  cleanedResponse = cleanedResponse.replace(/^#{1,6}\s+/gm, '');
  
  // Remove markdown bold/italic but keep the text
  cleanedResponse = cleanedResponse.replace(/\*\*([^*]+)\*\*/g, '$1');
  cleanedResponse = cleanedResponse.replace(/\*([^*]+)\*/g, '$1');
  cleanedResponse = cleanedResponse.replace(/__([^_]+)__/g, '$1');
  cleanedResponse = cleanedResponse.replace(/_([^_]+)_/g, '$1');
  
  // Remove markdown links but keep the text
  cleanedResponse = cleanedResponse.replace(/\[([^\]]+)\]\([^\)]+\)/g, '$1');
  
  // Remove inline code markers but keep the content
  cleanedResponse = cleanedResponse.replace(/`([^`]+)`/g, '$1');
  
  // Remove list markers
  cleanedResponse = cleanedResponse.replace(/^[\s]*[-*+]\s+/gm, '');
  cleanedResponse = cleanedResponse.replace(/^[\s]*\d+\.\s+/gm, '');
  
  // Clean up extra whitespace
  cleanedResponse = cleanedResponse.replace(/\n{3,}/g, '\n\n').trim();
  
  return cleanedResponse;
};

const openIssuePage = async () => {
  const tab = await chrome.tabs.create({
    url: 'https://github.com/EmreDinc10/BugScribeAirlines/issues/new'
  });
  issueTabId = tab.id;
  return tab;
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    switch (message.type) {
      case 'page-active':
        startCapture(sender.tab.id);
        saveState(); // Save state when page becomes active
        sendResponse({ ok: true });
        break;
      case 'get-console-logs':
        sendResponse({ logs: state.consoleLogs });
        break;
      case 'get-network-logs':
        sendResponse({ logs: state.networkLogs });
        break;
      case 'log-console-entry':
        if (message.payload) {
          trimPush(state.consoleLogs, { ...message.payload }, MAX_LOGS);
          console.log(
            '%c[COLLECTOR] CONSOLE:',
            'color:purple;font-weight:bold;',
            message.payload
          );
          // Save state periodically when logs are added
          if (state.consoleLogs.length % 10 === 0) {
            saveState();
          }
        }
        sendResponse({ ok: true });
        break;
      case 'interaction-log':
        trimPush(state.interactions, { ...message.payload, at: Date.now() }, MAX_INTERACTIONS);
        break;
      case 'dom-snapshot':
        trimPush(state.domSnapshots, { ...message.payload, at: Date.now() }, MAX_DOM);
        break;
      case 'prepare-report': {
        try {
          const { draft, assistantContent } = await draftIssue({
            pageContext: message.pageContext,
            storageSnapshot: message.storageSnapshot,
            performanceData: message.performanceData
          });
          await openIssuePage();
          sendResponse({ ok: true, draft, assistantContent });
        } catch (err) {
          sendResponse({ ok: false, error: err.message });
        }
        break;
      }
      case 'refine-draft': {
        try {
          const { draft, assistantContent } = await refineDraft(message.prompt);
          sendResponse({ ok: true, draft, assistantContent });
        } catch (err) {
          sendResponse({ ok: false, error: err.message });
        }
        break;
      }
      case 'issue-page-ready':
        sendResponse({
          ok: true,
          draft: state.lastDraft,
          assistantContent: state.chatHistory
            .filter((m) => m.role === 'assistant')
            .slice(-1)[0]?.content,
          screenshots: state.screenshots.map((s) => ({
            name: `screenshot-${s.capturedAt}.png`,
            dataUrl: s.dataUrl
          }))
        });
        break;
      case 'chat-with-context': {
        try {
          const response = await chatWithContext(
            message.userMessage,
            message.chatHistory,
            {
              pageContext: message.pageContext,
              storageSnapshot: message.storageSnapshot,
              performanceData: message.performanceData
            }
          );
          // Save updated chat history (including the new user message and response)
          const updatedHistory = [...(message.chatHistory || []), 
            { role: 'user', content: message.userMessage },
            { role: 'assistant', content: response }
          ];
          await saveChatHistory(sender.tab.id, message.pageContext.url, updatedHistory);
          sendResponse({ ok: true, response });
        } catch (err) {
          sendResponse({ ok: false, error: err.message });
        }
        break;
      }
      case 'get-tab-id': {
        // Helper to get current tab ID from content script
        sendResponse({ ok: true, tabId: sender.tab?.id || null });
        break;
      }
      case 'save-chat-history': {
        try {
          const tabId = message.tabId || sender.tab?.id;
          if (!tabId || !message.url) {
            sendResponse({ ok: false, error: 'Missing tabId or url' });
            break;
          }
          await saveChatHistory(tabId, message.url, message.chatHistory);
          sendResponse({ ok: true });
        } catch (err) {
          sendResponse({ ok: false, error: err.message });
        }
        break;
      }
      case 'load-chat-history': {
        try {
          const tabId = message.tabId || sender.tab?.id;
          if (!tabId || !message.url) {
            sendResponse({ ok: false, error: 'Missing tabId or url', chatHistory: [] });
            break;
          }
          const chatHistory = await loadChatHistory(tabId, message.url);
          sendResponse({ ok: true, chatHistory });
        } catch (err) {
          sendResponse({ ok: false, error: err.message, chatHistory: [] });
        }
        break;
      }
      case 'save-popup-state': {
        try {
          const tabId = message.tabId || sender.tab?.id;
          if (!tabId || !message.url) {
            sendResponse({ ok: false, error: 'Missing tabId or url' });
            break;
          }
          await savePopupState(tabId, message.url, message.isOpen);
          sendResponse({ ok: true });
        } catch (err) {
          sendResponse({ ok: false, error: err.message });
        }
        break;
      }
      case 'load-popup-state': {
        try {
          const tabId = message.tabId || sender.tab?.id;
          if (!tabId || !message.url) {
            sendResponse({ ok: false, error: 'Missing tabId or url', isOpen: false });
            break;
          }
          const isOpen = await loadPopupState(tabId, message.url);
          sendResponse({ ok: true, isOpen });
        } catch (err) {
          sendResponse({ ok: false, error: err.message, isOpen: false });
        }
        break;
      }
      default:
        break;
    }
  })();
  return true;
});
