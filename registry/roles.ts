import { z } from "zod";

/**
 * Who may do what, inside one workspace.
 *
 * Approvals mean nothing if anyone can sign, so this is the piece that turns
 * the gate from a process into a control. It is deliberately small: three
 * roles, one membership record per person per workspace, and no inheritance.
 * Role systems grow teeth slowly and complexity quickly, and the second is
 * easier to add later than to remove.
 *
 * Personal mode has no directory at all. A process with no membership
 * configured does not check roles, which is how one developer on a laptop
 * keeps working without inventing an approver for themselves.
 */

export const ROLES = ["author", "approver", "admin"] as const;
export type Role = typeof ROLES[number];

export const membershipSchema = z.object({
  workspaceId: z.string().trim().min(1).max(200),
  actor: z.string().trim().min(1).max(200),
  roles: z.array(z.enum(ROLES)).min(1),
}).strict();

export type Membership = z.infer<typeof membershipSchema>;

export interface MemberDirectory {
  /** The roles this person holds here. Empty when they are not a member. */
  rolesFor(workspaceId: string, actor: string): Promise<readonly Role[]>;
}

/** A directory held in memory. The shape a database-backed one will also have. */
export function memoryMembers(seed: readonly Membership[] = []): MemberDirectory {
  const byKey = new Map<string, readonly Role[]>();
  for (const entry of seed) byKey.set(`${entry.workspaceId}\u0000${entry.actor}`, entry.roles);
  return {
    async rolesFor(workspaceId, actor) {
      return byKey.get(`${workspaceId}\u0000${actor}`) ?? [];
    },
  };
}

/** What each role is allowed to do. Admin is author plus approver, nothing more. */
const ALLOWED: Readonly<Record<Role, readonly Action[]>> = {
  author: ["author", "submit"],
  approver: ["approve", "request-changes", "retire"],
  admin: ["author", "submit", "approve", "request-changes", "retire"],
};

export type Action = "author" | "submit" | "approve" | "request-changes" | "retire";

export class PermissionError extends Error {}

/**
 * Refuse unless the actor holds a role that allows this action.
 *
 * A directory that is absent skips the check entirely rather than denying,
 * because no directory means personal mode, not an empty workspace.
 */
export async function requirePermission(
  directory: MemberDirectory | undefined,
  workspaceId: string,
  actor: string,
  action: Action,
): Promise<void> {
  if (!directory) return;

  const roles = await directory.rolesFor(workspaceId, actor);
  if (!roles.length) {
    throw new PermissionError(`${actor} is not a member of workspace ${workspaceId}.`);
  }
  if (!roles.some((role) => ALLOWED[role].includes(action))) {
    throw new PermissionError(
      `${actor} holds ${roles.join(", ")} in ${workspaceId}, and none of those may ${action}.`,
    );
  }
}
