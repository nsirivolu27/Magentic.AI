import type { IncomingMessage } from "node:http";
import type { ChatAccess } from "./chat-access.js";
import type { WorkspaceIdentity } from "./server.js";

export function companyChatIdentity(access: ChatAccess, authenticate: (request: IncomingMessage) => Promise<WorkspaceIdentity | undefined>) {
  return async (request: IncomingMessage): Promise<WorkspaceIdentity | undefined> => {
    const token = request.headers.authorization?.replace(/^Bearer /, "") ?? "";
    if (!token.startsWith("mchat_")) return authenticate(request);
    // A chat credential never becomes a company session or a workflow write credential.
    if (new URL(request.url ?? "/", "http://localhost").pathname !== "/api/chat-mcp") return undefined;
    const identity = access.authenticateToken(token);
    const selected = request.headers["x-magentic-workspace"];
    return selected !== undefined && selected !== identity?.workspaceId ? undefined : identity;
  };
}
