(() => {
  const host = acquireVsCodeApi();
  const get = id => document.getElementById(id);
  const send = message => host.postMessage(message);
  const draft = host.getState() ?? {};
  let selectedAgent = draft.agent ?? (draft.mode === 'edit' ? 'build' : 'understand');
  let state, pending, nextAgent;
  let started = false;
  get('prompt').value = typeof draft.prompt === 'string' ? draft.prompt : '';
  const defaults = {
    understand: 'Analyze the saved project code, starting with the active file when included. Read relevant files and tests. Return a concise report with headings Findings, Next change, and Checks. Cite file paths, distinguish evidence from uncertainty, and do not claim tests ran. Do not edit files.',
    review: 'Review the saved Git diff and relevant files for bugs, regressions, and missing tests. Return concise Findings and Checks with file paths. If there is no diff, say so. Do not edit files or approve the work.',
  };
  const labels = { understand: 'Analysis', plan: 'Plan', build: 'Build notes', review: 'Code review', test: 'Test assessment' };
  const actions = { understand: 'Analyze code', plan: 'Create plan', build: 'Propose changes', review: 'Review changes', test: 'Assess tests' };
  function save() { host.setState({ prompt: get('prompt').value, agent: selectedAgent }); }
  function chooseAgent(id) {
    if (!state || state.busy || state.proposal || !state.agents.some(agent => agent.id === id)) return;
    // A mode change preserves the developer's draft and never starts a model request.
    selectedAgent = id; save(); renderMode();
  }
  function renderMode() {
    if (!state?.agents.length) return;
    const agent = state.agents.find(item => item.id === selectedAgent) ?? state.agents[0];
    selectedAgent = agent.id;
    const locked = Boolean(state.busy || state.proposal);
    const available = state.trusted && state.folderIndex >= 0;
    for (const button of get('stages').children) {
      button.setAttribute('aria-pressed', String(button.dataset.agent === selectedAgent));
      button.disabled = locked || !available;
    }
    get('agent-select').value = selectedAgent;
    get('agent-select').disabled = locked || !available;
    get('agent-purpose').textContent = agent.purpose;
    get('request-label').textContent = agent.mode === 'edit' ? 'What should change?' : 'Focus (optional)';
    get('prompt').placeholder = agent.mode === 'edit' ? 'Describe the change to build…' : 'A file, a bug, or something to investigate…';
    get('mode-help').textContent = state.proposal ? 'Review pending edits first' : agent.mode === 'edit' ? 'Edits require your review' : 'Read only';
    get('mode-help').hidden = !state.guided && !state.proposal;
    get('send').textContent = state.busy ? 'Working…' : actions[selectedAgent];
    get('send').disabled = locked || !available || (agent.mode === 'edit' && !get('prompt').value.trim());
    get('empty-title').textContent = agent.mode === 'edit' ? 'Build a focused change.' : selectedAgent === 'review' ? 'Check the changes.' : 'Understand the code.';
    get('empty-help').textContent = agent.mode === 'edit' ? 'Describe it above. Review the diff here.' : selectedAgent === 'review' ? 'Find bugs and missing tests in your saved diff.' : 'Find issues. Choose what to build next.';
    get('empty-help').hidden = !state.guided;
    get('next-agent').hidden = !nextAgent || locked || state.messages.at(-1)?.role === 'error';
    get('retry').disabled = locked || !available;
  }
  // Model output stays text. A small formatting subset makes code readable without allowing HTML or active links.
  function inlineText(element, value) {
    for (const part of value.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/g)) {
      if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
        const code = document.createElement('code'); code.textContent = part.slice(1, -1); element.append(code);
      } else if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
        const strong = document.createElement('strong'); strong.textContent = part.slice(2, -2); element.append(strong);
      } else element.append(document.createTextNode(part));
    }
  }
  function responseText(value) {
    const body = document.createElement('div');
    let code, paragraph, list;
    for (const line of value.split('\n')) {
      if (/^\s*```/.test(line)) {
        if (code) code = undefined;
        else { const pre = document.createElement('pre'); code = document.createElement('code'); pre.append(code); body.append(pre); }
        paragraph = undefined; list = undefined; continue;
      }
      if (code) { code.textContent += line + '\n'; continue; }
      if (!line.trim()) { paragraph = undefined; list = undefined; continue; }
      const heading = line.match(/^#{1,6}\s+(.+)/);
      const item = line.match(/^\s*(?:([-*])|\d+\.)\s+(.+)/);
      if (heading) { const h = document.createElement('h3'); inlineText(h, heading[1]); body.append(h); paragraph = undefined; list = undefined; }
      else if (item) {
        const tag = item[1] ? 'ul' : 'ol';
        if (!list || list.localName !== tag) { list = document.createElement(tag); body.append(list); }
        const li = document.createElement('li'); inlineText(li, item[2]); list.append(li); paragraph = undefined;
      } else {
        if (!paragraph) { paragraph = document.createElement('p'); body.append(paragraph); } else paragraph.append(document.createTextNode('\n'));
        inlineText(paragraph, line); list = undefined;
      }
    }
    return body;
  }
  function renderTasks() {
    const outcomes = state.taskOutcomes ?? [];
    get('checks').hidden = !state.messages.length && !outcomes.length;
    get('no-checks').hidden = outcomes.length > 0;
    get('task-note').hidden = outcomes.length === 0;
    get('analyze-task').hidden = outcomes.length === 0;
    get('task-outcomes').replaceChildren();
    for (const outcome of outcomes) {
      const row = document.createElement('div'); row.className = 'task-result';
      const title = document.createElement('strong'); title.textContent = outcome.label;
      const result = document.createElement('span');
      result.textContent = outcome.status === 'exited' ? `Exited ${outcome.exitCode}` : outcome.status === 'launch-error' ? 'Could not start' : outcome.status === 'unknown' ? 'Exit unknown' : outcome.status === 'starting' ? 'Starting…' : 'Running…';
      if (outcome.exitCode !== null && outcome.exitCode !== 0) result.className = 'task-failed';
      const time = document.createElement('small');
      time.textContent = new Date(outcome.startedAt).toLocaleTimeString() + (outcome.durationMs === null ? '' : ` · ${(outcome.durationMs / 1000).toFixed(1)}s`);
      row.append(title, result, time); get('task-outcomes').append(row);
    }
    get('task').textContent = state.taskRunning ? 'Running…' : 'Run checks…';
    get('task').disabled = state.busy || state.taskRunning || !state.trusted || state.folderIndex < 0;
    get('analyze-task').disabled = state.busy || Boolean(state.proposal) || state.taskRunning || !state.trusted || state.folderIndex < 0;
  }
  function renderResults() {
    const lastIndex = state.messages.findLastIndex(message => message.role !== 'user');
    const last = state.messages[lastIndex];
    get('empty').hidden = state.busy || Boolean(last) || Boolean(state.proposal);
    get('result').hidden = state.busy || !last;
    get('result-body').replaceChildren();
    get('retry').hidden = last?.role !== 'error';
    nextAgent = undefined;
    if (last) {
      get('result-title').textContent = last.role === 'error' ? 'Needs attention' : labels[last.agent] ?? 'Activity';
      get('result-note').textContent = last.role === 'error' ? 'Request stopped' : last.worker ? `${last.worker} · verify` : last.agent ? 'AI findings · verify' : '';
      get('result-body').append(responseText(last.text));
      if (last.role === 'assistant' && last.agent) {
        nextAgent = { understand: 'build', plan: 'build', build: 'review', review: 'test', test: 'build' }[last.agent];
        get('next-agent').textContent = nextAgent === 'build' ? 'Build from findings' : nextAgent === 'review' ? 'Review saved changes' : 'Assess tests';
      }
    }
    get('messages').replaceChildren();
    const history = state.messages.filter((_, index) => index !== lastIndex);
    get('history').hidden = !history.length;
    get('history-label').textContent = `Task history (${history.length})`;
    for (const message of history) {
      const article = document.createElement('article');
      const label = document.createElement('strong');
      label.textContent = message.role === 'user' ? 'Request' : message.role === 'error' ? 'Stopped' : (labels[message.agent] ?? 'Activity') + (message.worker ? ` · ${message.worker}` : '');
      const body = responseText(message.text); body.className = 'report';
      article.append(label, body); get('messages').append(article);
    }
  }
  function renderProposal() {
    get('proposal').hidden = !state.proposal;
    get('composer').hidden = Boolean(state.proposal);
    get('files').replaceChildren();
    if (!state.proposal) return;
    const files = state.proposal.files;
    get('file-count').textContent = `${files.length} ${files.length === 1 ? 'file' : 'files'}`;
    for (const file of files) {
      const button = document.createElement('button');
      const path = document.createElement('span'); path.textContent = file.path;
      const status = document.createElement('small'); status.textContent = file.reviewed ? '✓ Reviewed' : file.added ? 'New · Open diff' : 'Open diff';
      button.append(path, status); button.disabled = state.busy || !state.trusted || state.folderIndex < 0;
      button.addEventListener('click', () => send({ type: 'diff', id: state.proposal.id, index: file.index }));
      get('files').append(button);
    }
    const remaining = files.filter(file => !file.reviewed).length;
    get('review-count').textContent = remaining ? `Open ${remaining} ${remaining === 1 ? 'diff' : 'diffs'} before applying.` : 'Diffs reviewed. Apply when ready.';
    get('apply').disabled = state.busy || !state.trusted || state.folderIndex < 0 || remaining > 0;
    get('discard').disabled = state.busy;
  }
  for (const button of get('stages').children) button.addEventListener('click', () => chooseAgent(button.dataset.agent));
  get('agent-select').addEventListener('change', () => chooseAgent(get('agent-select').value));
  get('prompt').addEventListener('input', () => { save(); renderMode(); });
  get('composer').addEventListener('submit', event => {
    event.preventDefault();
    if (!state || state.busy || state.proposal || !state.trusted || state.folderIndex < 0) return;
    const agent = state.agents.find(item => item.id === selectedAgent);
    if (!agent || (agent.mode === 'edit' && !get('prompt').value.trim())) return;
    const text = get('prompt').value.trim() || defaults[selectedAgent] || agent.starter;
    pending = { text, draft: get('prompt').value }; started = false;
    send({ type: 'ask', prompt: text, agent: selectedAgent, mode: agent.mode, includeContext: get('include').checked });
  });
  get('next-agent').addEventListener('click', () => {
    if (!nextAgent || state.busy || state.proposal) return;
    const next = nextAgent; chooseAgent(next);
    if (!get('prompt').value.trim()) get('prompt').value = next === 'build' ? 'Propose the smallest change for the findings above. Read the relevant files first and preserve unrelated behavior.' : defaults[next] ?? state.agents.find(agent => agent.id === next).starter;
    save(); renderMode(); get('prompt').focus();
  });
  get('retry').addEventListener('click', () => {
    if (state.busy || state.proposal) return;
    const request = state.messages.findLast(message => message.role === 'user');
    if (!request) return;
    if (request.agent) chooseAgent(request.agent);
    get('prompt').value = request.text; save(); renderMode(); get('prompt').focus();
  });
  get('analyze-task').addEventListener('click', () => {
    if (!state || state.busy || state.proposal || state.taskRunning || !state.trusted || state.folderIndex < 0) return;
    chooseAgent('test');
    if (!get('prompt').value.trim()) get('prompt').value = 'Investigate the host-recorded task outcomes against saved code. Give concise findings and next checks. Ask for missing terminal output; historical exit codes do not verify current code.';
    save(); renderMode(); get('prompt').focus();
  });
  function clearDraft() {
    selectedAgent = 'understand'; pending = undefined; started = false; get('prompt').value = '';
    get('history').open = false; save(); renderMode();
  }
  get('new').addEventListener('click', () => { clearDraft(); send({ type: 'new' }); });
  get('folder').addEventListener('change', () => { clearDraft(); send({ type: 'folder', index: Number(get('folder').value) }); });
  get('open-file').addEventListener('click', () => send({ type: 'openFile' }));
  for (const type of ['stop', 'task', 'settings']) get(type).addEventListener('click', () => send({ type }));
  for (const type of ['apply', 'discard']) get(type).addEventListener('click', () => send({ type, id: state?.proposal?.id }));
  get('guided').addEventListener('change', () => send({ type: 'guided', value: get('guided').checked }));
  get('worker').addEventListener('change', () => send({ type: 'assistant', id: get('worker').value }));
  get('refresh-assistants').addEventListener('click', () => send({ type: 'refreshAssistants' }));
  get('learn-now').addEventListener('click', () => send({ type: 'learnNow' }));
  function renderWorker() {
    const select = get('worker');
    select.replaceChildren();
    const local = document.createElement('option'); local.value = ''; local.textContent = `Local model · ${state.model}`; select.append(local);
    for (const assistant of state.assistants ?? []) {
      const option = document.createElement('option');
      option.value = assistant.id; option.disabled = !assistant.usable;
      option.textContent = `${assistant.name} · ${assistant.release} ${assistant.project}${assistant.usable ? '' : ' · cannot work'}`;
      if (!assistant.usable) option.title = assistant.reason;
      select.append(option);
    }
    const chosen = (state.assistants ?? []).find(item => item.id === state.assistantId);
    select.value = chosen?.usable ? chosen.id : '';
    select.disabled = state.busy || Boolean(state.proposal);
    const status = state.workbench?.status;
    get('worker-note').textContent = chosen ? (chosen.usable ? 'Approved assistant' : `Cannot work: ${chosen.reason}`)
      : status === 'ok' ? ((state.assistants ?? []).some(item => item.usable) ? 'Pick an approved assistant' : 'No assistant can work yet')
      : status === 'checking' ? 'Reaching the workbench…' : status === 'error' ? 'Workbench unavailable' : '';
    get('worker-note').className = 'muted' + (status === 'error' || (chosen && !chosen.usable) ? ' task-failed' : '');
    get('workbench-note').textContent = status === 'off' ? state.workbench.message : `Workbench · ${state.workbench?.message ?? ''}`;
    get('refresh-assistants').disabled = state.busy;
    // The chosen assistant's learning: rhythm, last cycle, and a way to run one now.
    const learning = state.learning;
    get('learning').hidden = !chosen?.usable || !learning;
    if (chosen?.usable && learning) {
      const cadence = { manual: 'on request', daily: 'every day', weekly: 'every week' };
      const rhythm = learning.error ? learning.error : !learning.schedule ? 'No learning schedule yet' : learning.schedule.paused ? 'Learning paused' : `Learns ${cadence[learning.schedule.cadence] ?? learning.schedule.cadence}`;
      const last = learning.last ? ` · last cycle ${learning.last.status}: ${learning.last.summary}` : '';
      get('learning-note').textContent = rhythm + last;
      get('learning-note').title = get('learning-note').textContent;
      get('learn-now').disabled = state.busy || Boolean(learning.error) || !learning.schedule || learning.schedule.paused;
    }
  }
  window.addEventListener('message', event => {
    if (event.data?.type !== 'state') return;
    state = event.data;
    if (state.busy && state.requestAgent) selectedAgent = state.requestAgent;
    if (pending && state.busy) started = true;
    if (pending && started && !state.busy) {
      // Failed default actions become editable; successful ones leave a clean next request.
      if (get('prompt').value === pending.draft) get('prompt').value = state.messages.at(-1)?.role === 'error' ? pending.text : '';
      pending = undefined; started = false; save();
    }
    const available = state.trusted && state.folderIndex >= 0;
    get('version').textContent = `v${state.version ?? 'dev'}`;
    get('version').title = `Running v${state.version ?? 'dev'}`;
    get('project-name').textContent = state.folders[state.folderIndex] ?? 'Open a repository';
    get('project-name').title = get('project-name').textContent;
    get('open-file').textContent = state.activeFile || 'No active file';
    get('open-file').title = state.activeFile || 'Open a file in the editor';
    get('open-file').disabled = !available || !state.activeFile || state.busy;
    get('trust').hidden = available;
    get('new').disabled = state.busy || Boolean(state.proposal);
    get('prompt').disabled = state.busy || Boolean(state.proposal);
    get('include').disabled = state.busy || Boolean(state.proposal);
    get('guided').checked = state.guided;
    get('folder').replaceChildren();
    state.folders.forEach((name, index) => {
      const option = document.createElement('option'); option.value = String(index); option.textContent = name; option.selected = index === state.folderIndex; get('folder').append(option);
    });
    get('folder').disabled = state.busy || Boolean(state.proposal) || state.folders.length < 2;
    get('agent-select').replaceChildren();
    state.agents.forEach(agent => {
      const option = document.createElement('option'); option.value = agent.id; option.textContent = agent.name; get('agent-select').append(option);
    });
    get('connection').textContent = `Ollama · ${state.model}`;
    get('code-preview').hidden = !state.activeCode;
    get('active-code').textContent = state.activeCode || '';
    get('working').hidden = !state.busy;
    get('stop').disabled = Boolean(state.applying);
    get('progress').textContent = state.applying ? 'Applying edits…' : state.progress.startsWith('MCP tool:') ? 'Reading saved code…' : state.progress.startsWith('Model call') ? 'Analyzing…' : state.progress || 'Working…';
    renderResults(); renderProposal(); renderTasks(); renderMode(); renderWorker();
  });
  send({ type: 'ready' });
})();
