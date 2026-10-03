# Magentic Workspace for VS Code

Ask about your repository and review proposed edits without leaving your editor. This is an installable local preview, not a published marketplace extension or a complete Copilot replacement.

## Install and start

1. In VS Code, use **Extensions: Install from VSIX…** and select `magentic-workspace-0.1.9.vsix`. Opening the VSIX as a text file does not install it.
2. Open and trust a local Git repository with at least one commit. For a new project, initialize Git and make an initial commit first.
3. Start Ollama and install `qwen2.5-coder:7b`, or select another installed model in **Magentic: Model** settings. Magentic does not install or download models automatically.
4. Open a file and click the **pink diamond** in the top-right editor toolbar. It opens the coding assistant. You can also use **Magentic: Open Coding Assistant** from the Command Palette or the Magentic activity-bar icon. If VS Code asks after installation, reload the window to activate the extension.
5. Choose **Analyze**, **Build**, or **Review**. **Analyze code** inspects saved code immediately; a focus is optional. Build requires a short change request and returns proposed file diffs. Review inspects saved changes. Selecting a mode never sends a request. The main area shows the latest report and proposed changes; earlier requests and reports stay in collapsed **Task history**.

The agent reads saved files in the selected workspace. It does not automatically receive every open tab or your terminal output. In a multi-root workspace, choose the folder in the panel. Conversation history is kept separately for each folder in VS Code workspace storage. **New task** clears that folder's visible history; VS Code storage is not an encrypted secrets vault.

Failed requests keep your prompt in the task box. Use **Edit request** to restore an earlier request, adjust it, then send it again. The header displays the running extension version; after an update, use **Developer: Reload Window** and check for **v0.1.9**.

The Magentic panel uses charcoal surfaces, softly framed work panels, and restrained magenta accents with a pink diamond logo. Active modes retain an underline and bold text for grayscale readability. A compact status line shows active work. Pending diffs replace the request box until applied or discarded. Responses format code blocks, lists, headings, bold text and inline code; model HTML is displayed as text. Analysis, proposed files, and check results take priority. The current mode uses an underline and bold text. Plan and Test agents, model settings, and code previews are available under **Workspace settings**. Default analysis requests ask for concise findings, a next change, and checks with file references; reports remain model-generated evidence to verify. High-contrast VS Code themes retain their system colors.

## Work with an approved assistant

The **Worker** row under the repository name chooses who does the work: the local Ollama model, or an assistant approved in Magentic Developer's Model Studio. To offer assistants, set **Magentic: Workbench Url** to the address Magentic Developer shows (a loopback address such as `http://127.0.0.1:4173`); the extension reads the standalone client token from the workbench's data directory (or **Magentic: Workbench Token File**) and lists the assistants that can work right now. Only an active assistant on an approved release is selectable; a disabled one, or one whose release was retired, is shown greyed with the reason.

Under the worker the panel shows how that assistant keeps learning (its schedule in Magentic Developer's Model Studio, and the last cycle's outcome) and **Learn now** runs one cycle: new content is validated, trained and evaluated and a release is requested for reviewers. The extension only asks; approvals happen in the workbench.

With an assistant chosen, each request runs with the release's base model and the assistant's instructions, and the result is labelled with the assistant and release. The binding is checked with the workbench at the start of every request, so retiring a release stops new work at once. Choosing an assistant grants no tools: the editor's read only repository tools and review rules stay the same. **Refresh assistants** under Workspace settings re-reads the list.

## Work through the development workflow

The mode selector selects a real worker role: Code guide and Planning agent use the planner; Build uses the coder; Review uses the reviewer; Test uses the validator. Each phase has specific instructions. Only Build can propose edits. Test inspects coverage and suggests checks; it does not execute them or certify results.

Recent conversation is passed between agents with the originating phase labeled. **Build from findings**, **Review saved changes**, or **Assess tests** selects the next agent and prepares an editable request; it does not run it. Save applied edits before asking Review or Test to inspect them. Pending proposals must be applied or discarded before switching agents or starting another request. The agent selector shows your selected role, not completion or approval of pipeline stages.

The file name beside the repository opens the active file. **Workspace settings** offers a saved-code preview. Selected text may contain unsaved edits; the saved preview and repository tools always use disk content. Protected files are excluded using the existing repository path policy.

These editor agents work within this repository. The selector does not dispatch external agents, synchronize the standalone pipeline history, or complete registry approvals. Previous reports are unverified context. Magentic records process outcomes for tasks launched through its panel; it does not read terminal output.

## Review and validate

Open each proposed file to see VS Code's native diff. Then choose **Apply changes**. Changes are made through VS Code's edit API and can be undone. Save the resulting buffers before running checks. If a file changed or has unsaved edits, the proposal is refused rather than overwriting it.

Use **Run checks…** to choose one of that folder's existing VS Code tasks. The selected task executes with your OS account in the normal task terminal. The **Checks** card shows starting, running, exit code, elapsed time, and unknown or failed-to-start outcomes. These are historical process events; a zero exit code is not proof that the current files or all requirements pass. Inspect terminal output for detailed results. The model cannot choose or execute arbitrary shell commands.

Right-click selected code to **Explain Selected Code**, or use **Propose a Code Change**. Guided explanations can be turned off under **Workspace settings**. Both views enforce the same tool and review rules.

## Complete the edit-and-check loop

1. Use Build to propose a small change, open each diff, apply it, and save the files.
2. Choose **Run checks…**. Only tasks from the selected workspace are listed. Magentic tracks the task you selected; the model cannot start one.
3. Read **Checks** and the terminal. Cancelled processes and custom tasks without an exit result show **Exit unknown**. A fast task is still correlated with its own execution, never a matching display name.
4. Choose **Investigate result** to prepare an editable investigation request. The agent receives bounded host-recorded process metadata separately from the conversation; it asks for missing failure logs rather than inventing them.
5. Return to Build for a correction, review and save it, then run checks again.

Check history lasts for the extension session: five recent runs per folder, twenty total. Folder histories are kept separate. A running task prevents another launch through the panel; stop it in the normal VS Code terminal when necessary. Reloading the extension ends tracking without terminating the task. No historical result completes a pipeline or registry gate.

## Current boundaries

- A local model service speaking Ollama's chat API, `127.0.0.1:11434` unless `magentic.modelUrl` names another loopback address (a local gateway, for instance); requests time out after five minutes and can be stopped.
- At most eight model calls and five proposed files per request. Smaller requests work best.
- Existing repository path, secret-file and symlink protections are reused from the MCP worker.
- No automatic commits, deployments, external-agent dispatch, or changes to workspace approval gates.
- No inline ghost-text completion yet. This release provides sidebar chat, repository tools, reviewed edits, and workspace tasks.
- Remote SSH/dev containers are not verified. With a remote extension host, localhost would refer to that host, not your laptop.
- The standalone application's workflow history and the editor chat are separate in this release. The editor reuses its repository tool engine; synchronization is a later integration.

## Build locally

From the repository root, run `corepack pnpm build:vscode`, then `python extensions/vscode/package.py`. No marketplace upload is performed. The built development-extension directory is `dist/vscode/extension`; the VSIX is in `dist/vscode`.
