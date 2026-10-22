import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { configurableCatalog } from "./agent-configurables.js";
import type { PipelineEngine } from "./pipeline.js";
import type { DocumentsEngine } from "./documents.js";

export interface WorkspaceReads { pipelines?: PipelineEngine | undefined; documents?: DocumentsEngine | undefined }
export function registerWorkspaceReads(server: McpServer, workspace: string, engine?: PipelineEngine, documents?: DocumentsEngine) {
  const result = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });
  if (engine) server.registerTool("get_pipeline", { description: "Read the workspace pipeline configuration and compact run summaries.",
    inputSchema: z.object({}).strict(), annotations: { readOnlyHint: true } }, async () => {
    const snapshot = engine.snapshot(workspace);
    return result({ config: snapshot.config, agentConfigurations: configurableCatalog(snapshot.config), version: snapshot.version, storage: snapshot.storage, jiraDelivery: snapshot.jiraDelivery,
      runs: snapshot.runs.map(({ id, title, status, current, version, revision }) => ({ id, title, status, current, version, revision })) });
  });
  if (engine) server.registerTool("get_pipeline_run", { description: "Read one run, its stage outputs, review evidence, history, and Jira previews.",
    inputSchema: z.object({ runId: z.string().uuid() }).strict(), annotations: { readOnlyHint: true } }, async ({ runId }) => {
    const run = engine.snapshot(workspace).runs.find(item => item.id === runId);
    return run ? result(run) : { ...result({ error: "Run not found in this workspace." }), isError: true };
  });
  if (documents) server.registerTool("list_documents", {
    description: "List the documents in this workspace's documentation portal: title, size, how many lines looked like a credential, an excerpt, and the runs and datasets each one is connected to. The content stays on the machine.",
    inputSchema: z.object({}).strict(), annotations: { readOnlyHint: true },
  }, async () => result(documents.snapshot(workspace).documents));
}
