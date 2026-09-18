import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { setting } from "./env.js";

/**
 * Resource addressing.
 *
 * Resources are addressed magentic://. They were addressed lnkz:// before the
 * rename, and a client that saved one of those URIs would get nothing back if
 * the old scheme simply disappeared, so every resource is also registered
 * under its old URI and marked deprecated in the listing.
 *
 * Set MAGENTIC_LEGACY_URIS=0 to register only the new scheme. The aliases go
 * away in the next major version.
 */

export const SCHEME = "magentic";
export const LEGACY_SCHEME = "lnkz";

/** Whether the deprecated lnkz:// aliases are registered. Defaults to yes. */
export function legacyUrisEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (setting("MAGENTIC_LEGACY_URIS", env) ?? "").trim() !== "0";
}

type ResourceConfig = { title: string; description: string; mimeType: string };
type ResourceContents = { contents: { uri: string; mimeType: string; text: string }[] };

/**
 * Registers one resource under magentic:// and, unless legacy URIs are off,
 * the same resource under its old lnkz:// URI.
 *
 * The read function is handed the URI it was actually called with, so a client
 * reading the old address gets that address back in the response rather than a
 * silent rewrite to the new one.
 */
export function registerAliasedResource(
  server: McpServer,
  name: string,
  path: string,
  config: ResourceConfig,
  read: (uri: string) => Promise<ResourceContents>,
  env: NodeJS.ProcessEnv = process.env,
): void {
  server.registerResource(name, `${SCHEME}://${path}`, config, async () => read(`${SCHEME}://${path}`));
  if (!legacyUrisEnabled(env)) return;
  server.registerResource(
    `${name}-legacy`,
    `${LEGACY_SCHEME}://${path}`,
    { ...config, description: `${config.description} Deprecated alias for ${SCHEME}://${path}.` },
    async () => read(`${LEGACY_SCHEME}://${path}`),
  );
}
