import { createAdapterHttpServer } from "./http.js";
import { optionsFromEnv } from "./mcp.js";
import type { Catalog } from "./catalog/load.js";
import { resolveCatalog, type ResolvedCatalog } from "./registry/source.js";

/**
 * Hosting the adapter.
 *
 * Reads configuration, binds a port, and nothing else. The behaviour lives in
 * http.ts so a test can exercise it without a process.
 *
 *   LNKZ_BASE_URL=https://relay.example.com HOST=0.0.0.0 PORT=8080 \
 *     node dist/http-main.mjs
 */
const baseUrl = (process.env.LNKZ_BASE_URL ?? "").trim();
if (!baseUrl) {
  console.error("[http] LNKZ_BASE_URL is required. Refusing to start without a relay to talk to.");
  process.exit(1);
}

const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 8080);
const options = optionsFromEnv();

// The catalog is loaded before the port is bound, and a bad definition stops
// the process. A server that came up with half its agents would report
// healthy and then fail one connection at a time, which is the worst way to
// find out a file has a typo in a tool name.
let source: ResolvedCatalog;
try {
  // Resolved from this file rather than the working directory, so the same
  // build serves the same agents however it was started. Which loader runs
  // is a setting: files by default, the registry when one is named.
  source = await resolveCatalog(import.meta.url, options.allowWrites ?? true);
} catch (error) {
  console.error(`[http] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
const catalog: Catalog | undefined = source.catalog;

const server = createAdapterHttpServer({ baseUrl, options, ...(catalog ? { catalog } : {}) });

server.listen(port, host, () => {
  console.log(`[http] Magentic on http://${host}:${port}/mcp, relaying to ${baseUrl}`);
  for (const entry of catalog?.entries ?? []) {
    const access = entry.writesAllowed ? "read+write" : "read";
    console.log(`[http]   ${entry.endpoint}  ${entry.definition.title} (${entry.activeTools.size} tools, ${access})`);
    if (entry.unavailableTools.length) {
      // Said out loud rather than left to be noticed. An agent quietly
      // missing an optional tool looks like the tool is broken.
      console.warn(`[http]   ${entry.definition.name}: not available on this build: ${entry.unavailableTools.join(", ")}`);
    }
  }
  if (catalog) console.log(`[http] catalog at http://${host}:${port}/agents, definitions from ${source.origin}`);
  if (source.mode === "workspace") {
    console.log(`[http] workspace mode: serving approved records for workspace ${source.workspaceId}`);
    for (const item of source.withheld) {
      // Said out loud for the same reason an unavailable optional tool is.
      // A definition that exists and is not being served looks like a bug
      // until someone is told it is a decision.
      console.warn(`[http]   withheld ${item.name}: ${item.reason} - ${item.detail}`);
    }
  }
  if (process.env.LNKZ_API_KEY) {
    // Loud, because someone setting it has assumed the wrong model: that the
    // host holds a key. It does not, and a caller without their own gets 401.
    console.warn("[http] LNKZ_API_KEY is set and ignored. Hosted mode uses each caller's own key.");
  }
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
