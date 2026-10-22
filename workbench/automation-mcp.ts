import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { automationInspectionSchema } from "./automation-schema.js";
import { AutomationError, type AutomationRuntime } from "./automation-runtime.js";

export function registerAutomationInspection(server: McpServer, runtime: AutomationRuntime, workspace: string) {
  server.registerTool("get_automation_units", {
    description: "Read this workspace's configured automation units and execution receipts, optionally for one run. Does not invoke functions or grant access.",
    inputSchema: automationInspectionSchema, annotations: { readOnlyHint: true },
  }, async input => {
    try { return { content: [{ type: "text" as const, text: JSON.stringify(runtime.inspect(workspace, input)) }] }; }
    catch (error) { return { isError: true, content: [{ type: "text" as const,
      text: error instanceof AutomationError ? error.message : "Automation history is unavailable." }] }; }
  });
}
