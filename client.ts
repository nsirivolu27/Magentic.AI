import type {
  AuditEvent,
  ConnectorStatus,
  ContextPacket,
  Conversation,
  ConversationAnalysis,
  ConversationGraph,
  ConversationInput,
  ConversationMatch,
  ConversationSummary,
  DuplicatePair,
  ExportFormat,
  HandoffIssue,
  HandoffPacket,
  HandoffSummary,
  MessageInput,
  PreparedCall,
  SearchResponse,
  StoreStats,
  TargetTools,
  ConflictPair,
  LinkPreview,
  TransferOrigin,
} from "./contract.js";

export interface LnkzClientLike {
  saveConversation(input: ConversationInput): Promise<{ conversation: Conversation }>;
  importConversations(input: unknown): Promise<{
    format: string;
    warnings: string[];
    preview?: { title: string; provider: string; messages: number }[];
    conversations?: Conversation[];
  }>;
  getConversation(id: string): Promise<{ conversation: Conversation; analysis: ConversationAnalysis }>;
  listConversations(options: Record<string, unknown>): Promise<{ conversations: ConversationSummary[] }>;
  searchConversations(input: unknown): Promise<{ matches: ConversationMatch[] }>;
  appendMessages(id: string, messages: MessageInput[]): Promise<{ conversation: Conversation }>;
  deleteConversation(id: string): Promise<void>;
  createHandoff(id: string, input: unknown): Promise<HandoffIssue>;
  redeemHandoff(token: string): Promise<HandoffPacket>;
  continueHandoff(input: unknown): Promise<{ conversation: Conversation; parentId: string }>;
  importFromUrl(input: unknown): Promise<{ conversation: Conversation; origin: TransferOrigin; warnings: string[] }>;
  previewLink(url: string): Promise<LinkPreview>;
  continueFromLink(input: unknown): Promise<{ conversation: Conversation; origin: TransferOrigin; warnings: string[] }>;
  revokeHandoff(id: string): Promise<void>;
  listHandoffs(conversationId?: string): Promise<{ handoffs: HandoffSummary[] }>;
  buildContextPacket(input: unknown): Promise<{ packet: ContextPacket }>;
  findConflicts(input: Record<string, unknown>): Promise<{ conflicts: ConflictPair[]; scanned: number }>;
  findDuplicates(input: Record<string, unknown>): Promise<{ duplicates: DuplicatePair[]; scanned: number }>;
  searchContext(input: unknown): Promise<SearchResponse>;
  listConnectors(): Promise<{ connectors: ConnectorStatus[] }>;
  stats(): Promise<{ stats: StoreStats }>;
  audit(limit: number): Promise<{ events: AuditEvent[] }>;
  exportConversation(id: string, format: ExportFormat): Promise<{
    format: ExportFormat;
    mimeType: string;
    filename: string;
    reimportable: boolean;
    body: string;
  }>;
  graph(options: Record<string, unknown>): Promise<{ graph: ConversationGraph }>;
  publishTargets(): Promise<{ targets: TargetTools[]; errors: string[] }>;
  preparePublish(input: unknown): Promise<{ prepared: PreparedCall }>;
}

export class LnkzApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "LnkzApiError";
  }
}

export class LnkzClient implements LnkzClientLike {
  private readonly baseUrl: URL;

  constructor(
    baseUrl: string,
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
  ) {
    if (!baseUrl.trim()) throw new Error("LNKZ_BASE_URL is required.");
    if (!apiKey.trim()) throw new Error("LNKZ_API_KEY is required.");
    this.baseUrl = new URL(baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
    if (!new Set(["http:", "https:"]).has(this.baseUrl.protocol)) {
      throw new Error("LNKZ_BASE_URL must use http or https.");
    }
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): LnkzClient {
    return new LnkzClient(env.LNKZ_BASE_URL ?? "", env.LNKZ_API_KEY ?? "");
  }

  saveConversation(input: ConversationInput) {
    return this.json<{ conversation: Conversation }>("api/conversations", { method: "POST", body: input });
  }

  importConversations(input: unknown) {
    return this.json<{
      format: string;
      warnings: string[];
      preview?: { title: string; provider: string; messages: number }[];
      conversations?: Conversation[];
    }>("api/conversations/import", { method: "POST", body: input });
  }

  getConversation(id: string) {
    return this.json<{ conversation: Conversation; analysis: ConversationAnalysis }>(`api/conversations/${encodeURIComponent(id)}`);
  }

  listConversations(options: Record<string, unknown>) {
    return this.json<{ conversations: ConversationSummary[] }>(`api/conversations${query(options)}`);
  }

  searchConversations(input: unknown) {
    return this.json<{ matches: ConversationMatch[] }>("api/conversations/search", { method: "POST", body: input });
  }

  appendMessages(id: string, messages: MessageInput[]) {
    return this.json<{ conversation: Conversation }>(`api/conversations/${encodeURIComponent(id)}/messages`, {
      method: "POST",
      body: { messages },
    });
  }

  async deleteConversation(id: string): Promise<void> {
    await this.response(`api/conversations/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  createHandoff(id: string, input: unknown) {
    return this.json<HandoffIssue>(`api/conversations/${encodeURIComponent(id)}/handoffs`, { method: "POST", body: input });
  }

  redeemHandoff(token: string) {
    return this.json<HandoffPacket>(`share/${encodeURIComponent(token)}`);
  }

  continueHandoff(input: unknown) {
    return this.json<{ conversation: Conversation; parentId: string }>("api/handoffs/continue", { method: "POST", body: input });
  }

  importFromUrl(input: unknown) {
    return this.json<{ conversation: Conversation; origin: TransferOrigin; warnings: string[] }>(
      "api/conversations/import-url",
      { method: "POST", body: input },
    );
  }

  /**
   * A dry run on the relay, which asks the sending instance to describe the
   * link rather than fetching the packet. It costs the link nothing, so this
   * is safe on a one-use link where looking and taking would otherwise be
   * mutually exclusive.
   */
  previewLink(url: string) {
    return this.json<LinkPreview>("api/conversations/import-url", {
      method: "POST",
      body: { url, dryRun: true },
    });
  }

  continueFromLink(input: unknown) {
    return this.json<{ conversation: Conversation; origin: TransferOrigin; warnings: string[] }>(
      "api/handoffs/continue",
      { method: "POST", body: input },
    );
  }

  async revokeHandoff(id: string): Promise<void> {
    await this.response(`api/handoffs/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  listHandoffs(conversationId?: string) {
    return this.json<{ handoffs: HandoffSummary[] }>(`api/handoffs${query({ conversationId })}`);
  }

  buildContextPacket(input: unknown) {
    return this.json<{ packet: ContextPacket }>("api/context/packet", { method: "POST", body: input });
  }

  findConflicts(input: Record<string, unknown>) {
    return this.json<{ conflicts: ConflictPair[]; scanned: number }>(`api/context/conflicts${query(input)}`);
  }

  findDuplicates(input: Record<string, unknown>) {
    return this.json<{ duplicates: DuplicatePair[]; scanned: number }>(`api/context/duplicates${query(input)}`);
  }

  searchContext(input: unknown) {
    return this.json<SearchResponse>("api/context/search", { method: "POST", body: input });
  }

  listConnectors() {
    return this.json<{ connectors: ConnectorStatus[] }>("api/connectors");
  }

  stats() {
    return this.json<{ stats: StoreStats }>("api/stats");
  }

  audit(limit: number) {
    return this.json<{ events: AuditEvent[] }>(`api/events${query({ limit })}`);
  }

  async exportConversation(id: string, format: ExportFormat) {
    const response = await this.response(`api/conversations/${encodeURIComponent(id)}/export${query({ format })}`);
    const disposition = response.headers.get("content-disposition") ?? "";
    const filename = disposition.match(/filename="([^"]+)"/)?.[1] ?? `conversation.${format}`;
    return {
      format,
      mimeType: response.headers.get("content-type")?.split(";")[0] ?? "application/octet-stream",
      filename,
      reimportable: format !== "latex",
      body: await response.text(),
    };
  }

  graph(options: Record<string, unknown>) {
    return this.json<{ graph: ConversationGraph }>(`api/graph${query(options)}`);
  }

  publishTargets() {
    return this.json<{ targets: TargetTools[]; errors: string[] }>("api/publish/targets");
  }

  preparePublish(input: unknown) {
    return this.json<{ prepared: PreparedCall }>("api/publish/prepare", { method: "POST", body: input });
  }

  private async json<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const response = await this.response(path, options);
    return response.json() as Promise<T>;
  }

  private async response(path: string, options: RequestOptions = {}): Promise<Response> {
    const headers = new Headers(options.headers);
    headers.set("accept", options.accept ?? "application/json");
    headers.set("authorization", `Bearer ${this.apiKey}`);
    let body: BodyInit | undefined;
    if (options.body !== undefined) {
      headers.set("content-type", "application/json");
      body = JSON.stringify(options.body);
    }
    const response = await this.fetchImpl(new URL(path, this.baseUrl), {
      method: options.method ?? "GET",
      headers,
      ...(body === undefined ? {} : { body }),
    });
    if (!response.ok) throw new LnkzApiError(response.status, await errorMessage(response));
    return response;
  }
}

interface RequestOptions {
  method?: "GET" | "POST" | "DELETE";
  headers?: HeadersInit;
  accept?: string;
  body?: unknown;
}

function query(values: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === null || value === "") continue;
    params.set(key, String(value));
  }
  const encoded = params.toString();
  return encoded ? `?${encoded}` : "";
}

async function errorMessage(response: Response): Promise<string> {
  const fallback = `LNKZ request failed with status ${response.status}.`;
  try {
    const payload = await response.json() as { error?: unknown };
    return typeof payload.error === "string" && payload.error ? payload.error : fallback;
  } catch {
    return fallback;
  }
}
