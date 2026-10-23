# LNKZ MCP hosting and retrieval decisions

**Nihal:** Integrate LangChain and optimize its usage inside the MCP backend.

**Claude:** It goes in the adapter, not in the relay. The relay's analysis is deterministic on purpose: find_conflicts returns the same pairs next month, a context packet's claims trace to the message ids they came from, and a conversation that was never sent anywhere was never sent anywhere. A model in that path costs all three. The adapter is already a REST client of the relay and holds no database, so anything involving a model belongs there. That is the same line ENRICHMENT.md drew.

**Nihal:** What does it actually add.

**Claude:** Two read-only tools. semantic_search ranks conversation passages by meaning rather than shared words, for the case where the subject was discussed in different words than the question uses. ask_conversations answers a question from the stored conversations with a numbered citation on every claim and an explicit refusal when the answer is not there. Both name the conversation and message ids behind every result. Neither writes anything back, because a model's reading of a conversation is a derivation, and once a derivation sits next to the conversation it stops being obvious which is which.

**Claude:** Retrieval is two stages. The relay's own keyword search plus the most recent conversations supply candidates, and embeddings rank only those. Embedding the whole corpus for one question would cost in proportion to how much someone has ever stored rather than how much of it is relevant, and it would get slower the longer they use the product. Keyword search gives recall cheaply, embeddings give precision over a bounded set, and recency covers the question whose answer shares none of its words.

**Claude:** Embeddings are cached by a hash of the model name and the passage text. Unchanged text is never embedded twice, appending a message re-embeds one passage rather than a conversation, and changing the embedding model invalidates everything at once instead of quietly mixing vectors from two models in one similarity comparison. Identical text across two conversations is embedded once, which matters on a relay whose purpose is copying conversations between instances.

**Claude:** Chunks are whole messages rather than character windows. A conversation is already split into turns with an author and a time, and cutting through the middle of a turn produces a passage that says "yes, do that" with no way to tell what "that" was, and loses the message id that makes a citation checkable.

**Claude:** The langchain umbrella package was deliberately not used. It was wanted for MemoryVectorStore, which is thirty lines of arithmetic behind agents, chains and output parsers. For a few hundred passages per query a linear scan over an array is faster than a vector database. ChatPromptTemplate was skipped too, because its escaping rules would apply to conversation text nobody controls, so a transcript containing braces would either throw or interpolate.

**Claude:** Ollama is a first-class provider alongside OpenAI. An integration that required OpenAI would contradict a product whose premise is that conversations stay on the instance that holds them.

**Nihal:** Build out the MCP so it can be hosted like Groq, where it shows any AI agents hosted in the server, then use that to get the configurable part correct.

**Claude:** Three decisions settled this. An agent is a configured tool bundle, not a model-backed agent, which makes it the same record MARKETPLACE.md already calls a package. A client selects one by URL, one endpoint per agent at /mcp/<name>, which works with every MCP client today and needs no protocol extension. Definitions are files in the server loaded at boot, reviewable in a pull request, with the registry becoming a second loader later.

**Claude:** An agent cannot name a relay, cannot carry a key, and cannot widen what the deployment allows. Scopes are a request rather than a grant, so LNKZ_MCP_SCOPES=read turns every agent read-only however its file is written, and the published tool list is narrowed to match so the catalog never promises what the endpoint will not serve.

**Claude:** Everything that can be wrong is wrong at boot: a tool the build does not register, two files claiming one name, malformed JSON, a misspelled key. A catalog that half loaded reports healthy and then fails one connection at a time. The known tool set is read out of the build rather than typed into a list, so the check cannot drift from what is registered.

**Claude:** Three agents ship. conversation-relay is the core use case, sixteen tools, read and write. research-reader is twelve tools and changes nothing, safe to hand to a collaborator. handoff-desk is ten tools and does only the passing: mint, preview, redeem, revoke.

**Nihal:** I want to use it myself before thinking about server deployment.

**Claude:** That exposed a real gap. Agents only existed on the hosted path, so from a laptop there was no way to use one. LNKZ_AGENT now selects a single agent for a stdio process, which is what makes it work from Claude Desktop with nothing deployed. The agents directory resolves from the built file rather than the working directory, because a desktop client sets cwd wherever it likes and a relative default would work by hand and fail from the client.
