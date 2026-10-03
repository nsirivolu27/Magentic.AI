MAGENTIC DEVELOPER — WINDOWS PREVIEW

A local developer space for configurable workflows, agents, chat, and MCP.

INSTALL
1. Extract the entire ZIP into a folder.
2. Double-click Install.cmd, or use Windows PowerShell:
   powershell.exe -NoProfile -File .\Install.ps1
3. Open Magentic Developer from the Start menu.

Microsoft Edge must be installed. Node 22 and the Ollama adapter are bundled;
you do not need pnpm or a terminal to launch the installed application.
The installer uses the current user's LocalAppData directory and Start menu.
It refuses to overwrite an existing installation. This preview is unsigned;
follow your organization's script policy. Do not disable security protections.

HOW IT RUNS
The application uses Edge's browser engine in a dedicated application window.
Its Node backend starts automatically on a random loopback port and stops when
the application window process exits. No hosted website or public listener is
created. Another copy cannot start while its launcher is running.

Ollama and model downloads are separate installations. Cloud providers require
your own credentials and internet access. Email and Jira remain previews.
The application opens saved local workspaces. Create and select projects in
the workspace panel; records and pipeline runs survive normal shutdown and
restart. User data lives under %LOCALAPPDATA%\MagenticDeveloper\data\workspaces.
Assign phase bots in Configurables and attach a Git repository to run them.
Bots propose changes in isolated checkouts; applying changes, running checks,
and handing off results are explicit actions. The owner cannot self-approve, so
review gates requiring another person stay closed. Reviewer enrollment is not
implemented. This is not yet a full IDE or a production multiuser application.

MCP
The local MCP address is written to %LOCALAPPDATA%\MagenticDeveloper\data\app.log
on each launch. It is available only while the application is running. Use
Standalone MCP access in the workspace panel to prepare connection settings.
The separate token file grants MCP access only to the selected workspace;
keep it private. The browser uses its own temporary HttpOnly session cookie.
If the browser session expires, close and reopen the application.

If startup fails, the launcher displays an error and points to error.log in
the same data directory. A corrupt workspace is never replaced with sample
data. After a forced kill, verify that no Magentic backend is running before
removing data\workspaces\.writer.lock. Normal shutdown releases this lock.
Local disk operation is supported; network-drive, sync-folder and power-loss
recovery are not verified.

UNINSTALL
Close Magentic Developer. Remove the Magentic Developer Start menu shortcut
and the application folder shown by the installer. Browser profile, saved workspaces and logs
remain separately under %LOCALAPPDATA%\MagenticDeveloper\data.
No system service, startup task, firewall rule, or cloud resource is installed.
