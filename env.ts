/**
 * Settings this server owns, read through one function.
 *
 * The server used to be called LNKZ MCP and its settings were named LNKZ_*.
 * It is Magentic now, so the settings are MAGENTIC_*. A deployment configured
 * before the rename still works: every renamed setting keeps its old name as a
 * fallback, and using the old name prints one warning naming the replacement.
 *
 * Three settings deliberately keep their LNKZ names because they are not this
 * server's to rename. LNKZ_BASE_URL and LNKZ_API_KEY are the address of and
 * the key for the LNKZ relay this server talks to, and LNKZ_MCP_TARGETS is
 * configured on the relay. Renaming those would hide the boundary between the
 * two products, which is the one thing this repository exists to keep visible.
 */

/** New name to the old name it replaced. */
const RENAMED: Readonly<Record<string, string>> = {
  MAGENTIC_SCOPES: "LNKZ_MCP_SCOPES",
  MAGENTIC_AGENT: "LNKZ_AGENT",
  MAGENTIC_AGENTS_DIR: "LNKZ_AGENTS_DIR",
  MAGENTIC_PROFILE: "LNKZ_PROFILE",
  MAGENTIC_PROFILES_JSON: "LNKZ_PROFILES_JSON",
  MAGENTIC_LLM_PROVIDER: "LNKZ_LLM_PROVIDER",
  MAGENTIC_LLM_BASE_URL: "LNKZ_LLM_BASE_URL",
  MAGENTIC_LLM_CHAT_MODEL: "LNKZ_LLM_CHAT_MODEL",
  MAGENTIC_LLM_EMBEDDING_MODEL: "LNKZ_LLM_EMBEDDING_MODEL",
  MAGENTIC_LLM_MAX_CONVERSATIONS: "LNKZ_LLM_MAX_CONVERSATIONS",
  MAGENTIC_LLM_MAX_CHUNKS: "LNKZ_LLM_MAX_CHUNKS",
  MAGENTIC_LLM_CHUNK_CHARS: "LNKZ_LLM_CHUNK_CHARS",
  MAGENTIC_LLM_BATCH_SIZE: "LNKZ_LLM_BATCH_SIZE",
  MAGENTIC_LLM_MAX_CONTEXT_CHARS: "LNKZ_LLM_MAX_CONTEXT_CHARS",
  MAGENTIC_LLM_CACHE_SIZE: "LNKZ_LLM_CACHE_SIZE",
};

/** Warned-about names, so a long-running process says each one once. */
const warned = new Set<string>();

/**
 * Reads one Magentic setting, falling back to its pre-rename LNKZ name.
 *
 * The new name wins whenever it is set, so a deployment can adopt the new
 * names one at a time without the old ones fighting back.
 */
export function setting(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const current = env[name];
  if (current !== undefined && current !== "") return current;

  const old = RENAMED[name];
  if (!old) return current;

  const legacy = env[old];
  if (legacy === undefined || legacy === "") return current;

  if (!warned.has(old)) {
    warned.add(old);
    // stderr, not stdout: stdout is the stdio transport and anything written
    // there that is not a protocol message corrupts the session.
    process.stderr.write(`${old} is deprecated; rename it to ${name}.\n`);
  }
  return legacy;
}

/** Every setting that was renamed, for docs and tests that check the mapping. */
export function renamedSettings(): Readonly<Record<string, string>> {
  return RENAMED;
}

/** Test seam: forget which deprecations have already been warned about. */
export function resetDeprecationWarnings(): void {
  warned.clear();
}
