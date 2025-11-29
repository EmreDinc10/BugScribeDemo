(() => {
  const applyDraftToForm = (draft) => {
    const titleField = document.querySelector('#issue_title');
    const bodyField = document.querySelector('#issue_body');
    if (titleField) {
      titleField.value = draft?.title || '';
      titleField.dispatchEvent(new Event('input', { bubbles: true }));
      titleField.dispatchEvent(new Event('change', { bubbles: true }));
    }
    if (bodyField) {
      bodyField.value = draft?.body || '';
      bodyField.dispatchEvent(new Event('input', { bubbles: true }));
      bodyField.dispatchEvent(new Event('change', { bubbles: true }));
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
      applyDraftToForm(nextDraft);
      status.textContent = note || 'Draft applied to GitHub form.';
    };

    if (assistantContent) {
      addMessage('assistant', assistantContent);
    } else {
      addMessage('assistant', 'LLM draft applied to the GitHub form.');
    }
    setDraft(draft, 'Initial draft applied to GitHub form.');

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
        addMessage('assistant', response.assistantContent || 'Updated the draft.');
        setDraft(response.draft, 'Updated draft applied to GitHub form.');
      } else {
        status.textContent = `LLM failed: ${response?.error || 'unknown error'}`;
      }
      sendBtn.disabled = false;
      sendBtn.textContent = 'Send';
    });
  };

  const init = async () => {
    const response = await chrome.runtime.sendMessage({ type: 'issue-page-ready' });
    if (!response?.ok) return;
    createOverlay({
      draft: response.draft || { title: 'Bug report', body: 'Describe the issue...' },
      assistantContent: response.assistantContent,
      screenshots: response.screenshots || []
    });
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
