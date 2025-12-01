(() => {
  const isVisible = (el) => {
    if (!el) return false;
    const style = window.getComputedStyle(el);
    return style && style.visibility !== 'hidden' && style.display !== 'none';
  };

  const selectFirstVisible = (selectors) => {
    for (const selector of selectors) {
      const el = document.querySelector(selector);
      if (el && isVisible(el)) return el;
    }
    return null;
  };

  const findFields = () => {
    const title = selectFirstVisible([
      '#issue_title',
      'input[aria-label="Add a title"]',
      'input[placeholder="Title"]',
      'input[aria-label="Title"]'
    ]);
    const body = selectFirstVisible([
      '#issue_body',
      'textarea[aria-label="Markdown value"]',
      'textarea[placeholder="Type your description here…"]',
      'textarea[placeholder="Type your description here..."]'
    ]);
    return { title, body };
  };

  const applyDraftToForm = (draft) => {
    const { title, body } = findFields();
    if (title) {
      title.value = draft?.title || '';
      title.dispatchEvent(new Event('input', { bubbles: true }));
      title.dispatchEvent(new Event('change', { bubbles: true }));
    }
    if (body) {
      body.value = draft?.body || '';
      body.dispatchEvent(new Event('input', { bubbles: true }));
      body.dispatchEvent(new Event('change', { bubbles: true }));
    }
  };

  const createOverlay = ({ draft, screenshots, assistantContent }) => {
    const root = document.createElement('section');
    root.id = 'bugscribe-overlay';

    const header = document.createElement('header');
    header.textContent = 'BugScribe Issue Assistant';
    root.appendChild(header);

    const main = document.createElement('main');

    const chatLog = document.createElement('div');
    chatLog.className = 'chat-log';
    main.appendChild(chatLog);

    const chatArea = document.createElement('textarea');
    chatArea.rows = 3;
    chatArea.placeholder = 'Ask the assistant to refine or add details...';
    main.appendChild(chatArea);

    const status = document.createElement('small');
    status.textContent = screenshots?.length
      ? `Screenshots downloaded: ${screenshots.map((s) => s.name).join(', ')}`
      : 'No screenshots captured yet.';
    main.appendChild(status);

    const buttons = document.createElement('div');
    buttons.className = 'row';
    const sendBtn = document.createElement('button');
    sendBtn.textContent = 'Send';
    const resetBtn = document.createElement('button');
    resetBtn.textContent = 'Reset to initial';
    buttons.append(sendBtn, resetBtn);

    const downloadNetBtn = document.createElement('button');
    downloadNetBtn.textContent = 'Download Network Logs';
    buttons.appendChild(downloadNetBtn);

    const downloadConBtn = document.createElement('button');
    downloadConBtn.textContent = 'Download Console Logs';
    buttons.appendChild(downloadConBtn);
    
    main.appendChild(buttons);

    root.appendChild(main);
    document.body.appendChild(root);


    const messages = [];
    const renderLog = () => {
      chatLog.innerHTML = '';
      messages.forEach((msg) => {
        const row = document.createElement('div');
        row.className = `chat-msg ${msg.role}`;
        row.textContent = msg.content;
        chatLog.appendChild(row);
      });
      chatLog.scrollTop = chatLog.scrollHeight;
    };

    const addMessage = (role, content) => {
      messages.push({ role, content });
      renderLog();
    };

    const setDraft = (nextDraft, note) => {
      if (nextDraft?.title || nextDraft?.body) {
        applyDraftToForm(nextDraft);
      }
      status.textContent = note || 'Draft applied to GitHub form.';
    };

    downloadConBtn.addEventListener('click', async () => {
    chrome.runtime.sendMessage({ type: 'get-console-logs' }, (response) => {
        const dataStr = JSON.stringify(response.logs, null, 2);
        const blob = new Blob([dataStr], { type: 'application/json' });
        const url = URL.createObjectURL(blob);

        const a = document.createElement('a');
        a.href = url;
        a.download = 'console-logs.json';
        a.click();
        URL.revokeObjectURL(url);
      });
    });

    downloadNetBtn.addEventListener('click', async () => {
      chrome.runtime.sendMessage({ type: 'get-network-logs' }, (response) => {
        const dataStr = JSON.stringify(response.logs, null, 2);
        const blob = new Blob([dataStr], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        
        const a = document.createElement('a');
        a.href = url;
        a.download = 'network-logs.json';
        a.click();
        URL.revokeObjectURL(url);
      });
    });

    const handleAssistantContent = (content, isInitial = false) => {
      let parsed = content;
      if (typeof content === 'string') {
        try {
          parsed = JSON.parse(content);
        } catch (err) {
          parsed = { type: 'chat', chat: content };
        }
      }
      if (parsed?.type === 'issue_update') {
        setDraft({ title: parsed.title, body: parsed.body }, isInitial ? 'Initial draft applied.' : 'Updated draft applied to GitHub form.');
        addMessage('assistant', `Updated issue:\nTitle: ${parsed.title}\nBody preview: ${parsed.body.slice(0, 200)}${parsed.body.length > 200 ? '…' : ''}`);
      } else {
        addMessage('assistant', parsed?.chat || 'Chat response.');
      }
    };

    handleAssistantContent(assistantContent, true);

    resetBtn.addEventListener('click', () => {
      setDraft(draft, 'Reset to initial draft and applied.');
      addMessage('assistant', 'Reset to initial draft.');
    });

    sendBtn.addEventListener('click', async () => {
      if (!chatArea.value.trim()) return;
      const prompt = chatArea.value.trim();
      addMessage('user', prompt);
      chatArea.value = '';
      sendBtn.disabled = true;
      sendBtn.textContent = 'Sending…';
      status.textContent = 'Calling LLM...';
      const response = await chrome.runtime.sendMessage({
        type: 'refine-draft',
        prompt
      });
      if (response?.ok) {
        handleAssistantContent(response.assistantContent);
      } else {
        status.textContent = `LLM failed: ${response?.error || 'unknown error'}`;
      }
      sendBtn.disabled = false;
      sendBtn.textContent = 'Send';
    });
  };

  const attachLogs = (logs, filename, statusText) => {
    if (!logs || logs.length === 0) return;

    // 1. Create the virtual file
    const jsonString = JSON.stringify(logs, null, 2);
    const blob = new Blob([jsonString], { type: 'application/json' });
    const file = new File([blob], filename, { type: 'application/json' });

    // 2. Prepare the DataTransfer
    const dt = new DataTransfer();
    dt.items.add(file);

    // 3. Find the drop target
    const { body: dropZone } = findFields();
    if (!dropZone) {
      console.error(`BugScribe: Could not find text area to drop ${filename}`);
      return;
    }

    // 4. Simulate drag & drop
    ['dragenter', 'dragover', 'drop'].forEach((eventType) => {
      const event = new DragEvent(eventType, {
        bubbles: true,
        cancelable: true,
        dataTransfer: dt
      });
      dropZone.dispatchEvent(event);
    });

    // 5. Update overlay status
    const status = document.querySelector('#bugscribe-overlay small');
    if (status) status.textContent = statusText;
  };

  const init = async () => {
    const response = await chrome.runtime.sendMessage({ type: 'issue-page-ready' });
    if (!response?.ok) return;
    createOverlay({
      draft: response.draft || { title: 'Bug report', body: 'Describe the issue...' },
      assistantContent: response.assistantContent,
      screenshots: response.screenshots || []
    });

    // --- THIS IS THE PART THAT TRIGGERS THE AUTOMATIC UPLOAD ---
    // Attach network logs
    chrome.runtime.sendMessage({ type: 'get-network-logs' }, (resp) => {
      if (resp?.logs) {
        attachLogs(resp.logs, 'network_logs.json', 'Network logs uploaded via drop...');
      }
    });

    // Attach console logs
    chrome.runtime.sendMessage({ type: 'get-console-logs' }, (resp) => {
      if (resp?.logs) {
        attachLogs(resp.logs, 'console_logs.json', 'Console logs uploaded via drop...');
      }
    });
    };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
