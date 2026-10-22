import { z } from "zod";

const id = z.string().regex(/^[a-z][a-z0-9-]{1,39}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
// A numbered version cannot move to different code after the payload is reviewed.
export const lambdaArn = z.string().max(256).regex(/^arn:(aws|aws-us-gov|aws-cn):lambda:([a-z]{2}(?:-gov)?-[a-z]+-\d):\d{12}:function:[A-Za-z0-9_-]{1,64}:[1-9]\d*$/)
  .refine(value => {
    const [, partition, , region] = value.split(":");
    return partition === "aws-cn" ? region!.startsWith("cn-")
      : partition === "aws-us-gov" ? region!.startsWith("us-gov-")
      : !region!.startsWith("cn-") && !region!.startsWith("us-gov-");
  }, "The region must belong to the ARN partition.");

export const automationUnitSchema = z.object({
  id, workspaceId: z.string().uuid(), name: z.string().trim().min(1).max(100),
  kind: z.literal("lambda"), functionArn: lambdaArn,
  profile: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/).optional(),
  stages: z.array(id).min(1).max(12),
  timeoutSeconds: z.number().int().min(1).max(60).default(30),
  enabled: z.boolean().default(false),
}).strict();
export const automationConfigSchema = z.object({
  units: z.array(automationUnitSchema).max(100),
}).strict().superRefine(({ units }, context) => {
  const seen = new Set<string>();
  units.forEach((unit, index) => {
    const key = `${unit.workspaceId}:${unit.id}`;
    if (seen.has(key)) context.addIssue({ code: "custom", path: ["units", index, "id"], message: "Duplicate unit in this workspace." });
    seen.add(key);
    if (new Set(unit.stages).size !== unit.stages.length) context.addIssue({ code: "custom", path: ["units", index, "stages"], message: "Stage IDs must be unique." });
  });
});
export type AutomationUnit = z.infer<typeof automationUnitSchema>;

const reference = { unitId: id, runId: z.string().uuid(), stageId: id };
export const automationCommandSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("preview"), ...reference }).strict(),
  z.object({ action: z.literal("invoke"), ...reference, expectedIntentHash: hash }).strict(),
]);
export const automationInspectionSchema = z.object({ runId: z.string().uuid().optional() }).strict();
export const automationOutcomeSchema = z.object({
  status: z.enum(["succeeded", "failed", "uncertain"]),
  responseHash: hash.optional(), responseBytes: z.number().int().min(0).max(6 * 1024 * 1024).optional(),
  executedVersion: z.string().regex(/^[1-9]\d*$/).max(20).optional(),
}).strict();
export const automationRecordSchema = z.object({
  id: z.string().uuid(), ...reference, workspaceId: z.string().uuid(),
  intentHash: hash, dedupeKey: hash, outputHash: hash,
  authorizedBy: z.string().min(1).max(200), startedAt: z.string().datetime(),
  status: z.enum(["running", "succeeded", "failed", "uncertain"]),
  finishedAt: z.string().datetime().optional(), elapsedMs: z.number().int().nonnegative().optional(),
  responseHash: hash.optional(), responseBytes: z.number().int().min(0).max(6 * 1024 * 1024).optional(),
  executedVersion: z.string().regex(/^[1-9]\d*$/).max(20).optional(),
}).strict();
export type AutomationRecord = z.infer<typeof automationRecordSchema>;
export type AutomationOutcome = z.infer<typeof automationOutcomeSchema>;
