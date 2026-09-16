import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { LnkzClient } from "./client.js";
import { createLnkzMcpServer, optionsFromEnv } from "./mcp.js";

// fromEnv throws without LNKZ_BASE_URL and LNKZ_API_KEY, which is the point:
// an adapter with nowhere to talk to should fail at boot rather than on its
// first call.
const client = LnkzClient.fromEnv();

// Verify a named profile before exposing any tools to its MCP client. A
// profile that does not resolve is a misconfiguration, and finding that out
// now is better than finding it out through a tool call that half worked.
if (process.env.LNKZ_PROFILE || process.env.LNKZ_PROFILES_JSON) await client.workspace();

const server = createLnkzMcpServer(client, optionsFromEnv());

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, async () => {
    await server.close().catch(() => undefined);
    process.exit(0);
  });
}

await server.connect(new StdioServerTransport());
