import { defineConfig } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const cwd = fileURLToPath(new URL("../", import.meta.url));

export default defineConfig({
  testDir: ".", testMatch: "operations-ui.spec.mjs", fullyParallel: false,
  workers: 1, reporter: "list", timeout: 90_000,
  use: { baseURL: "http://127.0.0.1:4173", viewport: { width: 1440, height: 1000 }, trace: "retain-on-failure",
    launchOptions: {
      ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}),
      ...(process.env.PLAYWRIGHT_LOW_MEMORY === "1" ? { args: ["--disable-gpu", "--single-process", "--no-zygote"] } : {}),
    } },
  webServer: [
    { command: "node dist/workbench/demo.mjs", cwd, url: "http://127.0.0.1:4173", reuseExistingServer: false, timeout: 30_000 },
    { command: "node dist/workbench/local-main.mjs", cwd, port: 4174,
      env: { MAGENTIC_WORKBENCH_PORT: "4174", MAGENTIC_WORKSPACES_DIR: mkdtempSync(join(tmpdir(), "magentic-ui-")) },
      // Polling '/' would consume the local startup session before a browser
      // could claim it. A TCP check leaves that security handshake intact.
      reuseExistingServer: false, timeout: 30_000 },
  ],
});
