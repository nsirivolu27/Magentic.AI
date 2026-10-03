import { startLocalWorkbench } from "./local.js";

// This entry point is only launched by the development watcher. It uses the
// real local session and storage rules so previewing cannot bypass a gate.
const dataDir = process.argv[2];
const port = Number(process.argv[3]);
if (!process.send || !dataDir || !Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("Start development mode with pnpm dev:workbench.");
}
const app = await startLocalWorkbench({ dataDir, port });
process.send({ type: "ready", url: app.url });
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await app.close();
  process.exit(0);
}
process.on("message", message => {
  if (typeof message === "object" && message !== null && "type" in message && message.type === "shutdown") void close();
});
process.once("disconnect", () => { void close(); });
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { void close(); });
