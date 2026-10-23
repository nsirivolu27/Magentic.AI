import type { WorkbenchSnapshot } from "./snapshot.js";
import type { Page } from "./studio-view.js";
import type { ChatModelOption } from "./chat.js";
import { canvasAgents, type CanvasDraft } from "./workflow-canvas.js";
import { escape, empty } from "./ui.js";

export function workflowCanvasPage(snapshot: WorkbenchSnapshot, draft: CanvasDraft | undefined, query: string, models: ChatModelOption[], libraryOpen = true): Page {
  const page = { title: "Workflow canvas", context: "Connect agents. Review the handoffs. Save for future runs." };
  if (!draft || !snapshot.pipelines) return { ...page, body: empty("Workflows are unavailable.") };
  const { config } = draft;
  const admin = snapshot.roles.includes("admin");
  const stale = draft.version !== snapshot.pipelines.version;
  const disabled = !admin ? "disabled" : "";
  const selected = config.stages.find(stage => stage.id === draft.selected) ?? config.stages[0]!;
  const savedStage = snapshot.pipelines.config.stages.find(stage => stage.id === selected.id);
  const agents = canvasAgents(config);
  const available = models.filter(model => model.available);
  const selectedModel = available.some(model => model.id === selected.model);
  const drop = (index: number) => `<div class="canvas-connection" data-canvas-drop="${index}"><span class="canvas-wire" aria-hidden="true"></span><button type="button" data-canvas-insert="${index}" ${disabled} aria-label="Insert agent at connection ${index + 1}">＋</button><span class="canvas-wire" aria-hidden="true"></span><small>${index ? "Output → next stage" : "Request + references"}</small></div>`;
  const stages = config.stages.map((stage, index) => `${drop(index)}<article class="canvas-node ${selected.id === stage.id ? "is-selected" : ""}" data-canvas-stage="${escape(stage.id)}" draggable="${admin}" aria-label="Stage ${index + 1}: ${escape(stage.name)}">
      <button class="canvas-node-select" data-canvas-select="${escape(stage.id)}" aria-pressed="${selected.id === stage.id}"><span class="canvas-step">${String(index + 1).padStart(2, "0")}</span><span><strong>${escape(stage.name)}</strong><small>${escape(stage.agent)}</small></span><span data-canvas-handle aria-hidden="true">⠿</span></button>
      <div class="canvas-node-meta"><span>${stage.assistantId ? "Approved assistant binding" : stage.bot && stage.bot.kind !== "manual" ? "Agent · supervised" : "Manual stage"}</span><span>${stage.approval ? "◎ Review gate" : "Direct handoff"}</span></div>
      <div class="canvas-node-tools"><code>${escape(stage.model)}</code><span><button class="quiet small" data-canvas-move="${escape(stage.id)}" data-position="${index - 1}" aria-label="Move ${escape(stage.name)} up" ${!admin || index === 0 ? "disabled" : ""}>↑</button><button class="quiet small" data-canvas-move="${escape(stage.id)}" data-position="${index + 2}" aria-label="Move ${escape(stage.name)} down" ${!admin || index === config.stages.length - 1 ? "disabled" : ""}>↓</button></span></div>
    </article>`).join("");
  return { ...page, actions: '<a class="secondary" href="#/agent-studio">Agent Studio</a><a class="secondary" href="#/workflows">Runs & settings</a>', body: `<div class="workflow-canvas">
    <div class="canvas-toolbar"><label>Workflow name<input id="canvas-name" maxlength="100" required value="${escape(config.name)}" ${disabled}></label><span id="canvas-dirty" role="status">${draft.dirty ? "Unsaved changes" : `Saved · version ${draft.version}`}</span><button class="secondary" data-canvas-discard ${!draft.dirty && !stale ? "disabled" : ""}>Reload saved</button><button class="primary" data-canvas-save ${!admin || !draft.dirty || stale ? "disabled" : ""}>Save workflow</button></div>
    ${stale ? '<p class="inline-error" role="alert">Workflow changed elsewhere. Reload saved to get the latest version; your draft has not been applied.</p>' : ""}
    <p class="canvas-note">${!admin ? "Read only. An admin saves workflow changes. " : ""}One connected sequence · ${config.stages.length}/12 stages · Saving updates this workspace’s workflow, never existing runs.</p>
    <div class="canvas-layout">
      <details class="canvas-library" aria-label="Agent library" ${libraryOpen ? "open" : ""}><summary>Agent library <span class="agent-count">(${agents.length})</span></summary><header><small>Drag to a ＋ connection, or use Add.</small><a href="#/marketplace">Browse marketplace</a></header><label class="canvas-search"><span class="visually-hidden">Find an agent</span><input type="search" id="canvas-search" placeholder="Find an agent…" value="${escape(query)}"></label><div class="canvas-agent-list">
        ${agents.map(({ agent, source }) => `<article class="canvas-agent" data-canvas-agent="${agent.id}" data-search="${escape((agent.name + " " + agent.purpose).toLowerCase())}" draggable="${admin}" ${!(agent.name + " " + agent.purpose).toLowerCase().includes(query.toLowerCase()) ? "hidden" : ""}><small>${source}</small><strong>${escape(agent.name)}</strong><p>${escape(agent.purpose)}</p><button class="secondary small" data-canvas-add="${agent.id}" ${!admin || config.stages.length >= 12 ? "disabled" : ""} aria-label="Add ${escape(agent.name)}">＋ Add</button></article>`).join("")}
      </div></details>
      <section class="canvas-surface" aria-label="Connected workflow"><header class="canvas-panel-heading"><h2>Workflow</h2><span>${config.stages.length} stages</span></header><div class="canvas-board"><div class="canvas-endpoint">Request received</div>${stages}${drop(config.stages.length)}<div class="canvas-endpoint">Workflow complete</div></div></section>
      <aside class="canvas-inspector" aria-label="Selected stage"><header class="canvas-panel-heading"><h2>Stage details</h2><span>${config.stages.indexOf(selected) + 1} of ${config.stages.length}</span></header><form id="canvas-stage-form" data-stage="${escape(selected.id)}"><fieldset ${!admin || selected.assistantId ? "disabled" : ""}>
        <label>Stage name<input name="name" value="${escape(selected.name)}" required maxlength="80"></label>
        <label>Model<select name="model">${!selectedModel ? `<option value="${escape(selected.model)}" selected>${escape(selected.model)} · check connection</option>` : ""}${available.map(model => `<option value="${escape(model.id)}" ${model.id === selected.model ? "selected" : ""}>${escape(model.label)}</option>`).join("")}</select></label>
        <label>Instructions<textarea name="instructions" rows="5" maxlength="4000" required>${escape(selected.instructions)}</textarea></label>
        <label>Context<textarea name="context" rows="2" maxlength="2000">${escape(selected.context)}</textarea></label>
      </fieldset><p class="canvas-gate">${selected.approval ? "◎ Human review required" : "Direct handoff"}</p><p class="text-3">${selected.assistantId ? "Approved assistant binding is retained. Use workflow settings to change it." : "Stage edits stay in this draft until you save the workflow."}</p></form>
      <details><summary>Access & limits</summary><p>${escape(selected.bot?.allowedTools?.join(", ") ?? "Existing stage policy")}</p><p>${selected.bot ? `${selected.bot.maxSteps} model calls · ${selected.bot.timeoutSeconds}s limit` : "Manual stage"}</p><p>Jira status: ${escape(selected.jiraStatus)}</p></details>
      <button class="secondary" data-canvas-remove="${escape(selected.id)}" ${!admin || savedStage?.approval || savedStage?.assistantId || config.stages.length === 1 ? "disabled" : ""}>Remove stage</button><p class="text-3">Saved review gates and approved assistant stages cannot be removed here.</p>
      <div class="canvas-execution"><strong>${snapshot.bots ? "Supervised execution" : "Design and save"}</strong><p>${snapshot.bots ? "Start a work item after saving. Run agents and review outputs from its timeline." : "Company repository agents need an isolated worker before they can execute. Saving does not start agents."}</p><a href="#/desk">Open work items →</a></div>
      </aside>
    </div></div>` };
}
