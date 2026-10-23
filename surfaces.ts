import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerExportTool } from "./export.js";
import { registerGraphTools } from "./graph.js";
import { registerPublishTools } from "./publish.js";
import type { LnkzClientLike } from "./client.js";

/**
 * Every MCP surface that lives outside mcp.ts, registered in one place.
 *
 * mcp.ts is a file every feature wants to edit, which makes it the file every
 * branch conflicts in. Routing registration through here means a new surface
 * costs one line here and nothing there. Its REST counterpart is surfaces.ts,
 * and the two are deliberately separate files: the MCP surface is on its way
 * out of this repository, and a shared file would have to be cut in half on
 * the way.
 */
export function registerSurfaces(server: McpServer, client: LnkzClientLike): void {
  registerExportTool(server, client);
  registerGraphTools(server, client);
  registerPublishTools(server, client);
}
