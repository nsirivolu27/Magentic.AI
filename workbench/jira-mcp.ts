import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { JiraApiError, jiraInspectionSchema, type JiraRuntime } from "./jira-runtime.js";

// Accept only inspection, so registering this tool cannot grant delivery
// authority even when its bearer represents the local workspace owner.
export function registerJiraInspection(server: McpServer, jira: Pick<JiraRuntime, "inspect">, workspaceId: string) {
  server.registerTool("get_jira_actions", {
    description: "Read a page of stored Jira action outcomes and evidence for one workspace run. Never authorizes, sends, retries, or reconciles Jira requests.",
    inputSchema: jiraInspectionSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async input => {
    try { return { content: [{ type: "text" as const, text: JSON.stringify(jira.inspect(workspaceId, input)) }] }; }
    catch (error) {
      return { isError: true, content: [{ type: "text" as const,
        text: JSON.stringify({ error: error instanceof JiraApiError ? error.message : "Jira action evidence could not be read." }),
      }] };
    }
  });
}
