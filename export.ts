import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { LnkzClientLike } from "./client.js";
import { EXPORT_FORMATS, type ExportFormat } from "./contract.js";

/**
 * Registration lives here rather than inline in mcp.ts and server.ts so that
 * adding a surface costs one line in each of those files. They are the two
 * places every feature wants to edit, and keeping the edits to a line each is
 * what makes concurrent work on this server survivable.
 */

export const exportFormatSchema = z.enum([...EXPORT_FORMATS] as [ExportFormat, ...ExportFormat[]]);

const exportSchema = {
  conversationId: z.string().uuid(),
  format: exportFormatSchema.default("markdown"),
};

export function registerExportTool(server: McpServer, client: LnkzClientLike): void {
  server.registerTool(
    "export_conversation",
    {
      title: "Export a conversation",
      description:
        "Writes a stored conversation back out in another client's format: a Markdown transcript, "
        + "a Markdown brief with the decisions on top, a chat-completions message array, a ChatGPT-shaped "
        + "export, a Claude-shaped export, a LNKZ packet, or plain text. Every format re-imports, so a "
        + "conversation can leave LNKZ as easily as it arrived.",
      inputSchema: exportSchema,
      annotations: { readOnlyHint: true },
    },
    async ({ conversationId, format }) => {
      const result = await client.exportConversation(conversationId, format);
      return {
        content: [{ type: "text" as const, text: result.body }],
        structuredContent: {
          format: result.format,
          mimeType: result.mimeType,
          filename: result.filename,
          reimportable: result.reimportable,
          bytes: Buffer.byteLength(result.body, "utf8"),
        },
      };
    },
  );
}
