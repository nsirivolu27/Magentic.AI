import { zenfluencePage, type ZenfluenceSummary } from "./zenfluence-view.js";
import type { ZenfluenceSource } from "./zenfluence.js";
import type { PipelineRun } from "./pipeline.js";

export function createZenfluenceView(context: {
  scope(): string; runs(): PipelineRun[]; render(): void; refresh(): Promise<void>; notify(message: string): void;
  api(path: string, input?: unknown): Promise<unknown>;
}) {
  let scope = "", summary: ZenfluenceSummary | undefined, source: ZenfluenceSource | undefined;
  let error = "", loading = false;
  let draft = { kind: "jira", id: "", runId: "" };
  async function load() {
    const expected = context.scope(); loading = true;
    try { const next = await context.api("/api/zenfluence") as ZenfluenceSummary; if (context.scope() === expected) { summary = next; error = ""; } }
    catch (cause) { if (context.scope() === expected) error = (cause as Error).message; }
    finally { if (context.scope() === expected) { loading = false; context.render(); } }
  }
  return {
    page() {
      if (scope !== context.scope()) { scope = context.scope(); summary = undefined; source = undefined; error = ""; draft = { kind: "jira", id: "", runId: "" }; void load(); }
      return zenfluencePage(summary, source, error, context.runs().filter(run => run.status !== "complete" && run.status !== "cancelled"), loading, draft);
    },
    edit(event: Event) {
      const field = event.target;
      if (!(field instanceof HTMLInputElement || field instanceof HTMLSelectElement)) return;
      if (field.form?.id === "zenfluence-read") {
        if (field.name === "kind") draft.kind = field.value;
        if (field.name === "sourceId") draft.id = field.value;
      }
      if (field.form?.id === "zenfluence-attach" && field.name === "runId") draft.runId = field.value;
    },
    reload() { if (!loading) void load(); },
    async submit(event: Event) {
      const form = event.target;
      if (!(form instanceof HTMLFormElement) || !["zenfluence-read", "zenfluence-attach"].includes(form.id)) return;
      event.preventDefault(); if (loading) return;
      const expected = context.scope(), data = new FormData(form), attach = form.id === "zenfluence-attach";
      const selected = source;
      const run = context.runs().find(item => item.id === data.get("runId"));
      if (attach && (!selected || !run)) return;
      const input = attach ? { action: "attach", source: { kind: selected!.kind, id: selected!.id },
        runId: run!.id, expectedRevision: run!.revision, expectedSourceHash: selected!.contentHash }
        : { action: "read", source: { kind: data.get("kind"), id: String(data.get("sourceId") ?? "").trim() } };
      loading = true; error = ""; if (!attach) source = undefined; context.render();
      try {
        const result = await context.api("/api/zenfluence", input);
        if (context.scope() !== expected) return;
        if (attach) { context.notify("Source snapshot attached."); await context.refresh(); }
        else source = result as ZenfluenceSource;
      } catch (cause) { if (context.scope() === expected) error = (cause as Error).message; }
      finally { if (context.scope() === expected) { loading = false; context.render(); } }
    },
  };
}
