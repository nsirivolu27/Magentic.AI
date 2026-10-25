import { createHash } from "node:crypto";
import { z } from "zod";
import type { PipelineRun } from "./pipeline.js";

/**
 * The audit package: one run's chain of custody as a document an auditor can
 * keep and check without Magentic. It carries every stage's output with its
 * hash, who produced it, who signed it, the events in order, and the
 * reference material with its own hashes. A package hash over the whole body
 * lets a reader prove the file was not edited after it was produced.
 *
 * Verification recomputes every hash from the text in the file. It proves
 * the file is internally consistent and unedited; it does not prove that the
 * people named were who they said they were. That is what the workspace's
 * sign in and membership records are for.
 */

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const hashPattern = /^[0-9a-f]{64}$/;

export const auditStageSchema = z.object({
  index: z.number().int().min(0),
  name: z.string(),
  gate: z.boolean(),
  status: z.enum(["pending", "active", "awaiting_review", "complete"]),
  output: z.string(),
  outputHash: z.string(),
  outputBy: z.string(),
  approvals: z.array(z.string()),
  completedAt: z.string().optional(),
  draft: z.object({ text: z.string(), hash: z.string(), by: z.string(), at: z.string() }).strict().optional(),
}).strict();

export const auditPackageSchema = z.object({
  kind: z.literal("magentic-audit-package"),
  version: z.literal(1),
  generatedAt: z.string().datetime(),
  generatedBy: z.string(),
  workspaceId: z.string(),
  /** The deployment's handling marking at export time, when one was set. */
  handling: z.string().optional(),
  run: z.object({
    id: z.string(), title: z.string(), brief: z.string(), owner: z.string(), status: z.string(),
    createdAt: z.string(), updatedAt: z.string(), revision: z.number().int(), requiredApprovals: z.number().int(), issueKey: z.string().nullable(),
  }).strict(),
  stages: z.array(auditStageSchema),
  events: z.array(z.object({ at: z.string(), actor: z.string(), stage: z.string(), action: z.string(), detail: z.string() }).strict()),
  materials: z.array(z.object({ title: z.string(), url: z.string().optional(), content: z.string(), contentHash: z.string() }).strict()),
  packageHash: z.string(),
}).strict();
export type AuditPackage = z.infer<typeof auditPackageSchema>;

/** JSON with keys in a fixed order, so the same content always hashes the same. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function bodyHash(pkg: Omit<AuditPackage, "packageHash">): string {
  return sha256(canonical(pkg));
}

export function buildAuditPackage(run: PipelineRun, options: { workspaceId: string; actor: string; now?: Date; handling?: string }): AuditPackage {
  const body: Omit<AuditPackage, "packageHash"> = {
    kind: "magentic-audit-package", version: 1,
    generatedAt: (options.now ?? new Date()).toISOString(), generatedBy: options.actor, workspaceId: options.workspaceId,
    ...(options.handling ? { handling: options.handling } : {}),
    run: { id: run.id, title: run.title, brief: run.brief, owner: run.owner, status: run.status, createdAt: run.createdAt, updatedAt: run.updatedAt,
      revision: run.revision, requiredApprovals: run.requiredApprovals, issueKey: run.issueKey },
    stages: run.stages.map((stage, index) => ({
      index, name: run.config.stages[index]?.name ?? `Stage ${index + 1}`, gate: Boolean(run.config.stages[index]?.approval),
      status: stage.status, output: stage.output, outputHash: stage.outputHash, outputBy: stage.outputBy, approvals: [...stage.approvals],
      ...(stage.completedAt ? { completedAt: stage.completedAt } : {}),
      ...(stage.draft ? { draft: { text: stage.draft.text, hash: stage.draft.hash, by: stage.draft.by, at: stage.draft.at } } : {}),
    })),
    events: run.events.map(event => ({ at: event.at, actor: event.actor, stage: event.stage, action: event.action, detail: event.detail })),
    materials: (run.materials ?? []).map(material => ({ title: material.title, ...(material.url ? { url: material.url } : {}), content: material.content, contentHash: sha256(material.content) })),
  };
  return { ...body, packageHash: bodyHash(body) };
}

export interface Verification { ok: boolean; problems: string[]; summary: string }

/** Every hash is recomputed from the text in the file. The first problem is not the last: all of them are listed. */
export function verifyAuditPackage(raw: unknown): Verification {
  const parsed = auditPackageSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, problems: [`Not an audit package: ${issue?.path.join(".") || "root"} ${issue?.message ?? ""}`.trim()], summary: "Unreadable" };
  }
  const pkg = parsed.data;
  const problems: string[] = [];
  const { packageHash, ...body } = pkg;
  if (!hashPattern.test(packageHash) || bodyHash(body) !== packageHash) problems.push("The package hash does not match its contents. The file was edited after it was produced.");
  for (const stage of pkg.stages) {
    const where = `Stage ${stage.index + 1} (${stage.name})`;
    if (stage.output && sha256(stage.output) !== stage.outputHash) problems.push(`${where}: the output text does not match its recorded hash.`);
    if (stage.draft && sha256(stage.draft.text) !== stage.draft.hash) problems.push(`${where}: the draft text does not match its recorded hash.`);
    for (const signer of stage.approvals) {
      if (signer === pkg.run.owner) problems.push(`${where}: the run owner ${signer} appears as a signer.`);
      if (signer === stage.outputBy) problems.push(`${where}: the output author ${signer} appears as a signer.`);
    }
    if (stage.status === "complete" && stage.gate && stage.approvals.length < pkg.run.requiredApprovals) problems.push(`${where}: completed with ${stage.approvals.length} of ${pkg.run.requiredApprovals} required approvals.`);
    if (stage.approvals.length && !pkg.events.some(event => event.action === "approved" && event.detail.includes(stage.outputHash))) problems.push(`${where}: no approval event names the output hash.`);
  }
  pkg.materials.forEach((material, index) => {
    if (sha256(material.content) !== material.contentHash) problems.push(`Reference ${index + 1} (${material.title}): the content does not match its recorded hash.`);
  });
  const signed = pkg.stages.filter(stage => stage.approvals.length).length;
  return { ok: problems.length === 0, problems, summary: `${pkg.run.title}: ${pkg.stages.length} stages, ${signed} signed, ${pkg.events.length} events, ${pkg.materials.length} references, run ${pkg.run.status}.` };
}

const line = (text: string) => text.replace(/\r?\n/g, " ").trim();

/** A readable record for people who will never open JSON. Same facts, same hashes. */
export function renderAuditPackage(pkg: AuditPackage): string {
  const out: string[] = [];
  // A handling marking opens and closes the document, the way marked paper does.
  if (pkg.handling) out.push(pkg.handling, "");
  out.push(`# Audit package: ${pkg.run.title}`, "");
  out.push(`Workspace ${pkg.workspaceId} · run ${pkg.run.id} · revision ${pkg.run.revision} · status ${pkg.run.status}`);
  out.push(`Generated ${pkg.generatedAt} by ${pkg.generatedBy}. Package hash ${pkg.packageHash}.`, "");
  out.push(`Owner: ${pkg.run.owner}. Required approvals per gated stage: ${pkg.run.requiredApprovals}.${pkg.run.issueKey ? ` Ticket: ${pkg.run.issueKey}.` : ""}`, "");
  out.push("## Brief", "", pkg.run.brief, "");
  out.push("## Stages", "");
  for (const stage of pkg.stages) {
    out.push(`### ${stage.index + 1}. ${stage.name}`, "");
    out.push(`Status: ${stage.status}${stage.gate ? " (review gate)" : ""}${stage.completedAt ? `, completed ${stage.completedAt}` : ""}.`);
    if (stage.draft) out.push(`Draft by ${stage.draft.by} at ${stage.draft.at}, hash ${stage.draft.hash}.`);
    if (stage.output) {
      out.push(`Output by ${stage.outputBy}, hash ${stage.outputHash}.`);
      out.push(`Signed by: ${stage.approvals.length ? stage.approvals.join(", ") : "nobody yet"}.`, "");
      out.push("```", stage.output, "```");
    } else out.push("No output yet.");
    out.push("");
  }
  out.push("## Reference material", "");
  if (!pkg.materials.length) out.push("None attached.", "");
  pkg.materials.forEach((material, index) => {
    out.push(`${index + 1}. ${material.title}${material.url ? ` (${material.url})` : ""}, hash ${material.contentHash}, ${material.content.length} characters.`);
  });
  if (pkg.materials.length) out.push("");
  out.push("## Events", "");
  for (const event of pkg.events) out.push(`- ${event.at} · ${event.actor} · ${event.stage} · ${event.action}: ${line(event.detail)}`);
  out.push("", "## How to verify", "", "Keep the JSON form of this package beside this file. `corepack pnpm audit:verify <file.json>` recomputes every hash above from the text in the file and reports any difference. A hash that matches proves the text was not edited after the package was produced.", "");
  if (pkg.handling) out.push(pkg.handling, "");
  return out.join("\n");
}
