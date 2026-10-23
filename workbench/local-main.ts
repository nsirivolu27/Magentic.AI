import { setting } from "../env.js";
import { startLocalWorkbench, type LocalWorkbench } from "./local.js";

/**
 * The local application's entry point.
 *
 * Started by the desktop launcher with --desktop, which expects the URL over
 * the IPC channel rather than parsed out of stdout. The session credential
 * never travels this way: the window claims it by being the first to open
 * the page.
 */
const desktop = process.argv.includes("--desktop") && !!process.send;
const declared = setting("MAGENTIC_WORKBENCH_PORT");
const port = desktop ? 0 : Number(declared ?? "4173");
if (!desktop && (!Number.isInteger(port) || port < 1 || port > 65535)) {
  throw new Error("MAGENTIC_WORKBENCH_PORT must be 1-65535.");
}

let workbench: LocalWorkbench;
try {
  workbench = await startLocalWorkbench({ port });
} catch (error) {
  // Startup failures are the ones a person actually hits: a second instance,
  // a corrupt document, an unwritable data directory. Say which, and exit
  // non-zero so the launcher can show it rather than opening a blank window.
  console.error(`Magentic could not start: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

console.log(`Magentic Developer: ${workbench.url} (local workspace ${workbench.workspaceId})`);
if (desktop) process.send!({ url: workbench.url });

let closing = false;
async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  await workbench.close();
  process.exit(0);
}
if (desktop) process.once("disconnect", () => { void shutdown(); });
for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => { void shutdown(); });
