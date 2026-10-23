import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { LnkzClientLike } from "./client.js";
import type { ConversationGraph } from "./contract.js";

export const graphSchema = {
  limit: z.number().int().min(2).max(200).default(50),
  minTopicConversations: z.number().int().min(2).max(20).default(2),
  duplicateThreshold: z.number().min(0.2).max(0.99).default(0.6),
  conflictThreshold: z.number().min(0.1).max(0.95).default(0.45),
  maxTopics: z.number().int().min(1).max(200).default(40),
};

const graphObject = z.object(graphSchema);

export function registerGraphTools(server: McpServer, client: LnkzClientLike): void {
  server.registerTool(
    "build_context_graph",
    {
      title: "Build the conversation graph",
      description:
        "Builds a graph over the stored conversations: nodes for conversations, decisions, open questions "
        + "and shared topics, and edges for lineage, shared subject matter, near duplicates and contradictions. "
        + "Answers the questions search cannot: what this corpus knows, which decisions everything else leans on, "
        + "and which conversations stand alone. Every edge carries the reason it exists.",
      inputSchema: graphSchema,
      annotations: { readOnlyHint: true },
    },
    async (input) => {
      const options = graphObject.parse(input);
      const { graph } = await client.graph(options);
      return {
        content: [{ type: "text" as const, text: graphToMarkdown(graph) }],
        structuredContent: { graph },
      };
    },
  );

  server.registerResource(
    "conversation-graph",
    "lnkz://graph",
    {
      title: "LNKZ conversation graph",
      description: "Nodes and edges over the 50 most recent conversations.",
      mimeType: "application/json",
    },
    async () => {
      const { graph } = await client.graph({ limit: 50 });
      return {
        contents: [{
          uri: "lnkz://graph",
          mimeType: "application/json",
          text: JSON.stringify(graph, null, 2),
        }],
      };
    },
  );
}

function graphToMarkdown(graph: ConversationGraph): string {
  const lines = [
    "# LNKZ conversation graph",
    "",
    `${graph.stats.conversations} conversations, ${graph.stats.decisions} decisions, `
      + `${graph.stats.questions} open questions, ${graph.stats.topics} shared topics, ${graph.stats.edges} edges.`,
    "",
  ];
  if (graph.stats.hubs.length) {
    lines.push("## Most connected", "", ...graph.stats.hubs.map((hub) => `- ${hub.label} (${hub.kind}, ${hub.degree} connections)`), "");
  }
  const contradictions = graph.edges.filter((edge) => edge.kind === "contradicts");
  if (contradictions.length) {
    lines.push("## Contradictions", "", ...contradictions.slice(0, 8).map((edge) => `- ${edge.reason}`), "");
  }
  const duplicates = graph.edges.filter((edge) => edge.kind === "similar");
  if (duplicates.length) {
    lines.push("## Likely duplicates", "", ...duplicates.slice(0, 8).map((edge) => `- ${labelOf(graph, edge.from)} and ${labelOf(graph, edge.to)}: ${edge.reason}`), "");
  }
  if (graph.stats.isolated.length) {
    lines.push("## Connected to nothing else", "", ...graph.stats.isolated.slice(0, 10).map((node) => `- ${node.label}`), "");
  }
  return lines.join("\n").trim();
}

function labelOf(graph: ConversationGraph, id: string): string {
  return graph.nodes.find((node) => node.id === id)?.label ?? id;
}
