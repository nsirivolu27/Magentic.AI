import { mkdtempSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { setting } from "../env.js";
import { chatConfiguration } from "./chat-config.js";
import type { ChatConfiguration } from "./chat.js";
import { createWorkbenchServer } from "./server.js";
import { createAgentDemo, DEMO_MEMBERS, DEMO_WORKSPACE, scriptedDemoChat } from "./agent-demo-fixture.js";

const live = process.argv.includes("--live");
if (process.argv.slice(2).some(arg => arg !== "--live")) throw new Error("Use --live for local Ollama, or no arguments for scripted responses.");
let chat: ChatConfiguration = scriptedDemoChat();
if (live) {
  const base = new URL(setting("MAGENTIC_LLM_BASE_URL") ?? "http://127.0.0.1:11434");
  const configured = chatConfiguration(true);
  if (!configured || configured.provider !== "ollama" || !["127.0.0.1", "localhost", "[::1]"].includes(base.hostname)) throw new Error("The live demo requires Ollama on this computer.");
  const modelOptions = async () => (await configured.modelOptions!()).filter(model => model.local && model.id === configured.model);
  if (!(await modelOptions()).some(model => model.available)) throw new Error("Install the configured Ollama model before starting the live demo.");
  chat = { provider: "Ollama · live demo", model: configured.model, modelOptions,
    loadModel: async model => {
      if (model && model !== configured.model) throw new Error("The demo only uses its configured local model.");
      return configured.loadModel(configured.model);
    },
  };
}
const port = Number(setting("MAGENTIC_AGENT_DEMO_PORT") ?? "4183");
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("MAGENTIC_AGENT_DEMO_PORT must be 1–65535.");
const output = fileURLToPath(new URL("./", import.meta.url));
const scratch = fileURLToPath(new URL("../../.testbuild/", import.meta.url));
mkdirSync(scratch, { recursive: true });
const directory = mkdtempSync(join(scratch, "agent-demo-"));
const demo = await createAgentDemo(directory, chat);
const assets = new Map<string, { type: string; body: string | Buffer }>();
const types: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json" };
for (const file of readdirSync(output)) {
  if (!(extname(file) in types)) continue;
  let body: string | Buffer = readFileSync(join(output, file));
  if (file === "index.html") {
    body = body.toString().replace(/<select id="identity">[\s\S]*?<\/select>/,
      `<select id="identity">${DEMO_MEMBERS.map((member, index) => `<option value="${member.actor}">${index ? `Reviewer ${index}` : "Operator"}</option>`).join("")}</select>`)
      .replace("<body", `<body data-agent-demo="${live ? "live" : "scripted"}"`);
  }
  assets.set(file === "index.html" ? "/" : `/${file}`, { body, type: types[extname(file)]! });
}
const origin = `http://127.0.0.1:${port}`;
const server = createWorkbenchServer({ ...demo, assets, demo: true,
  guard(request) {
    if (request.headers.host !== `127.0.0.1:${port}` || (request.headers.origin && request.headers.origin !== origin)) return { status: 403, message: "Open this demo on its loopback URL." };
  },
  authenticate: async request => {
    const actor = request.headers.authorization?.replace(/^Bearer /, "");
    return actor && DEMO_MEMBERS.some(member => member.actor === actor) ? { workspaceId: DEMO_WORKSPACE, actor } : undefined;
  },
});
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  server.close(); server.closeAllConnections();
  await demo.agentTests.close();
  await demo.bots.close();
}
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { void close(); });
process.on("message", message => { if ((message as { type?: string })?.type === "shutdown") void close().then(() => process.disconnect?.()); });
server.listen(port, "127.0.0.1", () => {
  console.log(`Agent Studio: ${origin}/#/agent-studio/${demo.agents[0]!.id}`);
  console.log(live ? "Live local Ollama · synthetic source documents" : "Scripted demo · no live model calls or token charges");
  console.log(`Disposable demo evidence: ${directory}`);
});
