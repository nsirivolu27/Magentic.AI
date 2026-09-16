import { createAdapterHttpServer } from "./http.js";
import { optionsFromEnv } from "./mcp.js";

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
const server = createAdapterHttpServer({ baseUrl, options: optionsFromEnv() });

server.listen(port, host, () => {
  console.log(`[http] LNKZ MCP adapter on http://${host}:${port}/mcp, relaying to ${baseUrl}`);
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
