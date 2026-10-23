import { startCompanyWorkbench } from "./company-server.js";

try {
  const app = await startCompanyWorkbench();
  console.log(`Magentic company portal: ${app.url}`);
  let closing = false;
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => {
    if (closing) return;
    closing = true;
    void app.close().then(() => process.exit(0));
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : "Company server could not start.");
  process.exit(1);
}
