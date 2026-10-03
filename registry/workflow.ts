import { z } from "zod";

export const WORKFLOW_ROLES = ["author", "approver", "admin"] as const;
const roleSchema = z.enum(WORKFLOW_ROLES);

// State names keep their meaning in stored records. A workflow changes the
// routes between them, not which state is safe to serve.
export const WORKFLOW_STATES = ["draft", "review", "approved", "retired"] as const;
const stateSchema = z.enum(WORKFLOW_STATES);

export const workflowSchema = z.object({
  states: z.array(stateSchema).min(1),
  transitions: z.object({
    draft: z.array(stateSchema).optional(),
    review: z.array(stateSchema).optional(),
    approved: z.array(stateSchema).optional(),
    retired: z.array(stateSchema).optional(),
  }).strict(),
  // Each action has one destination, so its role applies wherever the
  // workflow allows that move. Further approvals use the same signing role.
  roles: z.object({
    author: roleSchema,
    submit: roleSchema,
    approve: roleSchema,
    "request-changes": roleSchema,
    retire: roleSchema,
  }).strict(),
  // Records hold at most ten signatures. A larger threshold could never
  // be met by a record that survives a trip through the file store.
  requiredApprovals: z.number().int().min(1).max(10),
}).strict().superRefine((workflow, context) => {
  const states = new Set(workflow.states);
  if (states.size !== workflow.states.length) {
    context.addIssue({ code: "custom", path: ["states"], message: "State names must be distinct." });
  }
  // Authoring starts at draft and serving requires approved. Removing
  // either would leave the workflow inconsistent with stored records.
  for (const state of ["draft", "approved"] as const) {
    if (!states.has(state)) {
      context.addIssue({ code: "custom", path: ["states"], message: `Must declare ${state}.` });
    }
  }
  for (const from of WORKFLOW_STATES) {
    const targets = workflow.transitions[from];
    if (!targets) continue;
    if (!states.has(from)) {
      context.addIssue({ code: "custom", path: ["transitions", from], message: `State ${from} is not declared in states.` });
    }
    for (const [index, to] of targets.entries()) {
      if (!states.has(to)) {
        context.addIssue({ code: "custom", path: ["transitions", from, index], message: `State ${to} is not declared in states.` });
      }
    }
    if (new Set(targets).size !== targets.length) {
      context.addIssue({ code: "custom", path: ["transitions", from], message: "Destinations must be distinct." });
    }
  }
});

export type Workflow = z.infer<typeof workflowSchema>;

export const DEFAULT_WORKFLOW: Workflow = {
  states: [...WORKFLOW_STATES],
  transitions: {
    draft: ["review"],
    review: ["draft", "approved"],
    approved: ["retired"],
    retired: [],
  },
  roles: {
    author: "author",
    submit: "author",
    approve: "approver",
    "request-changes": "approver",
    retire: "approver",
  },
  requiredApprovals: 1,
};

export function loadWorkflow(raw: unknown): Workflow {
  const parsed = workflowSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Workflow is invalid. ${detail}`);
  }
  return parsed.data;
}
