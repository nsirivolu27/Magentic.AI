import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { setting } from "../../env.js";
import { startRuntime, stopRuntime, edgeArguments } from "./runtime.js";

const root = fileURLToPath(new URL("./", import.meta.url));
const smoke = process.argv.includes("--smoke-test");
const data = join(setting("LOCALAPPDATA") ?? join(homedir(), "AppData", "Local"), "MagenticDeveloper", "data");
let edge: string | undefined;
if (!smoke) {
  for (const base of [setting("ProgramFiles(x86)"), setting("ProgramFiles"), setting("LOCALAPPDATA")]) {
    if (!base) continue;
    const candidate = join(base, "Microsoft", "Edge", "Application", "msedge.exe");
    try { await access(candidate); edge = candidate; break; } catch { /* Another installation location may be available. */ }
  }
  if (!edge) throw new Error("Microsoft Edge is required for this Windows preview.");
  await mkdir(data, { recursive: true });
}
const smokeDirectory = smoke ? await mkdtemp(join(tmpdir(), "magentic-package-smoke-")) : undefined;
const demo = process.argv.includes("--demo");
const runtime = await startRuntime(join(root, "app", demo ? "demo.mjs" : "local-main.mjs"), 15000,
  smokeDirectory ? { ...process.env, MAGENTIC_WORKSPACES_DIR: smokeDirectory, MAGENTIC_WORKSPACE: "workspace" } : process.env);
const shutdown = () => { void stopRuntime(runtime.child); };
process.once("SIGINT", shutdown); process.once("SIGTERM", shutdown);
try {
  if (smoke) {
    const page = await fetch(runtime.url);
    if (!page.ok || !(await page.text()).includes("Magentic Developer")) throw new Error("Developer UI is unavailable.");
    const cookie = page.headers.get("set-cookie")?.split(";")[0];
    if (!demo && !cookie) throw new Error("Local browser session was not established.");
    const response = await fetch(new URL("api/workspace", runtime.url), { headers: demo ? { Authorization: "Bearer alex.writer" } : { Cookie: cookie! } });
    const workspace = await response.json() as { pipelines?: { storage: string }; demo?: boolean };
    if (!response.ok || !workspace.pipelines) throw new Error("Workflow API is unavailable.");
    if (!demo && (workspace.demo || workspace.pipelines.storage !== "file")) throw new Error("The package did not open persistent local storage.");
    const script = await fetch(new URL("app.js", runtime.url));
    if (!script.ok || !(await script.text()).includes("/api/workspaces")) throw new Error("The local browser bundle is unavailable.");
    // This checks the bundled adapter without downloading or invoking a model.
    const adapter = new URL("./app/node_modules/@langchain/ollama/index.mjs", import.meta.url).href;
    const module = await import(adapter) as { ChatOllama?: unknown };
    if (typeof module.ChatOllama !== "function") throw new Error("The bundled Ollama adapter is unavailable.");
    console.log("Desktop package smoke check passed: UI, workspace API, and Ollama adapter.");
  } else {
    console.log(`Magentic Developer local MCP: ${runtime.url}api/pipeline-mcp`);
    await new Promise<void>((resolve, reject) => {
      const window = spawn(edge!, edgeArguments(runtime.url, join(data, "browser")), { windowsHide: false, stdio: "ignore" });
      window.once("error", reject);
      window.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`The application window exited with code ${code}.`)));
    });
  }
} finally {
  await stopRuntime(runtime.child);
  if (smokeDirectory) await rm(smokeDirectory, { recursive: true, force: true });
}
