import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { setting } from "../env.js";
import { loadOntologyDirectory } from "./ontology.js";
import { registerOntologyTools } from "./ontology-mcp.js";

try {
  const workspace = setting("MAGENTIC_WORKSPACE");
  if (!workspace) throw new Error("Set MAGENTIC_WORKSPACE to a configured workspace ID.");
  const reader = loadOntologyDirectory()(workspace);
  if (!reader) throw new Error("Configure this workspace in MAGENTIC_ONTOLOGY_FILE first.");
  const server = new McpServer({ name: "magentic-ontology", version: "0.1.0" });
  registerOntologyTools(server, reader);
  await server.connect(new StdioServerTransport());
} catch {
  console.error("Magentic Ontology could not start. Check MAGENTIC_ONTOLOGY_FILE, MAGENTIC_WORKSPACE and the configured token setting. No credentials were printed.");
  process.exitCode = 1;
}
