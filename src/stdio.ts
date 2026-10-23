import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createLnkzRestClient } from "./client.js";
import { createLnkzMcpServer } from "./mcp.js";

const client = createLnkzRestClient();
const server = createLnkzMcpServer(client);
const transport = new StdioServerTransport();

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    transport.close().catch(() => undefined);
    process.exit(0);
  });
}

await server.connect(transport);