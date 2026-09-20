/**
 * A worked Department of State workspace.
 *
 * Runs the real transition API rather than writing records by hand, so the
 * audit log this produces is a genuine one: every signature in it was made
 * by a call anyone can read, and the hashes are hashes of the definitions
 * that ended up on disk.
 *
 * Three agents on purpose, one in each state, because the point a reviewer
 * needs to see is not that approved agents work. It is that an unapproved
 * one is absent from the endpoint while still being present in the registry.
 *
 *   npx tsx workspaces/seed-state.ts ./registry-data
 */
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AgentDefinition } from "../catalog/schema.js";
import { fileAudit } from "../registry/audit.js";
import { fileStore } from "../registry/store.js";
import { approve, authorDraft, submit, type TransitionContext } from "../registry/transition.js";

const WORKSPACE = "dos-consular";

const CASE_INTAKE: AgentDefinition = {
  name: "records-intake",
  title: "Records intake",
  description:
    "Scopes an incoming records request: finds what exists, reports what it found, and changes nothing. "
    + "The read-only half of case work, so it can be handed to anyone without a second thought about permissions.",
  category: "records",
  version: "1.0.0",
  tools: ["search_conversations", "list_conversations", "get_conversation", "search_context", "list_connectors"],
  optionalTools: ["semantic_search"],
  scopes: ["read"],
  instructions:
    "Scope a records request. Search the workspace and every configured source, report what exists and where, "
    + "and name the sources that failed rather than filling the gap. Cite the conversation id behind every claim. "
    + "Do not draft a response and do not judge exemptions; that is a separate, approved step.",
  publisher: "magentic",
};

const CASE_PACKAGE: AgentDefinition = {
  name: "response-package",
  title: "Response package",
  description:
    "Assembles the evidence package for a scoped request: the records, what was analyzed, and the provenance "
    + "behind each one. Writes, so it is the agent a second approver should look at hardest.",
  category: "records",
  version: "0.2.0",
  tools: ["get_conversation", "analyze_conversation", "export_conversation", "build_context_packet", "audit_log"],
  optionalTools: [],
  scopes: ["read", "write"],
  instructions:
    "Assemble a response package for a scoped request. Separate what the record states from what was inferred, "
    + "keep the provenance on every item, and list what was withheld and under which stated basis. "
    + "Never assert a basis the case file does not already carry.",
  publisher: "magentic",
};

const CASE_TRIAGE: AgentDefinition = {
  name: "queue-triage",
  title: "Queue triage",
  description:
    "Ranks an open queue by what is closest to a deadline and what is blocked. Drafted, not yet reviewed.",
  category: "records",
  version: "0.1.0",
  tools: ["list_conversations", "workspace_stats", "find_duplicates"],
  optionalTools: [],
  scopes: ["read"],
  instructions:
    "Rank the open queue. Put anything near a statutory deadline first, then anything blocked on someone else, "
    + "then everything else. Say what you could not determine rather than guessing at a date.",
  publisher: "magentic",
};

async function main(): Promise<void> {
  const root = resolve(process.argv[2] ?? "./registry-data");
  mkdirSync(root, { recursive: true });

  const context: TransitionContext = {
    store: fileStore(root),
    audit: fileAudit(join(root, "_audit")),
  };

  // Approved and servable: authored by one person, signed by another.
  await authorDraft(context, { workspaceId: WORKSPACE, definition: CASE_INTAKE, actor: "a.rivera" });
  await submit(context, { workspaceId: WORKSPACE, name: CASE_INTAKE.name, actor: "a.rivera" });
  await approve(context, {
    workspaceId: WORKSPACE,
    name: CASE_INTAKE.name,
    actor: "m.okafor",
    note: "Read-only, no write tools, scoped to this workspace.",
  });

  // In review: submitted, not yet signed. Present in the registry, absent
  // from the endpoint. This is the one to show a reviewer.
  await authorDraft(context, { workspaceId: WORKSPACE, definition: CASE_PACKAGE, actor: "a.rivera" });
  await submit(context, {
    workspaceId: WORKSPACE,
    name: CASE_PACKAGE.name,
    actor: "a.rivera",
    note: "Requests write scope; needs a careful read.",
  });

  // Draft: still being written, never submitted.
  await authorDraft(context, { workspaceId: WORKSPACE, definition: CASE_TRIAGE, actor: "e.driscoll" });

  const events = await context.audit.list(WORKSPACE);
  console.log(`Seeded workspace ${WORKSPACE} into ${root}`);
  for (const event of events) {
    console.log(`  ${event.at}  ${event.actor.padEnd(12)} ${event.action.padEnd(18)} ${event.agentName}`);
  }
  console.log("\nServe it with:");
  console.log(`  MAGENTIC_REGISTRY_DIR=${root} MAGENTIC_WORKSPACE=${WORKSPACE} \\`);
  console.log("  LNKZ_BASE_URL=http://127.0.0.1:3100 pnpm start:http");
  console.log("\nOnly records-intake will be served. The other two are withheld, and the reason is logged.");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
