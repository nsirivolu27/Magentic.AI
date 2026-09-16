import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { LnkzClient } from "./client.js";
import { createLnkzMcpServer, optionsFromEnv } from "./mcp.js";

// LnkzClient.fromEnv throws without LNKZ_BASE_URL and LNKZ_API_KEY, which is
// the point: an adapter that starts without somewhere to talk to is a server
// that fails on its first call instead of at boot.
const server = createLnkzMcpServer(LnkzClient.fromEnv(), optionsFromEnv());

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, async () => {
    await server.close().catch(() => undefined);
    process.exit(0);
  });
}

await server.connect(new StdioServerTransport());
