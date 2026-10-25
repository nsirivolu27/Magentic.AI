import type { CompanyTeamReport } from "./company-team.js";
import type { CompanyTeamState } from "./company-team-view.js";

export function createCompanyTeamView(options: { request: (workspace: string) => Promise<CompanyTeamReport>; render: () => void }) {
  let workspace: string | undefined;
  let actor: string | undefined;
  let revision = 0;
  let state: CompanyTeamState = { loading: false };
  return {
    context(nextWorkspace?: string, nextActor?: string) {
      if (workspace === nextWorkspace && actor === nextActor) return;
      workspace = nextWorkspace; actor = nextActor; revision++;
      state = { loading: false };
    },
    get state(): CompanyTeamState { return state; },
    async load() {
      if (!workspace || !actor || state.loading) return;
      const selected = workspace, expected = revision;
      // Clear old counts before checking again, including when a refresh fails.
      state = { loading: true }; options.render();
      try {
        const report = await options.request(selected);
        if (expected !== revision) return;
        if (report.workspaceId !== selected) throw new Error("Team response did not match this workspace.");
        state = { loading: false, report };
      } catch {
        if (expected !== revision) return;
        state = { loading: false, error: "Team coverage could not be verified. Refresh or ask an administrator to check company access." };
      }
      options.render();
    },
  };
}

