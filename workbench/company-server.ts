import { loadZenfluenceDirectory } from "./zenfluence.js";
import { loadSlack } from "./slack.js";
import { createAutomationRuntime, loadAutomationUnits, type AutomationRuntime } from "./automation-runtime.js";
import { lambdaInvoker } from "./automation-lambda.js";
import { companyChatIdentity } from "./company-chat.js";
import { createChatAccess, loadChatPlan } from "./chat-access.js";
import { fileChatVault } from "./chat-vault.js";
import { join } from "node:path";
import type { IncomingMessage } from "node:http";
import { loadAccounts } from "./accounts.js";
import { clerkMemberships, createCompanyAccess } from "./company-access.js";
import { clerkCompanyRoster } from "./company-team.js";
import { fileWorkspaceStore, workspacesDirectory } from "./storage.js";
import { workspaceDirectory } from "./workspace-directory.js";
import { filePipelines } from "./pipeline.js";
import { assets } from "./local.js";
import { createWorkbenchServer } from "./server.js";
import { fileStore } from "../registry/store.js";
import { fileAudit } from "../registry/audit.js";
import { resolveWorkflow } from "../registry/source.js";
import { setting } from "../env.js";
import { createModelStudio } from "./studio/engine.js";
import { fileStudioStore, fileDatasetFiles, StudioStorageError } from "./studio/store.js";
import { assistantGuards, studioAssistants } from "./assistant-resolver.js";
import { chatConfiguration } from "./chat-config.js";
import { chatModelLoader, createScheduler, fileSchedulePersistence } from "./scheduler.js";
import { createDocuments, fileDocumentStore } from "./documents.js";
import { createBilling } from "./billing.js";
import { loadOntologyDirectory } from "./ontology.js";

export function companyGuard(origin: string) {
  const url = new URL(origin);
  if (url.origin !== origin || (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname)))) {
    throw new Error("MAGENTIC_PUBLIC_ORIGIN must be an HTTPS origin, or HTTP on localhost for testing.");
  }
  return (request: IncomingMessage) => {
    if (request.headers.host !== url.host) return { status: 403, message: "Use the configured company portal address." };
    if (request.headers.origin && request.headers.origin !== origin) return { status: 403, message: "Cross-origin requests are not allowed." };
    if (request.method !== "GET" && request.method !== "HEAD" && !request.headers.authorization?.startsWith("Bearer ") && request.headers.origin !== origin) {
      return { status: 403, message: "Browser writes require the company portal origin." };
    }
    return undefined;
  };
}

export function companyDatasetFiles(directory: string) {
  const files = fileDatasetFiles(directory, join(directory, "unused-imports"));
  return { ...files, importFile() { throw new StudioStorageError("Upload dataset text in company mode. Host file imports are unavailable."); } };
}

export async function startCompanyWorkbench() {
  const accounts = loadAccounts();
  if (!accounts?.companies) throw new Error("Configure companies in MAGENTIC_ACCOUNTS_FILE before starting the company server.");
  const origin = setting("MAGENTIC_PUBLIC_ORIGIN")?.trim();
  if (!origin || !accounts.clerk.authorizedParties.includes(origin)) throw new Error("MAGENTIC_PUBLIC_ORIGIN must match a Clerk authorizedParties entry.");
  const guard = companyGuard(origin);
  const memberships = clerkMemberships(setting("MAGENTIC_CLERK_SECRET_KEY") ?? "");
  const port = Number(setting("MAGENTIC_WORKBENCH_PORT") ?? "4173");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("MAGENTIC_WORKBENCH_PORT must be 1-65535.");
  const automationUnits = loadAutomationUnits();
  const zenfluence = loadZenfluenceDirectory();
  const dataDir = workspacesDirectory();
  const slack = loadSlack(join(dataDir, "slack-receipts"));
  const store = fileWorkspaceStore(dataDir);
  let server: ReturnType<typeof createWorkbenchServer> | undefined;
  let scheduler: ReturnType<typeof createScheduler> | undefined;
  let automations: AutomationRuntime | undefined;
  let ticker: ReturnType<typeof setInterval> | undefined;
  try {
    const directory = workspaceDirectory(dataDir, store, "company-system");
    const companies = createCompanyAccess(accounts, directory, memberships, clerkCompanyRoster(setting("MAGENTIC_CLERK_SECRET_KEY") ?? ""));
    const workflow = resolveWorkflow();
    // A tenant may upload text, never select a file from the shared server.
    const studio = createModelStudio({ storage: "file", persistence: fileStudioStore(join(dataDir, "model-studio")),
      files: companyDatasetFiles(join(dataDir, "model-studio")) });
    const assistants = studioAssistants(studio);
    const pipelines = filePipelines(store, assistantGuards(assistants));
    automations = createAutomationRuntime(pipelines, store, automationUnits, lambdaInvoker());
    for (const entry of directory.list().workspaces) automations.recover(entry.id);
    const chat = chatConfiguration() ?? { provider: "unconfigured", model: "", modelOptions: async () => [],
      loadModel: async () => { throw new Error("Connect a model first."); } };
    const billing = createBilling(accounts.billing, setting("MAGENTIC_STRIPE_SECRET_KEY"));
    const chatAccess = createChatAccess({ base: chat, managedLogin: true, plan: loadChatPlan(),
      vault: fileChatVault(join(dataDir, "chat-connections"), setting("MAGENTIC_CONNECTIONS_KEY")), entitled: workspace => billing.tier(workspace) });
    const ontology = loadOntologyDirectory();
    scheduler = createScheduler({ pipelines, assistants, loadModel: chatModelLoader(chat), persistence: fileSchedulePersistence(join(dataDir, "schedule")) });
    const runningScheduler = scheduler;
    const documents = createDocuments({ store: fileDocumentStore(join(dataDir, "documents")), studio, pipelines, requiredApprovals: workflow.requiredApprovals });
    const publicAssets = assets();
    const index = publicAssets.get("/")!;
    publicAssets.set("/", { ...index, body: String(index.body).replace('data-mode="local"', 'data-mode="company"') });
    // Repository commands need isolated workers before they can be offered to tenants.
    server = createWorkbenchServer({ accounts, companies, workspaces: directory, assets: publicAssets,
      context: { store: fileStore(join(dataDir, "registry")), audit: fileAudit(join(dataDir, "audit")), members: companies.members, workflow },
      authenticate: companyChatIdentity(chatAccess, async request => {
        const identity = await companies.authenticate(request);
        return identity ? { ...identity, canRunAutomations: true, canSendSlack: true } : undefined;
      }), guard, pipelines, studio, scheduler, documents, ontology, automations, zenfluence,
      billing, chatAccess, chat, ...(slack ? { slack } : {}) });
    await new Promise<void>((resolve, reject) => { server!.once("error", reject); server!.listen(port, "127.0.0.1", resolve); });
    ticker = setInterval(() => {
      for (const entry of directory.list().workspaces) if (entry.organizationId) void runningScheduler.tick(entry.id).catch(() => undefined);
    }, 30_000);
    ticker.unref();
    const listening = server;
    return { server: listening, url: origin + "/companies", async close() {
      clearInterval(ticker);
      await new Promise<void>(resolve => { listening.close(() => resolve()); listening.closeAllConnections(); });
      await runningScheduler.close(); await automations?.close(); store.close();
    } };
  } catch (error) {
    clearInterval(ticker); server?.close(); server?.closeAllConnections(); await scheduler?.close(); await automations?.close(); store.close(); throw error;
  }
}
