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
      default:
        break;
    }
  })();
  return true;
});
