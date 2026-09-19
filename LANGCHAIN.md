# LangChain in the adapter

**Status: built and optional. `ask_conversations` works with no provider at all when the client supports sampling; `semantic_search` needs one.** No LangChain package is
installed by this repository, nothing imports one at the top level, and the
adapter typechecks, tests, bundles and runs without any of them.

## Where it lives, and why not in LNKZ

LangChain is here, in the adapter, and not in the relay.

The relay's analysis is deterministic on purpose. `find_conflicts` returns the
same pairs today and next month, a context packet's claims trace to the
message ids they came from, and a conversation that was never sent anywhere
was never sent anywhere. A model in that path costs all three: results stop
being reproducible, a claim becomes something a model said rather than
something a person did, and embedding a conversation means transmitting it.

The adapter is already a client of the relay. It holds no database, reads
over REST with an ordinary API key, and can be run by someone other than the
person who runs the relay. That is the right side of the line for anything
that involves a model, and it is the same line `ENRICHMENT.md` draws.

So the relay keeps the ground truth and the adapter derives from it. Nothing
derived is written back.

## What it adds

Two read-only tools, registered only when `MAGENTIC_LLM_PROVIDER` is set:

- **`semantic_search`** ranks conversation passages by meaning rather than by
  shared words. It answers the case the relay's own search cannot: the
  subject was discussed, in different words than the question uses.
- **`ask_conversations`** answers a question from the stored conversations,
  with a numbered citation on every claim and an explicit refusal when the
  conversations do not contain the answer.

Both name the conversation and the message ids behind every result, so an
answer can be checked against the turn it came from.

## Three tiers, and why the cheapest one is the default

A provider is no longer required for `ask_conversations`, and that changed
the shape of the whole feature.

**Sampling first.** A client that supports it will run inference for the
server using whatever model the person is already talking to. No key, no cost
to the operator, no egress the person did not already choose, and the adapter
keeps holding nothing. It is preferred even when a provider is configured,
because the person's own model is the one they picked.

**A configured provider second.** The LangChain path below, for clients that
cannot sample.

**Nothing third**, which says which of the two to fix rather than failing
vaguely.

Retrieval tiers the same way. With an embedding model, passages are ranked by
meaning. Without one, the relay's own keyword index supplies the candidates
and plain term overlap orders them. That is worse at exactly the case
embeddings exist for, a question phrased in different words than the answer,
so every result prints which path ran instead of leaving someone to guess why
recall felt thin.

What sampling cannot do is embed. There is no protocol request for
"vectorise this", so `semantic_search` still needs a provider and stays
hidden without one. `ask_conversations` is always registered instead, because
whether it works depends on the connecting client rather than on anything
knowable when the server is built, and because capabilities are negotiated
during initialize, so a server that declared no tools then cannot add one
afterwards.

## Verifying that LangChain itself still fits

`provider.ts` depends on two interfaces of ours rather than on LangChain's
types, which is what lets every other test run with no package installed. The
cost is precise: nothing would catch a renamed export or a changed method
name until the first tool call on a machine that actually has the package.

`tests/langchain-contract.test.ts` is that check. It constructs the real
classes through the same variable-specifier import the product uses and
asserts they satisfy `EmbeddingsLike` and `ChatModelLike`. It skips when the
package is absent, naming the install command, and runs for real the moment
someone installs one. Nothing in it reaches the network.

## The optimizations, and what each one is for

**Two-stage retrieval.** The relay's keyword search and the most recent
conversations supply candidates; embeddings rank only those. Embedding the
whole corpus for one question would cost in proportion to how much someone
has ever stored rather than how much of it is relevant, and would get slower
the longer they use the product. Keyword search gives recall cheaply,
embeddings give precision over a bounded set, and recency covers the question
whose answer shares none of its words.

**A content-addressed embedding cache.** Keyed by a hash of the model name
and the passage text. Unchanged text is never embedded twice, appending a
message re-embeds one passage rather than a conversation, and changing the
embedding model invalidates everything at once instead of quietly mixing
vectors from two models in one comparison. Bounded and least-recently-used,
because this process is long lived.

**Deduplication before the request.** Identical text in two conversations is
one embedding. On a relay whose purpose is copying conversations between
instances, duplicated transcripts are the normal case, not the exception.

**Batching and concurrency.** Passages go out `MAGENTIC_LLM_BATCH_SIZE` at a time.
The query vector and the passage vectors are requested concurrently, since
waiting for one before starting the other adds a round trip to every query.
Relay reads run six at a time.

**Message-boundary chunking.** A conversation is already split, into turns
with an author and a time. A character splitter cuts through the middle of a
turn and produces a passage that says "yes, do that" with no way to tell what
"that" was, and loses the message id, which is the only thing that makes a
citation checkable.

**A hard character ceiling on grounding text.** Enforced here rather than
trusted to the context window, because a context window limits what fits, not
what an operator agreed to send or pay for.

**Nothing loads until it is used.** An MCP client spawns this adapter as a
subprocess for every session, so startup cost is paid every session. The
provider packages are imported dynamically, through a variable specifier, on
the first call that needs one.

## What was deliberately not used

- **The `langchain` umbrella package.** It was wanted for
  `MemoryVectorStore`, which is thirty lines of arithmetic behind agents,
  chains and output parsers. For a few hundred passages per query, a linear
  scan over an array is faster than a vector database and is one less thing
  to install. `llm/chunk.ts` has it.
- **`RecursiveCharacterTextSplitter`.** See message-boundary chunking above.
- **`ChatPromptTemplate`.** Its escaping rules would apply to conversation
  text nobody controls, so a transcript containing braces would either throw
  or interpolate. A template string has neither failure mode.
- **LangChain's types.** The code depends on two interfaces defined in
  `llm/provider.ts`, `EmbeddingsLike` and `ChatModelLike`, which are the shape
  LangChain's classes already have. That is what lets the test suite drive the
  entire retrieval path with no network, no key and no package installed.

## Turning it on

```
pnpm add @langchain/ollama          # or @langchain/openai
MAGENTIC_LLM_PROVIDER=ollama
MAGENTIC_LLM_BASE_URL=http://127.0.0.1:11434
```

See `.env.example` for the rest, including the per-query cost ceilings.

`ollama` against a server you run keeps conversations on your own hardware,
which is the configuration this product is for. `openai` sends passage text
to OpenAI; the tool descriptions say so, and every result prints how much was
sent.
