(() => {
  const createOverlay = ({ draft, screenshots }) => {
    const root = document.createElement('section');
    root.id = 'bugscribe-overlay';

    const header = document.createElement('header');
    header.textContent = 'BugScribe Issue Assistant';
    root.appendChild(header);

    const main = document.createElement('main');

    const titleLabel = document.createElement('label');
    titleLabel.textContent = 'Title';
    const titleInput = document.createElement('input');
    titleInput.value = draft?.title || '';
    main.appendChild(titleLabel);
    main.appendChild(titleInput);

    const bodyLabel = document.createElement('label');
    bodyLabel.textContent = 'Body';
    const bodyArea = document.createElement('textarea');
    bodyArea.rows = 10;
    bodyArea.value = draft?.body || '';
    main.appendChild(bodyLabel);
    main.appendChild(bodyArea);

    const chatLabel = document.createElement('label');
    chatLabel.textContent = 'Ask LLM to refine';
    const chatArea = document.createElement('textarea');
    chatArea.rows = 3;
    chatArea.placeholder = 'e.g., Emphasize payment failure and shorten network section';
    main.appendChild(chatLabel);
    main.appendChild(chatArea);

    const status = document.createElement('small');
    status.textContent = screenshots?.length
      ? `Recent screenshots downloaded: ${screenshots.map((s) => s.name).join(', ')}`
      : 'No screenshots captured yet.';
    main.appendChild(status);

    const buttons = document.createElement('div');
    buttons.className = 'row';
    const applyBtn = document.createElement('button');
    applyBtn.textContent = 'Apply to form';
    const refineBtn = document.createElement('button');
    refineBtn.textContent = 'Ask LLM';
    buttons.append(applyBtn, refineBtn);
    main.appendChild(buttons);

    const resetBtn = document.createElement('button');
    resetBtn.textContent = 'Reset to draft';
    main.appendChild(resetBtn);

    root.appendChild(main);
    document.body.appendChild(root);

    const applyToForm = () => {
      const titleField = document.querySelector('#issue_title');
      const bodyField = document.querySelector('#issue_body');
      if (titleField) titleField.value = titleInput.value;
      if (bodyField) bodyField.value = bodyArea.value;
      status.textContent = 'Applied to GitHub form.';
    };

    applyBtn.addEventListener('click', applyToForm);
    resetBtn.addEventListener('click', () => {
      titleInput.value = draft?.title || '';
      bodyArea.value = draft?.body || '';
      status.textContent = 'Reset to last draft.';
    });
    refineBtn.addEventListener('click', async () => {
      if (!chatArea.value.trim()) return;
      refineBtn.disabled = true;
      refineBtn.textContent = 'Refining…';
      status.textContent = 'Calling LLM...';
      const response = await chrome.runtime.sendMessage({
        type: 'refine-draft',
        prompt: `${chatArea.value}\n\nCurrent draft:\n${bodyArea.value}`
      });
      if (response?.ok) {
        titleInput.value = response.draft.title || titleInput.value;
        bodyArea.value = response.draft.body || bodyArea.value;
        status.textContent = 'Updated from LLM. Apply to form when ready.';
      } else {
        status.textContent = `LLM failed: ${response?.error || 'unknown error'}`;
      }
      refineBtn.disabled = false;
      refineBtn.textContent = 'Ask LLM';
    });

    // Apply immediately on load to keep form synced.
    applyToForm();
  };

  const init = async () => {
    const response = await chrome.runtime.sendMessage({ type: 'issue-page-ready' });
    if (!response?.ok) return;
    createOverlay({
      draft: response.draft || { title: 'Bug report', body: 'Describe the issue...' },
      screenshots: response.screenshots || []
    });
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
