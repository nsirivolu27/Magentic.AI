import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { LnkzClient } from "./client.js";
import { createLnkzMcpServer } from "./mcp.js";

const client = LnkzClient.fromEnv();
// Verify a named profile before exposing any tools to its MCP client.
if (process.env.LNKZ_PROFILE || process.env.LNKZ_PROFILES_JSON) await client.workspace();
const server = createLnkzMcpServer(client);

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, async () => {
    await server.close().catch(() => undefined);
    process.exit(0);
  });
}

await server.connect(new StdioServerTransport());
