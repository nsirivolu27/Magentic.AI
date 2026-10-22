import type { IncomingMessage } from "node:http";
import { z } from "zod";
import { accountActor, type AccountsConfig } from "./accounts.js";
import type { MemberDirectory, Role } from "../registry/roles.js";
import { PipelineError } from "./pipeline.js";
import type { CompanyWorkspaceDirectory, WorkspaceListing } from "./workspace-directory.js";

const membershipSchema = z.object({
  id: z.string().min(1), role: z.string().min(1),
  organization: z.object({ id: z.string().regex(/^org_[A-Za-z0-9]+$/), name: z.string().trim().min(1).max(256) }),
  public_user_data: z.object({ user_id: z.string() }).nullable().optional(),
});
const pageSchema = z.object({ data: z.array(membershipSchema).max(500), total_count: z.number().int().min(0).max(2500) });
export type CompanyMembership = z.infer<typeof membershipSchema>;
export type CompanyMemberships = (actor: string) => Promise<CompanyMembership[]>;

export function clerkMemberships(secret: string, request: typeof fetch = fetch): CompanyMemberships {
  if (!/^sk_(test|live)_[A-Za-z0-9+/=_-]+$/.test(secret)) throw new Error("MAGENTIC_CLERK_SECRET_KEY must be a Clerk secret key.");
  return async actor => {
    if (!/^user_[A-Za-z0-9]+$/.test(actor)) throw new PipelineError(401, "Sign in again.");
    try {
      const result: CompanyMembership[] = [];
      const signal = AbortSignal.timeout(10_000);
      let total: number | undefined;
      for (let page = 0; page < 5; page++) {
        const response = await request(`https://api.clerk.com/v1/users/${actor}/organization_memberships?limit=500&offset=${result.length}`, {
          headers: { Authorization: `Bearer ${secret}`, Accept: "application/json" }, signal, redirect: "error",
        });
        if (!response.ok) throw new Error();
        const parsed = pageSchema.parse(await response.json());
        if (total !== undefined && total !== parsed.total_count) throw new Error();
        total = parsed.total_count;
        result.push(...parsed.data);
        if (result.some(item => item.public_user_data && item.public_user_data.user_id !== actor)) throw new Error();
        if (new Set(result.map(item => item.organization.id)).size !== result.length || result.length > total) throw new Error();
        if (result.length === total) return result;
        if (!parsed.data.length) throw new Error();
      }
      throw new Error();
    } catch {
      // Provider responses can contain personal data. Do not expose them as errors.
      throw new PipelineError(503, "Company membership could not be verified. Retry shortly.");
    }
  };
}

export function createCompanyAccess(config: AccountsConfig, directory: CompanyWorkspaceDirectory, memberships: CompanyMemberships) {
  if (!config.companies) throw new Error("Company access requires companies settings.");
  const rolesForMembership = (membership: CompanyMembership): readonly Role[] => config.companies!.roles[membership.role] ?? [];
  async function list(actor: string) {
    return (await memberships(actor)).filter(item => rolesForMembership(item).length).map(item => {
      const entry = directory.company(item.organization.id);
      return { organizationId: item.organization.id, name: item.organization.name, roles: rolesForMembership(item),
        workspaceId: entry?.id ?? null, canCreate: rolesForMembership(item).includes("admin") };
    });
  }
  const members: MemberDirectory = {
    async rolesFor(workspaceId, actor) {
      const entry = directory.list().workspaces.find(item => item.id === workspaceId);
      if (!entry?.organizationId) return [];
      const membership = (await memberships(actor)).find(item => item.organization.id === entry.organizationId);
      return membership ? rolesForMembership(membership) : [];
    },
  };
  return {
    members,
    actor(request: IncomingMessage) { return accountActor(request, config); },
    list,
    async listing(actor: string): Promise<WorkspaceListing> {
      const companies = await list(actor);
      const ids = new Set(companies.flatMap(item => item.workspaceId ? [item.workspaceId] : []));
      const workspaces = directory.list().workspaces.filter(item => ids.has(item.id));
      return { workspaces, lastWorkspaceId: workspaces[0]?.id ?? "", storage: "file", directory: "Company-managed storage" };
    },
    async open(actor: string, raw: unknown) {
      const input = z.object({ organizationId: z.string().regex(/^org_[A-Za-z0-9]+$/) }).strict().parse(raw);
      const membership = (await memberships(actor)).find(item => item.organization.id === input.organizationId);
      const roles = membership ? rolesForMembership(membership) : [];
      if (!membership || !roles.length) throw new PipelineError(403, "You are not a member of this company.");
      const existing = directory.company(input.organizationId);
      if (existing) return { workspaceId: existing.id };
      if (!roles.includes("admin")) throw new PipelineError(403, "A company admin must create this workspace first.");
      return directory.provisionCompany(input.organizationId, membership.organization.name.slice(0, 80));
    },
    async authenticate(request: IncomingMessage) {
      const actor = accountActor(request, config);
      if (!actor) return undefined;
      const selected = request.headers["x-magentic-workspace"];
      const workspaceId = selected ?? (await list(actor)).find(item => item.workspaceId)?.workspaceId;
      if (typeof workspaceId !== "string" || !directory.has(workspaceId)) return undefined;
      // The server checks members.rolesFor on every request, including MCP calls.
      return { actor, workspaceId };
    },
  };
}
export type CompanyAccess = ReturnType<typeof createCompanyAccess>;
