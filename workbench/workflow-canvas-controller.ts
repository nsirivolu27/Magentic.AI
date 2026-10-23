import type { WorkbenchSnapshot } from "./snapshot.js";
import type { PipelineSnapshot } from "./pipeline.js";
import type { ChatModelOption } from "./chat.js";
import { addCanvasAgent, canvasSaveCommand, createCanvasDraft, editCanvasStage, moveCanvasStage, removeCanvasStage, type CanvasDraft } from "./workflow-canvas.js";
import { workflowCanvasPage } from "./workflow-canvas-view.js";

interface CanvasHost {
  snapshot(): WorkbenchSnapshot;
  active(): boolean;
  busy(): boolean;
  render(): void;
  notify(message: string, error?: boolean): void;
  lock(value: boolean): void;
  save(command: unknown): Promise<unknown>;
  refresh(): Promise<void>;
}

export function createWorkflowCanvas(host: CanvasHost) {
  let draft: CanvasDraft | undefined;
  let query = "";
  let insertion: number | undefined;
  let dragging: { kind: "agent" | "stage"; id: string; scope: string } | undefined;
  let pointer: { id: number; x: number; y: number; moved: boolean } | undefined;
  let suppressClick = false;
  const scope = () => `${host.snapshot().workspaceId}:${host.snapshot().actor}`;
  function current() {
    const snapshot = host.snapshot();
    if (!snapshot.pipelines) return undefined;
    if (!draft || draft.workspace !== snapshot.workspaceId || draft.actor !== snapshot.actor
      || (!draft.dirty && draft.version !== snapshot.pipelines.version)) {
      draft = createCanvasDraft(snapshot.workspaceId, snapshot.actor, snapshot.pipelines);
      query = ""; insertion = undefined; dragging = undefined;
    }
    return draft;
  }
  function writable() {
    if (!host.active() || host.busy()) return false;
    if (!host.snapshot().roles.includes("admin")) { host.notify("An admin edits workflows.", true); return false; }
    if (host.snapshot().bots?.busy) { host.notify("Wait for the current agent to finish.", true); return false; }
    return Boolean(current());
  }
  function mark() {
    if (!draft) return;
    draft.dirty = true;
    const label = document.querySelector("#canvas-dirty");
    if (label) label.textContent = "Unsaved changes";
    const save = document.querySelector<HTMLButtonElement>("[data-canvas-save]");
    if (save) save.disabled = draft.version !== host.snapshot().pipelines?.version;
    const reload = document.querySelector<HTMLButtonElement>("[data-canvas-discard]");
    if (reload) reload.disabled = false;
  }
  function edit(operation: () => void) {
    if (!writable()) return;
    try { operation(); mark(); host.render(); }
    catch (error) { host.notify((error as Error).message, true); }
  }
  function add(id: string, position: number) {
    const stageId = `agent-${crypto.randomUUID().slice(0, 12)}`;
    draft!.config = addCanvasAgent(draft!.config, id, stageId, position);
    draft!.selected = stageId; insertion = undefined;
    host.notify("Agent connected in the draft. Review its model and access before saving.");
  }

  document.addEventListener("input", event => {
    const input = event.target as HTMLInputElement;
    if (!host.active()) return;
    if (input.id === "canvas-search") {
      query = input.value;
      document.querySelectorAll<HTMLElement>("[data-canvas-agent]").forEach(card => {
        card.hidden = !card.dataset.search?.includes(query.toLowerCase());
      });
      return;
    }
    if (input.id !== "canvas-name" && !input.closest("#canvas-stage-form")) return;
    if (!writable()) return;
    if (input.id === "canvas-name") draft!.config.name = input.value;
    else {
      const form = input.closest<HTMLFormElement>("#canvas-stage-form")!;
      const stage = draft!.config.stages.find(item => item.id === form.dataset.stage);
      if (!stage || stage.assistantId) return;
      // Keep partial typing in memory; the server validates the complete saved configuration.
      if (input.name === "name" || input.name === "instructions" || input.name === "context" || input.name === "model") stage[input.name] = input.value;
      else return;
    }
    mark();
  });
  document.addEventListener("submit", event => {
    if ((event.target as HTMLElement).id === "canvas-stage-form") event.preventDefault();
  });
  document.addEventListener("click", async event => {
    if (!host.active()) return;
    const button = (event.target as Element).closest<HTMLElement>("button");
    if (!button || !button.closest(".workflow-canvas") || button.hasAttribute("disabled")) return;
    const state = current();
    if (!state) return;
    if (button.dataset.canvasSelect) { state.selected = button.dataset.canvasSelect; host.render(); return; }
    if (button.hasAttribute("data-canvas-discard")) {
      if (host.busy()) return;
      draft = undefined; host.render(); host.notify("Loaded the last saved workflow."); return;
    }
    if (button.hasAttribute("data-canvas-insert")) {
      if (!writable()) return;
      insertion = Number(button.dataset.canvasInsert);
      host.notify(`Choose an agent with Add to connect it at position ${insertion + 1}.`);
      document.querySelector<HTMLInputElement>("#canvas-search")?.focus(); return;
    }
    if (button.dataset.canvasAdd) { edit(() => add(button.dataset.canvasAdd!, insertion ?? state.config.stages.length)); return; }
    if (button.dataset.canvasMove) {
      edit(() => { state.config = moveCanvasStage(state.config, button.dataset.canvasMove!, Number(button.dataset.position)); }); return;
    }
    if (button.dataset.canvasRemove) {
      edit(() => { state.config = removeCanvasStage(state.config, button.dataset.canvasRemove!, host.snapshot().pipelines!.config); state.selected = state.config.stages[0]!.id; }); return;
    }
    if (!button.hasAttribute("data-canvas-save") || !writable()) return;
    const requestScope = scope();
    host.lock(true);
    try {
      if (!state.config.name.trim() || state.config.name.trim().length > 100) throw new Error("Give this workflow a name of 1–100 characters.");
      for (const stage of state.config.stages) if (!stage.assistantId) editCanvasStage(state.config, stage.id, stage);
      const command = canvasSaveCommand(state, host.snapshot().workspaceId, host.snapshot().actor, host.snapshot().pipelines!);
      const result = await host.save(command) as PipelineSnapshot;
      if (requestScope !== scope()) return;
      draft = createCanvasDraft(state.workspace, state.actor, result);
      await host.refresh();
      if (requestScope === scope()) host.notify(`Workflow saved as version ${result.version}. Existing runs are unchanged. No agents were started.`);
    } catch (error) { if (requestScope === scope()) host.notify((error as Error).message, true); }
    finally { host.lock(false); }
  });

  function clearDrag() {
    dragging = undefined; pointer = undefined;
    document.querySelector(".workflow-canvas")?.classList.remove("is-dragging");
    document.querySelectorAll(".canvas-drop-active").forEach(element => element.classList.remove("canvas-drop-active"));
  }
  // Pointer events also work in embedded browsers that do not deliver HTML drag payloads.
  document.addEventListener("dragstart", event => {
    if ((event.target as Element).closest("[data-canvas-agent], [data-canvas-stage]")) event.preventDefault();
  });
  document.addEventListener("pointerdown", event => {
    if (!host.active() || event.button !== 0) return;
    const target = event.target as Element;
    const element = target.closest<HTMLElement>("[data-canvas-agent], [data-canvas-stage]");
    if (!element || (target.closest("button, input, textarea, select, a") && !target.closest("[data-canvas-handle]")) || !writable()) return;
    dragging = { kind: element.dataset.canvasAgent ? "agent" : "stage", id: element.dataset.canvasAgent ?? element.dataset.canvasStage!, scope: scope() };
    pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false };
    element.setPointerCapture(event.pointerId);
  });
  document.addEventListener("pointermove", event => {
    if (!host.active() || !dragging || dragging.scope !== scope() || !pointer || pointer.id !== event.pointerId) return;
    if (!pointer.moved && Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) < 6) return;
    pointer.moved = true;
    event.preventDefault();
    document.querySelector(".workflow-canvas")?.classList.add("is-dragging");
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest("[data-canvas-drop]");
    document.querySelectorAll(".canvas-drop-active").forEach(element => element.classList.remove("canvas-drop-active"));
    target?.classList.add("canvas-drop-active");
  });
  document.addEventListener("pointerup", event => {
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-canvas-drop]");
    if (!host.active() || !dragging || dragging.scope !== scope() || !pointer?.moved || !target) { clearDrag(); return; }
    event.preventDefault();
    const item = dragging;
    const position = Number(target.dataset.canvasDrop);
    suppressClick = true;
    setTimeout(() => { suppressClick = false; }, 0);
    clearDrag();
    // Only a drag begun in this canvas can edit it; external payloads have no authority.
    edit(() => {
      if (item.kind === "agent") add(item.id, position);
      else { draft!.config = moveCanvasStage(draft!.config, item.id, position); draft!.selected = item.id; }
    });
  });
  document.addEventListener("pointercancel", clearDrag);
  document.addEventListener("click", event => {
    if (suppressClick) { event.preventDefault(); event.stopImmediatePropagation(); }
  }, true);
  window.addEventListener("beforeunload", event => { if (draft?.dirty) { event.preventDefault(); event.returnValue = ""; } });
  return { page(models: ChatModelOption[]) { return workflowCanvasPage(host.snapshot(), current(), query, models); } };
}
