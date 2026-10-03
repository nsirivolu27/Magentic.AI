import { randomUUID } from "node:crypto";
import { z } from "zod";

export const editorTaskOutcomeSchema = z.object({
  id: z.string().uuid(), label: z.string().min(1).max(200),
  status: z.enum(["starting", "running", "exited", "unknown", "launch-error"]),
  startedAt: z.string().datetime(), finishedAt: z.string().datetime().nullable(),
  durationMs: z.number().nonnegative().nullable(), exitCode: z.number().int().nullable(),
}).strict();
export type EditorTaskOutcome = z.infer<typeof editorTaskOutcomeSchema>;
type Disposable = { dispose(): void };
type ProcessEnd = { execution: object; exitCode: number | undefined };
type TaskEnd = { execution: object };
interface TaskApi {
  onDidEndTaskProcess(listener: (event: ProcessEnd) => void): Disposable;
  onDidEndTask(listener: (event: TaskEnd) => void): Disposable;
  executeTask(task: unknown): PromiseLike<object>;
}

// Process outcomes describe a past run, not the current checkout or a release approval.
export class EditorTaskHistory {
  private entries: { workspace: string; result: EditorTaskOutcome }[] = [];
  private cleanup: (() => void) | undefined;
  busy = false;
  constructor(private api: TaskApi, private changed: () => void, private now: () => number = Date.now) {}

  snapshot(workspace: string): EditorTaskOutcome[] {
    return this.entries.filter(entry => entry.workspace === workspace).slice(0, 5).map(entry => ({ ...entry.result }));
  }
  dispose(): void { this.cleanup?.(); }

  async start(workspace: string, label: string, task: unknown): Promise<void> {
    if (this.busy) throw new Error("Wait for the running workspace task to finish.");
    this.busy = true;
    const start = this.now();
    const result: EditorTaskOutcome = { id: randomUUID(), label: label.slice(0, 200) || "Workspace task", status: "starting",
      startedAt: new Date(start).toISOString(), finishedAt: null, durationMs: null, exitCode: null };
    this.entries.unshift({ workspace, result }); this.entries = this.entries.slice(0, 20);
    let execution: object | undefined;
    let finished = false;
    const subscriptions: Disposable[] = [];
    const early = new Map<object, { code: number | undefined }>();
    const finish = (code: number | undefined, status: EditorTaskOutcome["status"] = Number.isInteger(code) ? "exited" : "unknown") => {
      if (finished) return;
      finished = true;
      result.status = status;
      result.exitCode = Number.isInteger(code) ? code! : null;
      result.finishedAt = new Date(this.now()).toISOString();
      result.durationMs = Math.max(0, this.now() - start);
      this.busy = false; this.cleanup = undefined;
      for (const subscription of subscriptions) subscription.dispose();
      early.clear(); this.changed();
    };
    const ended = (event: TaskEnd, code: number | undefined) => {
      if (execution) { if (event.execution === execution) finish(code); return; }
      // A fast process can exit before executeTask resolves. Correlate by execution identity, never its display name.
      if (early.size < 20 && !early.has(event.execution)) early.set(event.execution, { code });
    };
    this.cleanup = () => finish(undefined);
    try {
      subscriptions.push(this.api.onDidEndTaskProcess(event => ended(event, event.exitCode)));
      subscriptions.push(this.api.onDidEndTask(event => ended(event, undefined)));
      this.changed();
      execution = await this.api.executeTask(task);
      if (finished) return;
      const completed = early.get(execution);
      if (completed) finish(completed.code);
      else { early.clear(); result.status = "running"; this.changed(); }
    } catch (error) { finish(undefined, "launch-error"); throw error; }
  }
}
