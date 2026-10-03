import { loadOntologyDirectory } from "./ontology.js";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
import { setting } from "../env.js";
import { fileAudit } from "../registry/audit.js";
import type { MemberDirectory } from "../registry/roles.js";
import { fileStore } from "../registry/store.js";
import { resolveWorkflow } from "../registry/source.js";
import { createJiraRuntime, type JiraRuntime } from "./jira-runtime.js";
import type { JiraDelivery } from "./jira.js";
import { createWorkbenchServer } from "./server.js";
import { createLocalSession, loadMcpToken, sameSecret, type LocalSession } from "./local-session.js";
import { chatConfiguration } from "./chat-config.js";
import { workspaceDirectory } from "./workspace-directory.js";
import { filePipelines, PipelineError, type PipelineEngine } from "./pipeline.js";
import { createBotRuntime, type BotRuntime } from "./bot-runtime.js";
import { fileWorkspaceStore, workspacesDirectory, type WorkspaceStore } from "./storage.js";
import { fileModelStudio } from "./studio/engine.js";
import { assistantGuards, studioAssistants } from "./assistant-resolver.js";
import { chatModelLoader, createScheduler, fileSchedulePersistence } from "./scheduler.js";
import { createLearningSchedule, fileLearningPersistence, folderImports } from "./learning-schedule.js";
import { createDocuments, fileDocumentStore } from "./documents.js";

/**
 * The local application, composed.
 *
 * Separate from demo.ts on purpose. The demo exists to show the workflow
 * with disposable sample data and four public identities; this opens real
 * user data owned by one person. Mixing them would mean one entry point
 * where the difference between "sample" and "yours" is a flag, and that is
 * exactly the flag someone eventually gets wrong.
 *
 * Order matters here. Storage ownership is taken before the port is bound,
 * so a second instance fails while starting rather than after the window is
 * already open, and the UI never reports ready over a workspace this process
 * does not own.
 */

/** The single local user. Requests never choose their own actor. */
export const LOCAL_OWNER = "local-owner";
export const DEFAULT_WORKSPACE = "workspace";

export interface LocalWorkbenchOptions {
  /** Defaults to the desktop application's data directory. */
  dataDir?: string;
  /** Which workspace to open. Defaults to the last one, then to a new one. */
  workspaceId?: string;
  /** Loopback port. 0 asks the OS for a free one, which the desktop uses. */
  port?: number;
  /** Explicit adapter boundary; credentials alone never enable delivery. */
  jiraDelivery?: JiraDelivery;
}

export interface LocalWorkbench {
  server: Server;
  url: string;
  workspaceId: string;
  dataDir: string;
  session: LocalSession;
  /** Stop listening, close the store, release the writer lock. */
  close(): Promise<void>;
}

/**
 * The static files the window loads.
 *
 * Read from beside this module, which is where the build puts them.
 * MAGENTIC_WORKBENCH_ASSETS points somewhere else, for running the compiled
 * server against the source assets without a bundling step.
 */
function assets(): Map<string, { type: string; body: string | Buffer }> {
  const override = setting("MAGENTIC_WORKBENCH_ASSETS")?.trim();
  const base = override ?? fileURLToPath(new URL("./", import.meta.url));
  const map = new Map<string, { type: string; body: string | Buffer }>();
  for (const [path, file, type] of [
    ["/", "index.html", "text/html; charset=utf-8"],
    ["/app.js", "app.js", "text/javascript; charset=utf-8"],
    ["/styles.css", "styles.css", "text/css; charset=utf-8"],
    ["/pipeline.css", "pipeline.css", "text/css; charset=utf-8"],
    ["/chat.css", "chat.css", "text/css; charset=utf-8"],
    ["/theme.css", "theme.css", "text/css; charset=utf-8"],
    ["/mcp.css", "mcp.css", "text/css; charset=utf-8"],
    ["/email.css", "email.css", "text/css; charset=utf-8"],
    ["/manifest.webmanifest", "manifest.webmanifest", "application/manifest+json"],
    ["/icon.svg", "icon.svg", "image/svg+xml"],
  ]) {
    const body = readFileSync(join(base, file!));
    map.set(path!, { type: type!, body: path === "/" ? body.toString("utf8").replace('<html lang="en">', '<html lang="en" data-mode="local">') : body });
  }
  return map;
}

/**
 * Start the real local application.
 *
 * Throws rather than degrading. A workspace that cannot be opened, or a lock
 * another instance holds, must stop startup: falling back to memory would
 * mean a person doing a day's work into storage that evaporates.
 */
export async function startLocalWorkbench(options: LocalWorkbenchOptions = {}): Promise<LocalWorkbench> {
  const dataDir = options.dataDir ?? workspacesDirectory();
  const ontology = loadOntologyDirectory();
  const requestedWorkspace = options.workspaceId ?? setting("MAGENTIC_WORKSPACE")?.trim();

  // Ownership first. Everything after this is only safe because we hold it.
  let workspaceStore: WorkspaceStore | undefined;
  let server: Server | undefined;
  let bots: BotRuntime | undefined;
  let jira: JiraRuntime | undefined;
  try {
    workspaceStore = fileWorkspaceStore(dataDir);
    // Opening the workspace now surfaces a corrupt or unsupported document
    // while there is still nothing running to report ready.
    const directory = workspaceDirectory(dataDir, workspaceStore, requestedWorkspace ?? DEFAULT_WORKSPACE);
    const workspaceId = directory.open({ workspaceId: requestedWorkspace ?? directory.list().lastWorkspaceId }).workspaceId;
    const accessDirectory = join(dataDir, "access");
    mkdirSync(accessDirectory, { recursive: true });
    const grants = new Map<string, string>();
    for (const entry of directory.list().workspaces) {
      const path = join(accessDirectory, `${entry.id}.token`);
      // Listing must not create credentials. Only an explicit access request
      // creates a new grant; existing grants survive application restarts.
      try { readFileSync(path); grants.set(entry.id, loadMcpToken(path)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    const session = createLocalSession({ dataDir, workspaceId: directory.mcpWorkspaceId, actor: LOCAL_OWNER,
      resolveMcpWorkspace(token) {
        for (const [id, grant] of grants) if (sameSecret(token, grant)) return id;
        return undefined;
      },
    });
    const members: MemberDirectory = {
      async rolesFor(id, actor) { return directory.has(id) && actor === LOCAL_OWNER ? ["author", "admin"] : []; },
    };

    // The owner authors and administers. They cannot approve their own work:
    // the registry and pipeline rules already refuse that, and nothing here
    // relaxes them. A gate needing a second person stays shut, which is the
    // honest outcome for a single-user machine.
    const context = {
      store: fileStore(join(dataDir, "registry")),
      audit: fileAudit(join(dataDir, "audit")),
      members,
      workflow: resolveWorkflow(),
    };

    const chat = chatConfiguration(true);
    // Model Studio records live beside the other workspace data. Dataset
    // files may only be imported from one folder, so the browser can never
    // name an arbitrary path on this machine. MAGENTIC_STUDIO_IMPORT_DIR
    // moves that folder.
    const studio = fileModelStudio(join(dataDir, "model-studio"),
      setting("MAGENTIC_STUDIO_IMPORT_DIR")?.trim() || join(dataDir, "model-studio", "import"));
    // Workflow stages staffed by an assistant are checked against the studio
    // when they are bound, when a run starts and when a bot runs.
    const assistants = studioAssistants(studio);
    const engine = filePipelines(workspaceStore, assistantGuards(assistants));
    bots = createBotRuntime(join(dataDir, "bots"), engine, chat, assistants);
    const runtime = bots;
    for (const entry of directory.list().workspaces) runtime.snapshot(entry.id);
    const pipelines: PipelineEngine = {
      snapshot: engine.snapshot,
      draft: engine.draft,
      execute(workspace, actor, roles, raw, approvals) {
        if (runtime.busy(workspace)) throw new PipelineError(409, "A bot is working in this workspace. Stop it before changing the pipeline.");
        return engine.execute(workspace, actor, roles, raw, approvals);
      },
    };
    jira = createJiraRuntime(pipelines, workspaceStore, options.jiraDelivery);
    const jiraRuntime = jira;
    for (const entry of directory.list().workspaces) await jiraRuntime.recover(entry.id);
    // Assistants draft their workflow stages in the background. Jobs live
    // beside the bot timelines; a job interrupted by a restart is failed, not resumed.
    const scheduler = createScheduler({ pipelines, assistants, loadModel: chatModelLoader(chat), persistence: fileSchedulePersistence(join(dataDir, "schedule")) });
    // Projects learn from new files in the import folder on their own rhythm.
    const importDirectory = setting("MAGENTIC_STUDIO_IMPORT_DIR")?.trim() || join(dataDir, "model-studio", "import");
    const learning = createLearningSchedule({ studio, imports: folderImports(importDirectory), persistence: fileLearningPersistence(join(dataDir, "learning")), requiredApprovals: context.workflow.requiredApprovals });
    // The documentation portal keeps content by hash under the data directory.
    const documents = createDocuments({ store: fileDocumentStore(join(dataDir, "documents")), studio, pipelines, requiredApprovals: context.workflow.requiredApprovals });
    const ticker = setInterval(() => {
      for (const entry of directory.list().workspaces) {
        try { learning.tick(entry.id); } catch { /* recorded on the run */ }
        void scheduler.tick(entry.id).catch(() => undefined);
      }
    }, 30_000);
    ticker.unref();
    server = createWorkbenchServer({
      context,
      assets: assets(),
      pipelines, bots: runtime, jira: jiraRuntime, ontology, studio, scheduler, learning, documents,
      guard: session.guard,
      async authenticate(request) {
        const path = new URL(request.url ?? "/", "http://localhost").pathname;
        const selected = request.headers["x-magentic-workspace"];
        if (request.headers.authorization) {
          if (session.browserAuthenticated(request) || (path !== "/api/mcp" && path !== "/api/pipeline-mcp")) return undefined;
          const identity = await session.authenticate(request);
          if (selected !== undefined && selected !== identity?.workspaceId) return undefined;
          return identity;
        }
        if (!session.browserAuthenticated(request)) return undefined;
        const id = selected ?? workspaceId;
        if (typeof id !== "string" || !directory.has(id)) return undefined;
        return { workspaceId: id, actor: LOCAL_OWNER, canDeliverJira: true };
      },
      workspaces: directory,
      mcpAccess(id) {
        const tokenFile = id === directory.mcpWorkspaceId ? join(dataDir, "mcp-token") : join(accessDirectory, `${id}.token`);
        if (id !== directory.mcpWorkspaceId) grants.set(id, loadMcpToken(tokenFile));
        return { workspaceId: id, tokenFile };
      },
      ...(chat ? { chat } : {}),
      demo: false,
    });

    const port = options.port ?? 0;
    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject);
      server!.listen(port, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("The local server has no TCP address.");
    session.setPort(address.port);
    // Armed only once the address exists, so the window that is about to be
    // opened is the one that claims the session.
    session.arm();

    const listening = server;
    const owned = workspaceStore;
    return {
      server: listening,
      url: `http://127.0.0.1:${address.port}/`,
      workspaceId,
      dataDir,
      session,
      async close() {
        try {
          clearInterval(ticker);
          await scheduler.close();
          await jiraRuntime.close();
          await runtime.close();
          await new Promise<void>((resolve) => {
            listening.close(() => resolve());
            listening.closeAllConnections();
          });
        } finally { owned.close(); }
      },
    };
  } catch (cause) {
    // Whatever this attempt took, this attempt releases. A failed start must
    // not leave a lock behind that makes the next one look like a conflict.
    if (server) { server.close(); server.closeAllConnections(); }
    await jira?.close();
    await bots?.close();
    workspaceStore?.close();
    throw cause;
  }
}
