import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { relative, isAbsolute, sep } from 'node:path';
import { readFileSync } from 'node:fs';
import { EDITOR_AGENTS, editorAgentSchema } from '../../workbench/editor-agents.js';
import { EditorTaskHistory } from '../../workbench/editor-tasks.js';
import { readProjectFile } from '../../workbench/bot-project.js';
import { runEditorRequest, editorOllamaModel, validateEditorProposal, editorFilePath } from '../../workbench/editor-session.js';
import { getWorkbenchAssistant, getWorkbenchLearning, listWorkbenchAssistants, readWorkbenchToken, runWorkbenchLearning, workbenchTokenFile } from '../../workbench/editor-assistants.js';

export function activate(context) {
  const provider = new CodingView(context);
  context.subscriptions.push(provider,
    vscode.window.registerWebviewViewProvider('magentic.workspace', provider, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.workspace.registerTextDocumentContentProvider('magentic-proposal', { provideTextDocumentContent(uri) { return provider.diffContent.get(uri.toString()) ?? ''; } }),
    vscode.commands.registerCommand('magentic.open', () => vscode.commands.executeCommand('magentic.workspace.focus')),
    vscode.commands.registerCommand('magentic.explainSelection', () => provider.fromEditor('ask', 'Explain this selected code and how it fits into the project.')),
    vscode.commands.registerCommand('magentic.proposeEdit', () => provider.fromEditor('edit')),
    vscode.workspace.onDidChangeWorkspaceFolders(() => provider.changeFolder(0)),
    vscode.window.onDidChangeActiveTextEditor(() => provider.send()),
    vscode.workspace.onDidGrantWorkspaceTrust(() => provider.send()));
}

class CodingView {
  constructor(context) {
    this.context = context;
    this.taskHistory = new EditorTaskHistory(vscode.tasks, () => this.send());
    this.diffContent = new Map();
    this.controller = undefined;
    this.proposal = undefined;
    this.reviewed = new Set();
    this.messages = [];
    this.progress = '';
    this.folder = vscode.workspace.workspaceFolders?.[0];
    // Assistants come from the local workbench. Which one is chosen is remembered per machine.
    this.assistants = [];
    this.workbench = { status: 'off', message: '' };
    // How the chosen assistant keeps learning, read from the workbench with the assistants.
    this.learning = null;
    this.assistantId = this.context.globalState.get('magentic.assistant', '');
    this.restore();
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => { if (event.affectsConfiguration('magentic.workbenchUrl') || event.affectsConfiguration('magentic.workbenchTokenFile')) void this.refreshAssistants(); }));
  }
  workbenchSettings() {
    const configuration = vscode.workspace.getConfiguration('magentic');
    const url = String(configuration.get('workbenchUrl', '') ?? '').trim();
    const tokenFile = String(configuration.get('workbenchTokenFile', '') ?? '').trim() || workbenchTokenFile();
    return { url, tokenFile };
  }
  /** Ask the workbench which assistants can work. Never throws: the panel shows the reason instead. */
  async refreshAssistants() {
    const { url, tokenFile } = this.workbenchSettings();
    if (!url) { this.assistants = []; this.workbench = { status: 'off', message: 'Set magentic.workbenchUrl to use approved assistants.' }; this.send(); return; }
    this.workbench = { status: 'checking', message: 'Reaching the workbench…' }; this.send();
    try {
      const token = await readWorkbenchToken(tokenFile);
      this.assistants = await listWorkbenchAssistants(url, token);
      this.workbench = { status: 'ok', message: `${this.assistants.filter(item => item.usable).length} of ${this.assistants.length} assistants can work` };
      await this.refreshLearning(url, token);
    } catch (error) {
      this.assistants = []; this.workbench = { status: 'error', message: error instanceof Error ? error.message : 'The workbench could not be reached.' };
    }
    this.send();
  }
  /** The chosen assistant's learning schedule and last cycle, or null when there is none to show. */
  async refreshLearning(url, token) {
    const chosen = this.assistants.find(item => item.id === this.assistantId);
    if (!chosen?.projectId) { this.learning = null; return; }
    try {
      const status = await getWorkbenchLearning(url, token, chosen.projectId);
      const schedule = status.schedules.find(item => item.projectId === chosen.projectId) ?? null;
      const last = status.runs.filter(item => item.projectId === chosen.projectId).at(-1) ?? null;
      this.learning = { projectId: chosen.projectId, project: chosen.project, schedule, last };
    } catch (error) {
      this.learning = { projectId: chosen.projectId, project: chosen.project, schedule: null, last: null, error: error instanceof Error ? error.message : 'Could not read the learning schedule.' };
    }
  }
  /** Ask the workbench to run one learning cycle for the chosen assistant's project. Its answer is shown as a message. */
  async learnNow() {
    if (this.controller) throw new Error('Wait for the current request to finish first.');
    const chosen = this.assistants.find(item => item.id === this.assistantId);
    if (!chosen?.projectId) throw new Error('Choose an approved assistant first; the local model has no learning schedule.');
    const { url, tokenFile } = this.workbenchSettings();
    const token = await readWorkbenchToken(tokenFile);
    const run = await runWorkbenchLearning(url, token, chosen.projectId);
    await this.refreshLearning(url, token);
    this.messages.push({ role: 'assistant', text: `Learning cycle for ${chosen.project}: ${run.status}. ${run.summary}` });
    await this.persist(); this.send();
  }
  /** The binding for the chosen assistant, taken fresh, or undefined for the plain local model. */
  async chosenAssistant() {
    if (!this.assistantId) return undefined;
    const { url, tokenFile } = this.workbenchSettings();
    if (!url) throw new Error('The chosen assistant needs magentic.workbenchUrl. Set it or choose the local model.');
    const binding = await getWorkbenchAssistant(url, await readWorkbenchToken(tokenFile), this.assistantId);
    return binding;
  }
  dispose() { this.view = undefined; this.controller?.abort(); this.taskHistory.dispose(); this.diffContent.clear(); }
  restore() {
    const saved = this.context.workspaceState.get(this.historyKey(), []);
    this.messages = Array.isArray(saved) ? saved.filter(item => ['user', 'assistant', 'error'].includes(item?.role) && typeof item.text === 'string').slice(-30).map(item => ({ role: item.role, text: item.text.slice(0, 6000), ...(editorAgentSchema.safeParse(item.agent).success ? { agent: item.agent } : {}), ...(typeof item.worker === 'string' ? { worker: item.worker.slice(0, 200) } : {}) })) : [];
  }
  historyKey() { return 'magentic.chat.' + (this.folder?.uri.toString() ?? 'none'); }
  async persist() { await this.context.workspaceState.update(this.historyKey(), this.messages.slice(-30)); }
  changeFolder(index) {
    if (!Number.isInteger(index) || index < 0) return;
    this.controller?.abort(); this.controller = undefined;
    this.folder = vscode.workspace.workspaceFolders?.[index];
    this.proposal = undefined; this.reviewed.clear(); this.diffContent.clear(); this.progress = '';
    this.restore(); this.send();
  }
  guard() {
    if (!vscode.workspace.isTrusted) throw new Error('Trust this folder in VS Code before using repository tools or running tasks.');
    if (!this.folder || this.folder.uri.scheme !== 'file' || !vscode.workspace.workspaceFolders?.some(folder => folder.uri.toString() === this.folder.uri.toString()))
      throw new Error('Open a local Git repository folder in VS Code first.');
    return this.folder.uri.fsPath;
  }
  activeContext() {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== 'file' || !this.folder) return undefined;
    const path = relative(this.folder.uri.fsPath, editor.document.uri.fsPath);
    if (!path || isAbsolute(path) || path === '..' || path.startsWith('..' + sep)) return undefined;
    const name = path.split(sep).join('/');
    try { editorFilePath(this.folder.uri.fsPath, name); } catch { return undefined; }
    return { path: name, selection: editor.document.getText(editor.selection).slice(0, 6000) };
  }
  resolveWebviewView(view) {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')] };
    const nonce = randomBytes(24).toString('hex');
    const asset = name => view.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', name));
    view.webview.html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${view.webview.cspSource}; script-src 'nonce-${nonce}';"><link rel="stylesheet" href="${asset('panel.css')}"></head><body>${readFileSync(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'panel.html').fsPath, 'utf8')}<script nonce="${nonce}" src="${asset('panel.js')}"></script></body></html>`;
    view.webview.onDidReceiveMessage(message => { void this.receive(message).catch(error => this.error(error)); }, undefined, this.context.subscriptions);
    this.send();
    void this.refreshAssistants();
  }
  send() {
    if (!this.view) return;
    const folders = vscode.workspace.workspaceFolders ?? [];
    const active = vscode.workspace.isTrusted ? this.activeContext() : undefined;
    let activeCode = '';
    if (active) {
      try { activeCode = (readProjectFile(this.folder.uri.fsPath, active.path) ?? '').split('\n').slice(0, 18).join('\n').slice(0, 1600); }
      catch { /* A missing or protected file must not stop the panel from opening. */ }
    }
    void this.view.webview.postMessage({ type: 'state', version: this.context.extension?.packageJSON.version ?? 'development', trusted: vscode.workspace.isTrusted,
      agents: Object.entries(EDITOR_AGENTS).map(([id, agent]) => ({ id, label: agent.label, name: agent.name, purpose: agent.purpose, mode: agent.mode, starter: agent.starter, action: agent.action, next: agent.next })),
      requestAgent: this.requestAgent ?? null, activeCode,
      taskRunning: this.taskHistory.busy, taskOutcomes: this.taskHistory.snapshot(this.folder?.uri.toString() ?? 'none'),
      folders: folders.map(folder => folder.name), folderIndex: folders.findIndex(folder => folder.uri.toString() === this.folder?.uri.toString()),
      guided: vscode.workspace.getConfiguration('magentic').get('guided', true), model: vscode.workspace.getConfiguration('magentic').get('model', 'qwen2.5-coder:7b'),
      assistants: this.assistants, assistantId: this.assistantId, workbench: this.workbench, learning: this.learning,
      messages: this.messages.slice(-30), busy: Boolean(this.controller || this.applying), applying: Boolean(this.applying), progress: this.progress,
      activeFile: active?.path ?? '', proposal: this.proposal ? { id: this.proposal.id, files: this.proposal.changes.map((change, index) => ({ index, path: change.path, reviewed: this.reviewed.has(index), added: change.before === null })) } : null });
  }
  error(error) {
    this.messages.push({ role: 'error', text: error instanceof Error ? error.message : 'The operation could not finish.' });
    this.send(); void this.persist();
  }
  async fromEditor(mode, prompt) {
    await vscode.commands.executeCommand('magentic.workspace.focus');
    if (!prompt) prompt = await vscode.window.showInputBox({ title: 'Magentic: propose a code change', prompt: 'Describe the result you want. Changes will be proposed for review.', ignoreFocusOut: true });
    if (prompt) { try { await this.ask({ mode, prompt, includeContext: true }); } catch (error) { this.error(error); } }
  }
  async receive(message) {
    if (!message || typeof message.type !== 'string') return;
    if (message.type === 'ready') return this.send();
    if (message.type === 'stop') { this.controller?.abort(); return; }
    if (this.applying) return;
    if (message.type === 'folder') { if (!this.controller && Number.isInteger(message.index)) this.changeFolder(message.index); return; }
    if (message.type === 'new') {
      this.controller?.abort(); this.controller = undefined; this.messages = []; this.proposal = undefined;
      this.reviewed.clear(); this.diffContent.clear(); this.progress = ''; await this.persist(); this.send(); return;
    }
    if (message.type === 'openFile') {
      this.guard();
      const active = this.activeContext();
      if (active) await vscode.window.showTextDocument(vscode.Uri.file(editorFilePath(this.folder.uri.fsPath, active.path)), { preview: true });
      return;
    }
    if (message.type === 'settings') return vscode.commands.executeCommand('workbench.action.openSettings', 'magentic');
    if (message.type === 'refreshAssistants') return this.refreshAssistants();
    if (message.type === 'assistant' && typeof message.id === 'string') {
      if (this.controller) return;
      // Only an assistant the workbench listed as usable can be chosen; the empty id is the local model.
      if (message.id && !this.assistants.some(item => item.id === message.id && item.usable)) throw new Error('That assistant cannot work right now. Refresh the list or choose another.');
      this.assistantId = message.id; await this.context.globalState.update('magentic.assistant', message.id); this.send();
      const { url, tokenFile } = this.workbenchSettings();
      if (url && message.id) { try { await this.refreshLearning(url, await readWorkbenchToken(tokenFile)); } catch { this.learning = null; } } else this.learning = null;
      this.send(); return;
    }
    if (message.type === 'learnNow') return this.learnNow();
    if (message.type === 'guided' && typeof message.value === 'boolean') {
      await vscode.workspace.getConfiguration('magentic').update('guided', message.value, vscode.ConfigurationTarget.Global); this.send(); return;
    }
    if (this.controller) return;
    if (message.type === 'ask') return this.ask(message);
    if (message.type === 'diff') return this.diff(message.id, message.index);
    if (message.type === 'apply') return this.apply(message.id);
    if (message.type === 'discard' && message.id === this.proposal?.id) { this.proposal = undefined; this.reviewed.clear(); this.diffContent.clear(); this.send(); return; }
    if (message.type === 'task') return this.runTask();
  }
  async ask(message) {
    if (this.controller || this.applying) throw new Error('Wait for the current operation or stop it first.');
    const root = this.guard();
    if (this.proposal) throw new Error('Apply or discard the current proposal before starting another agent request.');
    if (!['ask', 'edit'].includes(message.mode) || typeof message.prompt !== 'string' || !message.prompt.trim() || message.prompt.length > 4000) throw new Error('Enter a question or edit request of at most 4000 characters.');
    const agent = editorAgentSchema.parse(message.agent ?? (message.mode === 'edit' ? 'build' : 'understand'));
    if (EDITOR_AGENTS[agent].mode !== message.mode) throw new Error('The selected agent does not allow this mode.');
    const input = this.activeContext();
    const history = this.messages.filter(item => item.role === 'user' || item.role === 'assistant').slice(-6).map(item => ({ role: item.role, content: item.text.slice(0, 3000), ...(item.agent ? { agent: item.agent } : {}) }));
    const controller = new AbortController(); this.controller = controller; this.requestAgent = agent;
    const timer = setTimeout(() => controller.abort(), 300000);
    this.messages.push({ role: 'user', agent, text: message.prompt });
    this.proposal = undefined; this.reviewed.clear(); this.diffContent.clear();
    this.progress = this.assistantId ? 'Checking the assistant with the workbench…' : 'Reading saved repository files…'; this.send();
    try {
      // The binding is taken now, not when the assistant was chosen, so a release retired since then stops the request here.
      const unit = await this.chosenAssistant();
      if (this.controller !== controller) return;
      const modelName = unit ? unit.model : vscode.workspace.getConfiguration('magentic').get('model', 'qwen2.5-coder:7b');
      this.progress = 'Reading saved repository files…'; this.send();
      const result = await runEditorRequest(root, { prompt: message.prompt, mode: message.mode, agent, history, ...(unit ? { assistant: unit } : {}),
        ...(message.includeContext && input ? { context: input } : {}) }, editorOllamaModel(modelName, fetch, vscode.workspace.getConfiguration('magentic').get('modelUrl', '')), modelName, controller.signal,
      detail => { if (this.controller === controller) { this.progress = detail; this.send(); } },
        this.taskHistory.snapshot(this.folder.uri.toString()));
      if (this.controller !== controller) return;
      this.messages.push({ role: 'assistant', agent, text: result.summary, ...(unit ? { worker: `${unit.name} · ${unit.release}` } : {}) });
      if (result.changes.length) this.proposal = result;
    } catch (error) {
      if (this.controller !== controller) return;
      this.messages.push({ role: 'error', agent, text: controller.signal.aborted ? 'Request stopped. No file changes were applied.' : error.message });
    } finally {
      clearTimeout(timer);
      if (this.controller === controller) { this.controller = undefined; this.progress = ''; await this.persist(); this.send(); }
    }
  }
  async diff(id, index) {
    this.guard();
    const proposal = this.proposal;
    if (!proposal || id !== proposal.id || !Number.isInteger(index) || !proposal.changes[index]) throw new Error('That proposal is no longer available.');
    validateEditorProposal(proposal);
    const change = proposal.changes[index];
    const before = vscode.Uri.from({ scheme: 'magentic-proposal', path: `/${proposal.id}/${index}/before/${change.path}` });
    const after = vscode.Uri.from({ scheme: 'magentic-proposal', path: `/${proposal.id}/${index}/after/${change.path}` });
    this.diffContent.set(before.toString(), change.before ?? ''); this.diffContent.set(after.toString(), change.after);
    await vscode.commands.executeCommand('vscode.diff', before, after, `${change.path} — Magentic proposal`, { preview: true });
    if (this.proposal === proposal) { this.reviewed.add(index); this.send(); }
  }
  async apply(id) {
    this.guard();
    const folder = this.folder;
    const proposal = this.proposal;
    if (!proposal || proposal.id !== id) throw new Error('That proposal is no longer available.');
    if (proposal.changes.some((_, index) => !this.reviewed.has(index))) throw new Error('Open each proposed diff before applying changes.');
    this.applying = true; this.send();
    try {
      validateEditorProposal(proposal);
      const documents = [];
      const edit = new vscode.WorkspaceEdit();
      for (const change of proposal.changes) {
        const uri = vscode.Uri.file(editorFilePath(proposal.root, change.path));
        if (change.before === null) {
          if (vscode.workspace.textDocuments.some(doc => doc.uri.toString() === uri.toString())) throw new Error(`${change.path} is already open. Close it and request a new proposal.`);
          edit.createFile(uri, { overwrite: false, ignoreIfExists: false }); edit.insert(uri, new vscode.Position(0, 0), change.after);
        } else {
          const doc = await vscode.workspace.openTextDocument(uri);
          if (doc.isDirty || doc.getText() !== change.before) throw new Error(`${change.path} has changed or has unsaved edits. Save it and request a fresh proposal.`);
          documents.push({ doc, version: doc.version, before: change.before });
          edit.replace(uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), change.after);
        }
      }
      validateEditorProposal(proposal);
      if (documents.some(({ doc, version, before }) => doc.isDirty || doc.version !== version || doc.getText() !== before)) throw new Error('An editor changed during review. Request a fresh proposal.');
      if (folder !== this.folder || !vscode.workspace.isTrusted) throw new Error('Workspace access changed. Reopen the proposal in the correct trusted folder.');
      if (!await vscode.workspace.applyEdit(edit, { isRefactoring: false })) throw new Error('VS Code could not apply this edit. Inspect the files before retrying.');
      this.proposal = undefined;
      this.messages.push({ role: 'assistant', text: 'Changes applied in your editor. Review and save the files before running checks. Use VS Code Undo to revert. Nothing was committed or deployed.' });
      await this.persist();
    } finally { this.applying = false; this.send(); }
  }
  async runTask() {
    this.guard();
    const folder = this.folder;
    if (this.taskHistory.busy) throw new Error('Wait for the running workspace task to finish.');
    const tasks = (await vscode.tasks.fetchTasks()).filter(task => typeof task.scope === 'object' && task.scope.uri.toString() === folder.uri.toString());
    if (!tasks.length) { void vscode.window.showInformationMessage('No workspace tasks found. Add a VS Code task or enable task detection for your project.'); return; }
    const selected = await vscode.window.showQuickPick(tasks.map(task => ({ label: task.name, description: task.source, task })), { title: 'Run a workspace task', placeHolder: 'This runs the selected task with your OS account.' });
    if (!selected) return;
    this.guard();
    if (folder !== this.folder) throw new Error('The selected workspace changed. Choose a task again.');
    if (vscode.workspace.textDocuments.some(doc => doc.isDirty && vscode.workspace.getWorkspaceFolder(doc.uri)?.uri.toString() === folder.uri.toString())) throw new Error('Save your workspace files before running checks.');
    await this.taskHistory.start(folder.uri.toString(), selected.label, selected.task);
    this.messages.push({ role: 'assistant', text: `Launched '${selected.label}' in the VS Code terminal. Its process outcome appears under Recent task runs. Read the terminal for detailed results; a zero exit code alone does not prove every requirement passed.` });
    await this.persist(); this.send();
  }
}
