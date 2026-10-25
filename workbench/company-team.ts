import { z } from "zod";
import type { Role } from "../registry/roles.js";
import { PipelineError, type PipelineRun } from "./pipeline.js";

const memberSchema = z.object({
  id: z.string().min(1), role: z.string().min(1),
  organization: z.object({ id: z.string().regex(/^org_[A-Za-z0-9]+$/) }),
  public_user_data: z.object({ user_id: z.string().regex(/^user_[A-Za-z0-9]+$/) }),
});
const pageSchema = z.object({
  data: z.array(memberSchema).max(500), total_count: z.number().int().min(0).max(2500),
});
export interface CompanyTeamMember { actor: string; roles: Role[] }
export type CompanyRoster = (organizationId: string) => Promise<{ actor: string; role: string }[]>;

export function clerkCompanyRoster(secret: string, request: typeof fetch = fetch): CompanyRoster {
  if (!/^sk_(test|live)_[A-Za-z0-9+/=_-]+$/.test(secret)) throw new Error("Configure a Clerk backend key for company membership.");
  return async organizationId => {
    if (!/^org_[A-Za-z0-9]+$/.test(organizationId)) throw new PipelineError(400, "Invalid company identifier.");
    try {
      const members: z.infer<typeof memberSchema>[] = [];
      const signal = AbortSignal.timeout(10_000);
      let total: number | undefined;
      for (let page = 0; page < 5; page++) {
        const response = await request(`https://api.clerk.com/v1/organizations/${organizationId}/memberships?limit=500&offset=${members.length}`, {
          headers: { Authorization: `Bearer ${secret}`, Accept: "application/json" }, signal, redirect: "error",
        });
        if (!response.ok) throw new Error();
        const parsed = pageSchema.parse(await response.json());
        if (total !== undefined && total !== parsed.total_count) throw new Error();
        total = parsed.total_count;
        members.push(...parsed.data);
        if (members.some(member => member.organization.id !== organizationId)
          || new Set(members.map(member => member.id)).size !== members.length
          || new Set(members.map(member => member.public_user_data.user_id)).size !== members.length
          || members.length > total) throw new Error();
        if (members.length === total) return members.map(member => ({ actor: member.public_user_data.user_id, role: member.role }));
        if (!parsed.data.length) throw new Error();
      }
      throw new Error();
    } catch {
      // A partial directory can overstate reviewer coverage. Never return it as a successful check.
      throw new PipelineError(503, "Company team could not be verified. Retry shortly.");
    }
  };
}

export interface CompanyTeamReport {
  workspaceId: string; checkedAt: string; members: CompanyTeamMember[];
  pipelineAvailable: boolean;
  handoffs: { runId: string; title: string; stage: string; required: number; recorded: number; available: number; shortfall: number }[];
}

export function companyTeamReport(workspaceId: string, members: CompanyTeamMember[], runs?: PipelineRun[]): CompanyTeamReport {
  const reviewers = new Set(members.filter(member => member.roles.includes("approver") || member.roles.includes("admin")).map(member => member.actor));
  const handoffs = (runs ?? []).filter(run => run.workspaceId === workspaceId && run.status === "running"
    && run.stages[run.current]?.status === "awaiting_review").map(run => {
    const stage = run.stages[run.current]!;
    const recorded = new Set(stage.approvals).size;
    const available = [...reviewers].filter(actor => actor !== run.owner && actor !== stage.outputBy && !stage.approvals.includes(actor)).length;
    return { runId: run.id, title: run.title, stage: run.config.stages[run.current]!.name,
      required: run.requiredApprovals, recorded, available, shortfall: Math.max(0, run.requiredApprovals - recorded - available) };
  });
  // This is a staffing snapshot. The workflow engine still checks every signature when it is submitted.
  return { workspaceId, checkedAt: new Date().toISOString(), members, pipelineAvailable: runs !== undefined, handoffs };
}

