import { optionsFromEnv } from "./mcp.js";
import { catalogFor, defaultAgentsDirectory } from "./catalog/select.js";

/**
 * What is in this repository, without starting anything.
 *
 * Choosing an agent should not require running a server first, and on a
 * laptop there may be no server at all. This prints the same catalog the
 * hosted build serves at /agents, read from the same files.
 */
const json = process.argv.includes("--json");
// The same scope reading the servers do, so this prints what they would
// serve rather than an optimistic version of it.
const allowWrites = optionsFromEnv().allowWrites ?? true;

let catalog;
try {
  // LNKZ_AGENT is irrelevant here, but catalogFor treats it as a reason to
  // make a load failure fatal, and for this command a failure always is.
  catalog = catalogFor(import.meta.url, allowWrites, { ...process.env, LNKZ_AGENT: "list" });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

if (!catalog || catalog.entries.length === 0) {
  console.error(`No agent definitions found in ${defaultAgentsDirectory(import.meta.url)}.`);
  process.exit(1);
}

if (json) {
  const { toPublicAgent } = await import("./catalog/schema.js");
  console.log(JSON.stringify({ object: "list", data: catalog.entries.map(toPublicAgent) }, null, 2));
} else {
  console.log(`${catalog.entries.length} agents in ${defaultAgentsDirectory(import.meta.url)}\n`);
  for (const entry of catalog.entries) {
    const access = entry.writesAllowed ? "read+write" : "read";
    console.log(`${entry.definition.name}`);
    console.log(`  ${entry.definition.title}: ${entry.definition.description}`);
    console.log(`  ${entry.activeTools.size} tools, ${access}, v${entry.definition.version} by ${entry.definition.publisher}`);
    if (entry.unavailableTools.length) {
      console.log(`  not available on this build: ${entry.unavailableTools.join(", ")}`);
    }
    console.log(`  stdio:  LNKZ_AGENT=${entry.definition.name}`);
    console.log(`  hosted: ${entry.endpoint}\n`);
  }
}
