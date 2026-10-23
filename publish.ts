import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { LnkzClientLike } from "./client.js";

const shapeSchema = z.enum(["summary", "decisions", "transcript", "brief"]);

const prepareSchema = {
  conversationId: z.string().uuid(),
  target: z.string().trim().min(1).max(80),
  tool: z.string().trim().min(1).max(120),
  shape: shapeSchema.default("summary"),
};

const prepareObject = z.object(prepareSchema);

export function registerPublishTools(server: McpServer, client: LnkzClientLike): void {
  server.registerTool(
    "list_publish_targets",
    {
      title: "List publish targets",
      description:
        "Connects to every configured downstream MCP server and lists the tools it exposes, marking which ones "
        + "look like writes. Configure targets with LNKZ_MCP_TARGETS as name=url, optionally name=url|key. "
        + "This is discovery only: it reads what is available and changes nothing.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      const { targets, errors } = await client.publishTargets();
      if (!targets.length) {
        return {
          content: [{
            type: "text" as const,
            text: "No publish targets are configured. Set LNKZ_MCP_TARGETS to name=url pairs.",
          }],
          structuredContent: { targets: [], errors },
        };
      }

      const lines = targets.map((entry) => {
        if (entry.error) return `${entry.target}: unreachable (${entry.error})`;
        const writes = entry.tools.filter((tool) => tool.write);
        return `${entry.target}: ${entry.tools.length} tool(s), ${writes.length} that look like writes`
          + (writes.length ? `\n  ${writes.map((tool) => tool.name).join(", ")}` : "");
      });

      return {
        content: [{ type: "text" as const, text: lines.join("\n\n") }],
        structuredContent: { targets, errors },
      };
    },
  );

  server.registerTool(
    "prepare_publish",
    {
      title: "Prepare a conversation for another system",
      description:
        "Maps a conversation onto a downstream MCP tool's input schema and returns the exact call that would be "
        + "made, including which required fields it could not fill. It never sends anything. Review the payload, "
        + "then make the call yourself with that server's own tool if you want it to happen.",
      inputSchema: prepareSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (input) => {
      const options = prepareObject.parse(input);
      const { prepared } = await client.preparePublish(options);
      const lines = [
        `Prepared a call to ${prepared.target}.${prepared.tool}. Nothing was sent.`,
        "",
        JSON.stringify(prepared.arguments, null, 2),
        "",
        prepared.filled.length ? `Filled: ${prepared.filled.map((entry) => `${entry.name} from ${entry.from}`).join("; ")}` : "",
        prepared.missing.length ? `Still needed: ${prepared.missing.map((entry) => `${entry.name} (${entry.type})`).join(", ")}` : "",
        ...prepared.notes,
      ].filter(Boolean);

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        structuredContent: { prepared },
      };
    },
  );
}
