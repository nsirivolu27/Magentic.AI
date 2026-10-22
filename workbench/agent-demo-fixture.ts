import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { memoryAudit } from "../registry/audit.js";
import { memoryMembers } from "../registry/roles.js";
import { memoryStore } from "../registry/store.js";
import { DEFAULT_WORKFLOW, loadWorkflow } from "../registry/workflow.js";
import { applyConfigurable, agentConfigurableSchema, saveConfigurable } from "./agent-configurables.js";
import { createBotRuntime } from "./bot-runtime.js";
import { createAgentTests } from "./agent-tests.js";
import { command } from "./bot-project.js";
import type { ChatConfiguration } from "./chat.js";
import { DEFAULT_PIPELINE, memoryPipelines, type PipelineEngine, type PipelineConfig } from "./pipeline.js";

export const DEMO_WORKSPACE = "agent-studio-demo";
export const DEMO_MEMBERS = [
  { workspaceId: DEMO_WORKSPACE, actor: "demo.operator", roles: ["author", "admin"] as const },
  { workspaceId: DEMO_WORKSPACE, actor: "demo.reviewer-one", roles: ["approver"] as const },
  { workspaceId: DEMO_WORKSPACE, actor: "demo.reviewer-two", roles: ["approver"] as const },
];
export const DEMO_TASK = {
  title: "Explain the access request process",
  brief: "Read SOP.md. Explain who approves a routine access request, its response target, and how to handle missing approval. Cite SOP.md. Do not grant access or claim an external action happened.",
};
export const DEMO_SOP = "# Access request SOP (synthetic)\n\nA routine request needs the team owner's approval.\nThe service desk responds within two business days after approval.\nMissing approval goes back to the requester; access is not granted.\n";

// This model is deliberately scripted. It exercises real MCP reads without
// presenting a canned answer or made-up token counts as a live model result.
export function scriptedDemoChat(): ChatConfiguration {
  const model = "demo-scripted";
  return { provider: "Scripted demo", model,
    modelOptions: async () => [{ id: model, label: "Scripted demo · no inference", provider: "Demo", available: true, local: true, detail: "Synthetic responses. No API calls or token charges." }],
    loadModel: async selected => {
      if (selected && selected !== model) throw new Error("Choose the scripted demo model.");
      return { async invoke(prompt) {
        const observation = prompt.split("OBSERVATIONS: ")[1]?.split("\n\n")[0];
        const reads = JSON.parse(observation ?? "[]") as { result?: { path?: string; content?: string } }[];
        const source = reads.find(item => item.result?.path === "SOP.md")?.result?.content;
        if (!source) return { content: JSON.stringify({ type: "tool", name: "read_project_file", arguments: { path: "SOP.md" } }) };
        return { content: JSON.stringify({ type: "result", changes: [], summary: `Scripted demo result. Source: SOP.md\n\n${source}\nNo access was granted. A person must review this answer.` }) };
      } };
    },
  };
}

export async function createAgentDemo(directory: string, chat = scriptedDemoChat()) {
  const root = join(directory, "sample-repository");
  mkdirSync(root);
  writeFileSync(join(root, "SOP.md"), DEMO_SOP);
  writeFileSync(join(root, "check.mjs"), 'import assert from "node:assert/strict";\nimport { readFileSync } from "node:fs";\nconst sop = readFileSync("SOP.md", "utf8");\nassert.ok(sop.includes("approval"));\nassert.ok(sop.includes("two business days"));\nconsole.log("Source fixture checks passed; model accuracy requires human review.");\n');
  for (const args of [["init", "-q"], ["config", "core.autocrlf", "false"], ["add", "SOP.md", "check.mjs"],
    ["-c", "user.name=Demo", "-c", "user.email=demo@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "-qm", "Add synthetic documentation fixture"]]) {
    const result = await command("git", args, root);
    if (!result.passed) throw new Error("Could not prepare the disposable demo repository.");
  }
  const context = { store: memoryStore(), audit: memoryAudit(),
    members: memoryMembers(DEMO_MEMBERS.map(member => ({ ...member, roles: [...member.roles] }))),
    workflow: loadWorkflow({ ...DEFAULT_WORKFLOW, requiredApprovals: 2 }),
  };
  const engine = memoryPipelines();
  const agents = [
    { name: "Documentation guide", purpose: "Answer from the internal SOP.", kind: "planner" },
    { name: "Evidence reviewer", purpose: "Check the answer against the SOP.", kind: "reviewer" },
  ].map(role => agentConfigurableSchema.parse({ id: randomUUID(), name: role.name, purpose: role.purpose,
    model: chat.model, instructions: "Read SOP.md using read_project_file. Answer the work item from that source, cite it, and identify missing evidence. Return no changes. Do not claim external actions or human approvals.",
    bot: { kind: role.kind, requireSourceRead: true, maxSteps: 4, timeoutSeconds: 300, allowedTools: ["read_project_file"], maxToolCalls: 2 },
  }));
  let config: PipelineConfig = { ...structuredClone(DEFAULT_PIPELINE), name: "Internal documentation demo", description: "Read → Check → Independent approval. Synthetic documents only.",
    jira: { enabled: false, project: "DEMO", issueType: "Task" },
    stages: agents.map((agent, index) => ({ ...DEFAULT_PIPELINE.stages[0]!, id: index ? "review" : "answer", name: index ? "Check the answer" : "Read and answer", approval: Boolean(index), assistantId: undefined })),
  };
  // The normal save and assignment functions keep this demo on the same path
  // as agents created in the UI. Review gates are never removed for convenience.
  for (const [index, agent] of agents.entries()) {
    config = applyConfigurable(saveConfigurable(config, agent), agent.id, config.stages[index]!.id);
  }
  engine.execute(DEMO_WORKSPACE, DEMO_MEMBERS[0]!.actor, DEMO_MEMBERS[0]!.roles,
    { action: "configure", expectedVersion: 1, config }, 2);
  const bots = createBotRuntime(join(directory, "attempts"), engine, chat);
  await bots.execute(DEMO_WORKSPACE, DEMO_MEMBERS[0]!.actor, DEMO_MEMBERS[0]!.roles,
    { action: "attach", project: { root, checks: [{ executable: "node", args: ["check.mjs"] }] } }, 2);
  const pipelines: PipelineEngine = { snapshot: engine.snapshot, draft: engine.draft,
    execute(workspace, actor, roles, raw, approvals) {
      if (bots.busy(workspace)) throw new Error("Wait for the running agent before changing the workflow.");
      return engine.execute(workspace, actor, roles, raw, approvals);
    },
  };
  const agentTests = createAgentTests({ pipelines: engine, bots, chat });
  // One saved test per agent, so the demo opens on a runnable example rather than an empty form.
  await agentTests.execute(DEMO_WORKSPACE, DEMO_MEMBERS[0]!.actor, DEMO_MEMBERS[0]!.roles, { action: "save_case", agentId: agents[0]!.id, title: "Routine access request",
    prompt: DEMO_TASK.brief, expected: "Names the team owner as approver, the two business day response target, and that missing approval goes back to the requester without access. Cites SOP.md.", source: "SOP.md" });
  await agentTests.execute(DEMO_WORKSPACE, DEMO_MEMBERS[0]!.actor, DEMO_MEMBERS[0]!.roles, { action: "save_case", agentId: agents[1]!.id, title: "Check an answer against the SOP",
    prompt: "An answer claims access is granted automatically after two days. Check that claim against SOP.md and report what the SOP actually says.", expected: "Reports that the claim is wrong: approval is required and missing approval returns the request. Cites SOP.md.", source: "SOP.md" });
  return { context, pipelines, bots, chat, agents, root, agentTests };
}
