import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ChatModelLike } from "./provider.js";

/**
 * Using the model that is already in the room.
 *
 * Everything else in llm/ assumes the operator brings a model: an OpenAI key,
 * or an Ollama server. That is a real cost and a real decision, and it is the
 * reason ask_conversations is off on most instances.
 *
 * Sampling removes it. A client that supports it will run inference on the
 * server's behalf using whatever model the person is already talking to. No
 * key, no egress the person did not already choose, nothing for the operator
 * to pay for, and the adapter keeps the property the whole hosted design
 * rests on, which is that it holds no credential.
 *
 * What sampling does not give is embeddings. There is no protocol request for
 * "vectorise this", so semantic_search still needs a provider. The answer is
 * not to disable ask_conversations without one, it is to retrieve lexically
 * through the relay's own index and let the client's model do the reading.
 * That is worse at recall than embeddings and much better than nothing, and
 * every result says which of the two produced it.
 *
 * The honest limit: the person's client decides whether to allow a sampling
 * request, may show it to them first, and may refuse. A refusal is a normal
 * answer here, not an error to route around.
 */

/** How much the model may write back. A grounded answer is not a long one. */
const DEFAULT_MAX_TOKENS = 1_200;

/**
 * Does the connected client offer its model?
 *
 * Only true after initialize, which is why the tools that depend on it are
 * registered from the initialized hook rather than at construction.
 */
export function clientSupportsSampling(server: McpServer): boolean {
  try {
    return Boolean(server.server.getClientCapabilities()?.sampling);
  } catch {
    // Called before a client connected. Not an error, just not yet known.
    return false;
  }
}

/**
 * A ChatModelLike backed by the client's model.
 *
 * Deliberately the same interface the LangChain providers satisfy, so the
 * retrieval code cannot tell which tier it is talking to and nothing
 * downstream has to branch.
 */
export function samplingChatModel(server: McpServer, maxTokens = DEFAULT_MAX_TOKENS): ChatModelLike {
  return {
    async invoke(input: string): Promise<{ content: unknown }> {
      const result = await server.server.createMessage({
        messages: [{ role: "user", content: { type: "text", text: input } }],
        maxTokens,
        // The server is asking for a grounded reading of text it already
        // holds. It is not asking the client to go and use its own tools.
        includeContext: "none",
        // Same reasoning as the provider tier: this task has a right answer,
        // and sampling would only add ways to miss it.
        temperature: 0,
      });
      return { content: readContent(result.content) };
    },
  };
}

/**
 * A sampling result is one content block, or several when the client returned
 * tool calls. Only text is meaningful here; anything else reads as empty
 * rather than as a stringified object.
 */
function readContent(content: unknown): string {
  if (Array.isArray(content)) return content.map(readContent).filter(Boolean).join("");
  if (!content || typeof content !== "object") return "";
  const block = content as { type?: unknown; text?: unknown };
  return block.type === "text" && typeof block.text === "string" ? block.text : "";
}

/** Which model answered, for the line printed under every result. */
export type ModelTier = "sampling" | "provider";

export interface ChosenModel {
  tier: ModelTier;
  model: ChatModelLike;
}

/**
 * Sampling first, the configured provider second.
 *
 * Sampling is preferred even when a provider exists, because the person's own
 * model is the one they chose, it costs the operator nothing, and it sends
 * their conversation text somewhere they already send it. A configured
 * provider is the fallback for clients that cannot sample, not an upgrade.
 */
export async function chooseChatModel(
  server: McpServer,
  configuredProvider?: () => Promise<ChatModelLike>,
): Promise<ChosenModel | undefined> {
  if (clientSupportsSampling(server)) {
    return { tier: "sampling", model: samplingChatModel(server) };
  }
  if (configuredProvider) {
    return { tier: "provider", model: await configuredProvider() };
  }
  return undefined;
}
