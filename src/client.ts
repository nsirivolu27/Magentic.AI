import { createHmac } from "node:crypto";
import type { Conversation, ConversationInput, HandoffPacket } from "./types.js";

export interface RestTextResponse {
  body: string;
  contentType: string;
}

export interface LnkzRestClient {
  request<T>(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<T>;
  requestText(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<RestTextResponse>;
}

/**
 * The adapter has no store of its own. Every operation is an authenticated,
 * deliberately boring REST call to the LLMM/LNKZ relay.
 */
export function createLnkzRestClient(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): LnkzRestClient {
  const baseUrl = env.LNKZ_BASE_URL?.trim();
  const apiKey = env.LNKZ_API_KEY?.trim();
  if (!baseUrl || !apiKey) {
    throw new Error("LNKZ_BASE_URL and LNKZ_API_KEY are required.");
  }

  let parsedBase: URL;
  try {
    parsedBase = new URL(baseUrl);
    if (parsedBase.protocol !== "http:" && parsedBase.protocol !== "https:") throw new Error();
  } catch {
    throw new Error("LNKZ_BASE_URL must be an absolute http or https URL.");
  }

  const contextHeader = buildContextHeader(env);

  async function execute(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<Response> {
    const url = new URL(path.replace(/^\/+/, ""), `${parsedBase.toString().replace(/\/?$/, "/")}`);
    const headers = new Headers(extraHeaders);
    headers.set("authorization", `Bearer ${apiKey}`);
    headers.set("accept", "application/json");
    if (contextHeader) headers.set("x-lnkz-context", contextHeader);
    if (body !== undefined) {
      headers.set("content-type", "application/json");
    }
    return fetchImpl(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  async function request<T>(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<T> {
    const response = await execute(method, path, body, headers);
    const text = await response.text();
    if (!response.ok) throw restError(response.status);
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`LNKZ REST ${method} ${path} returned invalid JSON.`);
    }
  }

  async function requestText(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<RestTextResponse> {
    const response = await execute(method, path, body, headers);
    const text = await response.text();
    if (!response.ok) throw restError(response.status);
    return { body: text, contentType: response.headers.get("content-type") ?? "text/plain" };
  }

  return { request, requestText };
}

export type LnkzApi = LnkzRestClient;

export function buildContextHeader(env: NodeJS.ProcessEnv): string | undefined {
  const secret = env.LNKZ_MCP_CONTEXT_SECRET?.trim();
  const workspaceId = env.LNKZ_CONTEXT_WORKSPACE_ID?.trim();
  const actorId = env.LNKZ_CONTEXT_ACTOR_ID?.trim();
  const scopes = (env.LNKZ_CONTEXT_SCOPES ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  const traceId = env.LNKZ_CONTEXT_TRACE_ID?.trim();
  if (!secret && !workspaceId && !actorId && scopes.length === 0 && !traceId) return undefined;
  if (!secret || !workspaceId || !actorId || !traceId || scopes.length === 0) {
    throw new Error("Signed MCP context requires LNKZ_MCP_CONTEXT_SECRET, workspace, actor, scopes, and trace ID.");
  }
  const payload = {
    workspaceId,
    actorId,
    scopes: [...new Set(scopes)],
    exp: Math.floor(Date.now() / 1000) + 60,
    traceId,
  };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = createHmac("sha256", secret).update(`v1.${encoded}`).digest("base64url");
  return `v1.${encoded}.${signature}`;
}

function restError(status: number): Error {
  return new Error(`LNKZ REST request failed with HTTP ${status}.`);
}

export function conversationFromPacket(packet: HandoffPacket): Conversation {
  return packet.conversation;
}

export type { ConversationInput };