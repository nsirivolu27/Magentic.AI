import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { LnkzClient } from "./client.js";
import { createLnkzMcpServer, optionsFromEnv } from "./mcp.js";
import { catalogFor, selectAgent } from "./catalog/select.js";

// fromEnv throws without LNKZ_BASE_URL and LNKZ_API_KEY, which is the point:
// an adapter with nowhere to talk to should fail at boot rather than on its
// first call.
const client = LnkzClient.fromEnv();

// Verify a named profile before exposing any tools to its MCP client. A
// profile that does not resolve is a misconfiguration, and finding that out
// now is better than finding it out through a tool call that half worked.
if (process.env.LNKZ_PROFILE || process.env.LNKZ_PROFILES_JSON) await client.workspace();

const base = optionsFromEnv();

// One process, one agent. Hosting lets the URL choose; a subprocess has no
// URL, so the choice is made here. Unset means every tool, which is what
// every existing stdio configuration already has.
//
// Everything is written to stderr. stdout is the MCP transport, and a single
// stray line on it corrupts the protocol.
const requested = process.env.LNKZ_AGENT?.trim();
let options = base;
if (requested) {
  const catalog = catalogFor(import.meta.url, base.allowWrites ?? true);
  if (!catalog) {
    console.error(`[lnkz] LNKZ_AGENT=${requested} was set but no agent definitions could be read.`);
    process.exit(1);
  }
  try {
    const selected = selectAgent(catalog, requested, base);
    options = selected.options;
    const access = selected.options.allowWrites ? "read+write" : "read";
    console.error(`[lnkz] ${selected.entry.definition.title}: ${selected.entry.activeTools.size} tools, ${access}.`);
    if (selected.entry.unavailableTools.length) {
      console.error(`[lnkz] not available on this build: ${selected.entry.unavailableTools.join(", ")}`);
    }
  } catch (error) {
    console.error(`[lnkz] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

const server = createLnkzMcpServer(client, options);

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, async () => {
    await server.close().catch(() => undefined);
    process.exit(0);
  });
}

await server.connect(new StdioServerTransport());
