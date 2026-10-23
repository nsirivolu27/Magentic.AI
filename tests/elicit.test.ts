import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { LnkzClientLike } from "../client.js";
import { missingChoices } from "../elicit.js";
import { createLnkzMcpServer } from "../mcp.js";

const CONVERSATION = "11111111-1111-4111-8111-111111111111";
const now = "2026-01-01T00:00:00.000Z";

interface Minted { conversationId: string; request: Record<string, unknown> }

function stubClient(minted: Minted[]): LnkzClientLike {
  return {
    listConversations: async () => ({
      conversations: [{
        id: CONVERSATION, version: 1, title: "Storage choice",
        source: { provider: "chatgpt" }, participants: [], tags: [],
        createdAt: now, updatedAt: now, messageCount: 4,
      }],
    }),
    createHandoff: async (conversationId: string, request: unknown) => {
      const body = request as Record<string, unknown>;
      minted.push({ conversationId, request: body });
      return {
        id: "22222222-2222-4222-8222-222222222222",
        token: "a".repeat(24),
        shareUrl: "https://lnkz.test/s/abc",
        expiresAt: now,
        maxUses: Number(body.maxUses ?? 25),
        redact: Boolean(body.redact),
      };
    },
  } as unknown as LnkzClientLike;
}

/** A client that can put a question to a person, and answers it however we say. */
async function connect(
  minted: Minted[],
  elicit?: { reply: () => { action: string; content?: Record<string, unknown> } | never; seen: unknown[] },
) {
  const server = createLnkzMcpServer(stubClient(minted));
  const client = new Client(
    { name: "elicit-test", version: "1.0.0" },
    elicit ? { capabilities: { elicitation: {} } } : {},
  );
  if (elicit) {
    client.setRequestHandler(ElicitRequestSchema, async (request) => {
      elicit.seen.push(request.params);
      return elicit.reply() as never;
    });
  }
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

// ------------------------------------------------------------------ what counts as unanswered

test("only the fields the caller left out are unanswered", () => {
  assert.deepEqual(missingChoices({ conversationId: CONVERSATION }), ["ttlMinutes", "maxUses", "redact"]);
  assert.deepEqual(missingChoices({ conversationId: CONVERSATION, ttlMinutes: undefined }), ["ttlMinutes", "maxUses", "redact"]);
  assert.deepEqual(missingChoices({ ttlMinutes: 15, maxUses: 1, redact: true }), []);
  assert.deepEqual(missingChoices({ redact: false }), ["ttlMinutes", "maxUses"]);
  // Explicitly choosing the old default is a decision, not an omission.
  assert.deepEqual(missingChoices({ ttlMinutes: 60, maxUses: 25, redact: false }), []);
  assert.deepEqual(missingChoices(undefined), ["ttlMinutes", "maxUses", "redact"]);
});

// ------------------------------------------------------------------ clients that cannot ask

test("a client that cannot ask gets exactly the behaviour it had before", async (t) => {
  const minted: Minted[] = [];
  const { client, close } = await connect(minted);
  t.after(close);

  await client.callTool({ name: "create_handoff", arguments: { conversationId: CONVERSATION } });
  assert.equal(minted.length, 1);
  assert.equal(minted[0]?.request.ttlMinutes, 60);
  assert.equal(minted[0]?.request.maxUses, 25);
  assert.equal(minted[0]?.request.redact, false);
});

// ------------------------------------------------------------------ clients that can

test("the unanswered questions are put to the person, and their answers are used", async (t) => {
  const minted: Minted[] = [];
  const seen: unknown[] = [];
  const { client, close } = await connect(minted, {
    seen,
    reply: () => ({ action: "accept", content: { ttlMinutes: "15", maxUses: "1", redact: true } }),
  });
  t.after(close);

  await client.callTool({ name: "create_handoff", arguments: { conversationId: CONVERSATION } });
  assert.equal(minted.length, 1);
  assert.equal(minted[0]?.request.ttlMinutes, 15, "the answer beats the default");
  assert.equal(minted[0]?.request.maxUses, 1);
  assert.equal(minted[0]?.request.redact, true);
});

test("the question names the conversation and says what the link grants", async (t) => {
  const minted: Minted[] = [];
  const seen: unknown[] = [];
  const { client, close } = await connect(minted, {
    seen,
    reply: () => ({ action: "accept", content: { ttlMinutes: "60", maxUses: "3", redact: true } }),
  });
  t.after(close);

  await client.callTool({ name: "create_handoff", arguments: { conversationId: CONVERSATION } });
  const params = seen[0] as { message: string; requestedSchema: { properties: Record<string, unknown>; required?: string[] } };
  assert.match(params.message, /Storage choice/, "a person cannot judge a link for an unnamed conversation");
  assert.match(params.message, /Anyone holding this link/);
  assert.deepEqual(Object.keys(params.requestedSchema.properties).sort(), ["maxUses", "redact", "ttlMinutes"]);
});

test("a field the caller already decided is not asked about", async (t) => {
  const minted: Minted[] = [];
  const seen: unknown[] = [];
  const { client, close } = await connect(minted, {
    seen,
    reply: () => ({ action: "accept", content: { ttlMinutes: "480" } }),
  });
  t.after(close);

  await client.callTool({
    name: "create_handoff",
    arguments: { conversationId: CONVERSATION, maxUses: 2, redact: true },
  });
  const params = seen[0] as { requestedSchema: { properties: Record<string, unknown> } };
  assert.deepEqual(Object.keys(params.requestedSchema.properties), ["ttlMinutes"]);
  assert.equal(minted[0]?.request.maxUses, 2, "what the caller passed is what is used");
  assert.equal(minted[0]?.request.redact, true);
  assert.equal(minted[0]?.request.ttlMinutes, 480);
});

test("nothing is asked when the caller answered everything", async (t) => {
  const minted: Minted[] = [];
  const seen: unknown[] = [];
  const { client, close } = await connect(minted, { seen, reply: () => ({ action: "accept", content: {} }) });
  t.after(close);

  await client.callTool({
    name: "create_handoff",
    arguments: { conversationId: CONVERSATION, ttlMinutes: 30, maxUses: 5, redact: false },
  });
  assert.equal(seen.length, 0, "a model that already decided should not be made to re-answer");
  assert.equal(minted[0]?.request.ttlMinutes, 30);
});

// ------------------------------------------------------------------ saying no

for (const action of ["decline", "cancel"] as const) {
  test(`a ${action} mints nothing, because being shown the question is not agreeing to the default`, async (t) => {
    const minted: Minted[] = [];
    const seen: unknown[] = [];
    const { client, close } = await connect(minted, { seen, reply: () => ({ action }) });
    t.after(close);

    const result = await client.callTool({ name: "create_handoff", arguments: { conversationId: CONVERSATION } });
    assert.equal(result.isError, true);
    assert.equal(minted.length, 0, "no bearer link exists for a question nobody answered");
    const text = (result.content as { text: string }[])[0]?.text ?? "";
    assert.match(text, /No handoff was created/);
    assert.match(text, /ttlMinutes, maxUses and redact directly/, "and it says how to proceed without being asked");
  });
}

test("a client that advertises elicitation and then fails falls back rather than breaking the call", async (t) => {
  const minted: Minted[] = [];
  const seen: unknown[] = [];
  const { client, close } = await connect(minted, {
    seen,
    reply: () => { throw new Error("elicitation exploded"); },
  });
  t.after(close);

  await client.callTool({ name: "create_handoff", arguments: { conversationId: CONVERSATION } });
  assert.equal(minted.length, 1, "a broken prompt should cost the question, not the handoff");
  assert.equal(minted[0]?.request.ttlMinutes, 60);
});

test("the result says whether the packet was redacted", async (t) => {
  const minted: Minted[] = [];
  const seen: unknown[] = [];
  const { client, close } = await connect(minted, {
    seen,
    reply: () => ({ action: "accept", content: { ttlMinutes: "60", maxUses: "3", redact: false } }),
  });
  t.after(close);

  const result = await client.callTool({ name: "create_handoff", arguments: { conversationId: CONVERSATION } });
  const text = (result.content as { text: string }[])[0]?.text ?? "";
  assert.match(text, /Storage choice/);
  assert.match(text, /not redacted/, "the one property of a link someone most needs to know");
});
