import { build } from "esbuild";
import { fork } from "node:child_process";
import { once } from "node:events";
import { watch } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const root = fileURLToPath(new URL("../", import.meta.url));
const options = new Map(process.argv.slice(2).map(argument => {
  const match = /^--(port|data-dir)=(.+)$/.exec(argument);
  if (!match) throw new Error("Use --port=4317 or --data-dir=<directory>.");
  return [match[1], match[2]];
}));
const port = Number(options.get("port") ?? "4317");
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Port must be 1-65535.");
const output = join(root, ".magentic-dev", "build");
const data = resolve(root, options.get("data-dir") ?? ".magentic-dev/data");
const assets = ["index.html", "styles.css", "pipeline.css", "chat.css", "theme.css", "mcp.css", "email.css", "manifest.webmanifest", "icon.svg"];
let child;
let closing = false;
let building = false;
let queued = false;
let debounce;
const watchers = [];

async function stopServer() {
  if (!child || child.exitCode !== null) return;
  const previous = child;
  const exited = once(previous, "exit");
  // IPC gives Windows the same graceful shutdown as Ctrl+C on Unix. The
  // backend must release its writer lock before a replacement starts.
  if (previous.connected) previous.send({ type: "shutdown" });
  await exited;
  if (child === previous) child = undefined;
}

async function rebuild() {
  if (closing) return;
  if (building) { queued = true; return; }
  building = true;
  try {
    console.log("[dev] Building workspace...");
    const revision = randomUUID();
    const [server, browser, copied] = await Promise.all([
      build({ absWorkingDir: root, entryPoints: ["workbench/dev-server.ts"], outfile: join(output, "server.mjs"),
        bundle: true, platform: "node", format: "esm", target: "node22", write: false, logLevel: "silent" }),
      build({ absWorkingDir: root, entryPoints: ["workbench/dev-browser.ts"], outfile: join(output, "app.js"),
        bundle: true, platform: "browser", format: "esm", target: "es2022", write: false, logLevel: "silent",
        define: { __MAGENTIC_DEV_REVISION__: JSON.stringify(revision) } }),
      Promise.all(assets.map(async name => [name, await readFile(join(root, "workbench", name))])),
    ]);
    const manifest = JSON.parse(copied.find(([name]) => name === "manifest.webmanifest")[1].toString());
    if (closing) return;
    // Compile everything before stopping the working server. A syntax error
    // should leave the current workspace usable while the developer fixes it.
    await stopServer();
    if (closing) return;
    await mkdir(output, { recursive: true });
    for (const file of [...server.outputFiles, ...browser.outputFiles]) await writeFile(file.path, file.contents);
    for (const [name, content] of copied) {
      const body = name === "manifest.webmanifest"
        ? JSON.stringify({ ...manifest, magenticDevRevision: revision }) : content;
      await writeFile(join(output, name), body);
    }
    child = fork(join(output, "server.mjs"), [data, String(port)], {
      cwd: root, windowsHide: true, stdio: ["ignore", "inherit", "inherit", "ipc"],
      env: { ...process.env, MAGENTIC_WORKBENCH_ASSETS: output },
    });
    await new Promise((resolveReady, reject) => {
      child.once("error", reject);
      child.once("exit", code => reject(new Error(`Local backend exited before ready (${code}). Check its startup error.`)));
      child.once("message", message => {
        if (message?.type !== "ready") return reject(new Error("Unexpected development backend message."));
        console.log(`[dev] Ready: ${message.url}`);
        console.log(`[dev] Saved development data: ${data}`);
        if (process.send) process.send({ type: "ready", url: message.url });
        resolveReady();
      });
    });
  } catch (error) {
    console.error(`[dev] Build/start failed: ${error instanceof Error ? error.message : String(error)}`);
    console.error("[dev] Watching for the next edit. No data or locks were deleted.");
  } finally {
    building = false;
    if (queued && !closing) { queued = false; void rebuild(); }
  }
}

function changed(_event, filename) {
  if (!filename || ![".ts", ".mjs", ".css", ".html", ".svg", ".webmanifest", ".json"].includes(extname(String(filename)))) return;
  clearTimeout(debounce);
  debounce = setTimeout(() => { void rebuild(); }, 250);
}

async function close() {
  if (closing) return;
  closing = true;
  clearTimeout(debounce);
  for (const watcher of watchers) watcher.close();
  await stopServer();
}
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { void close(); });
if (process.send) process.on("message", message => { if (message?.type === "shutdown") void close().then(() => process.disconnect()); });
watchers.push(watch(root, changed));
// Only runtime source roots belong to this build. Nested projects and their
// generated files must not trigger restarts of an unrelated workspace.
for (const name of ["workbench", "registry", "catalog", "llm"]) {
  watchers.push(watch(join(root, name), { recursive: true }, changed));
}
await rebuild();
