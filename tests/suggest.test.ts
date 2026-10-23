import assert from "node:assert/strict";
import test from "node:test";
import type { LnkzClientLike } from "../client.js";
import type { ConversationSummary } from "../contract.js";
import { SuggestionCache, createSuggestions, resolveConversation, shortId } from "../suggest.js";

const now = "2026-01-01T00:00:00.000Z";

function summary(id: string, title: string, provider = "chatgpt", tags: string[] = []): ConversationSummary {
  return {
    id, version: 1, title,
    source: { provider },
    participants: ["Nihal"],
    tags,
    createdAt: now, updatedAt: now, messageCount: 4,
  };
}

const STORAGE = "11111111-1111-4111-8111-111111111111";
const DEPLOY = "22222222-2222-4222-8222-222222222222";
const STORAGE_COPY = "33333333-3333-4333-8333-333333333333";

function stubClient(corpus: ConversationSummary[], counts = { list: 0, get: 0 }): LnkzClientLike {
  return {
    listConversations: async () => { counts.list += 1; return { conversations: corpus }; },
    getConversation: async (id: string) => {
      counts.get += 1;
      const hit = corpus.find((entry) => entry.id === id);
      if (!hit) throw new Error("not found");
      return { conversation: { ...hit, messages: [] }, analysis: undefined as never };
    },
  } as unknown as LnkzClientLike;
}

const corpus = [
  summary(STORAGE, "Storage choice", "chatgpt", ["infra", "decisions"]),
  summary(DEPLOY, "Deploy target", "claude", ["infra"]),
  summary(STORAGE_COPY, "Storage choice", "lnkz", ["imported"]),
  summary("44444444-4444-4444-8444-444444444444", "Retrieval design", "claude", ["decisions"]),
];

// ------------------------------------------------------------------ the cache

test("four keystrokes cost one relay request, not four", async () => {
  const counts = { list: 0, get: 0 };
  const suggestions = createSuggestions(stubClient(corpus, counts));
  await Promise.all(["s", "st", "sto", "stor"].map((prefix) => suggestions.conversationTitles(prefix)));
  assert.equal(counts.list, 1, "typing must not be one request per character");
});

test("a failed lookup is not remembered as a failure", async () => {
  let attempts = 0;
  const cache = new SuggestionCache(60_000);
  const load = async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("upstream down");
    return ["recovered"];
  };
  await assert.rejects(() => cache.get("k", load));
  assert.deepEqual(await cache.get("k", load), ["recovered"], "the next keystroke retries rather than serving a cached failure");
  assert.equal(attempts, 2);
});

test("an expired entry is refetched", async () => {
  const counts = { list: 0, get: 0 };
  const suggestions = createSuggestions(stubClient(corpus, counts), new SuggestionCache(-1));
  await suggestions.conversationTitles("s");
  await suggestions.conversationTitles("s");
  assert.equal(counts.list, 2);
});

// ------------------------------------------------------------------ what gets suggested

test("completion offers titles, because nobody recognises a uuid", async () => {
  const suggestions = createSuggestions(stubClient(corpus));
  const values = await suggestions.conversationTitles("de");
  assert.ok(values.includes("Deploy target"));
  assert.equal(values.some((value) => value.includes("-4")), false, "no raw uuids in a list a person reads");
});

test("prefix matches come before substring matches", async () => {
  const suggestions = createSuggestions(stubClient([
    summary("a0000000-0000-4000-8000-000000000000", "Design review"),
    summary("b0000000-0000-4000-8000-000000000000", "Retrieval design"),
  ]));
  const values = await suggestions.conversationTitles("des");
  assert.deepEqual(values, ["Design review", "Retrieval design"]);
});

test("two conversations with one title are disambiguated, not listed twice", async () => {
  const suggestions = createSuggestions(stubClient(corpus));
  const values = await suggestions.conversationTitles("storage");
  assert.equal(values.length, 2);
  assert.ok(values.includes("Storage choice"));
  assert.ok(values.includes(`Storage choice (${shortId(STORAGE_COPY)})`), "the duplicate carries its short id");
});

test("tags and providers are suggested from what is actually stored", async () => {
  const suggestions = createSuggestions(stubClient(corpus));
  assert.deepEqual(await suggestions.tags("in"), ["infra"]);
  assert.deepEqual((await suggestions.providers("")).sort(), ["chatgpt", "claude", "lnkz"]);
});

test("an unreachable relay yields no suggestions rather than an error", async () => {
  const broken = { listConversations: async () => { throw new Error("down"); } } as unknown as LnkzClientLike;
  const suggestions = createSuggestions(broken);
  assert.deepEqual(await suggestions.conversationTitles("s"), []);
  assert.deepEqual(await suggestions.tags("x"), []);
});

// ------------------------------------------------------------------ resolving what was typed

test("a full id resolves directly", async () => {
  const client = stubClient(corpus);
  const result = await resolveConversation(client, STORAGE, createSuggestions(client));
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.conversation.id, STORAGE);
});

test("an id is matched regardless of case", async () => {
  const client = stubClient(corpus);
  const result = await resolveConversation(client, STORAGE.toUpperCase(), createSuggestions(client));
  assert.equal(result.ok, true);
});

test("an exact title resolves when it is unique", async () => {
  const client = stubClient(corpus);
  const result = await resolveConversation(client, "Deploy target", createSuggestions(client));
  assert.equal(result.ok && result.conversation.id, DEPLOY);
});

test("a title prefix resolves when it matches one conversation", async () => {
  const client = stubClient(corpus);
  const result = await resolveConversation(client, "Retrie", createSuggestions(client));
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.conversation.title, "Retrieval design");
});

test("an ambiguous title is refused and lists the candidates", async () => {
  const client = stubClient(corpus);
  const result = await resolveConversation(client, "Storage choice", createSuggestions(client));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.message, /matches 2 conversations/);
  assert.match(result.message, new RegExp(shortId(STORAGE)));
  assert.match(result.message, new RegExp(shortId(STORAGE_COPY)));
});

test("the label completion produced round-trips back to the right conversation", async () => {
  // This is the whole contract: what completion inserts must be something
  // the tool accepts, and must name the conversation the person picked.
  const client = stubClient(corpus);
  const suggestions = createSuggestions(client);
  for (const label of await suggestions.conversationTitles("storage")) {
    const result = await resolveConversation(client, label, suggestions);
    if (label.includes("(")) {
      assert.equal(result.ok, true, `the disambiguated label "${label}" must resolve`);
      assert.equal(result.ok && result.conversation.id, STORAGE_COPY);
    } else {
      // The bare title is genuinely ambiguous and must say so rather than guess.
      assert.equal(result.ok, false);
    }
  }
});

test("a short id resolves, because that is what the label shows", async () => {
  const client = stubClient(corpus);
  const result = await resolveConversation(client, shortId(DEPLOY), createSuggestions(client));
  assert.equal(result.ok && result.conversation.id, DEPLOY);
});

test("nothing matching says so, and says where to look", async () => {
  const client = stubClient(corpus);
  const result = await resolveConversation(client, "not a thing", createSuggestions(client));
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.message, /list_conversations/);
});

test("an empty reference is refused before any request is made", async () => {
  const counts = { list: 0, get: 0 };
  const client = stubClient(corpus, counts);
  const result = await resolveConversation(client, "   ", createSuggestions(client, new SuggestionCache()));
  assert.equal(result.ok, false);
  assert.equal(counts.list, 0);
  assert.equal(counts.get, 0);
});
