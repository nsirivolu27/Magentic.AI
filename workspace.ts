import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { LnkzClientLike } from "./client.js";

const datasetSchema = z.object({
  conversationIds: z.array(z.string().uuid()).min(1).max(100),
  acknowledgeRights: z.literal(true),
  validationPercent: z.number().int().min(5).max(50).default(20),
  seed: z.string().trim().min(1).max(80).default("lnkz-v1"),
}).strict();

export function registerWorkspaceTools(server: McpServer, client: LnkzClientLike) {
  server.registerTool("get_workspace", {
    title: "Current workspace and access",
    description: "Read the authenticated workspace, use case, dataset policy and access scopes. Workspace identity comes from the configured credential.",
    inputSchema: {}, annotations: { readOnlyHint: true },
  }, async () => {
    const result = await client.workspace();
    return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
  });
  server.registerTool("export_training_dataset", {
    title: "Export a curated training dataset",
    description: "Export explicitly selected, approved conversations as redacted train/validation JSONL with provenance and checksums. Requires workspace opt-in and admin access. Ask the user to confirm they have rights to use the selected data before setting acknowledgeRights=true. This does not train a model. Maximum output is 512 KiB of JSONL; use small selections for MCP clients.",
    inputSchema: datasetSchema.shape,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  }, async (input) => {
    const result = await client.exportDataset(datasetSchema.parse(input));
    return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
  });
  server.registerResource("workspace", "lnkz://workspace", {
    title: "Authenticated LNKZ workspace", mimeType: "application/json",
  }, async () => ({ contents: [{ uri: "lnkz://workspace", mimeType: "application/json", text: JSON.stringify(await client.workspace()) }] }));
}
