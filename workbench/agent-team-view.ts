import type { ChatModelOption } from "./chat.js";
import { AGENT_STARTERS } from "./agent-configurables.js";
import { BOT_REPOSITORY_TOOLS, effectiveToolPolicy } from "./bot-schema.js";
import type { WorkbenchSnapshot } from "./snapshot.js";
import type { Page, StudioUi } from "./studio-view.js";
import { empty, escape, more, panel, status } from "./ui.js";

const toolNames = { list_project_files: "List files", read_project_file: "Read files", project_diff: "Read changes" };

export function agentTeamPage(snapshot: WorkbenchSnapshot, id: string | undefined, preset: string | null, models: ChatModelOption[], ui: StudioUi): Page {
  const pipeline = snapshot.pipelines;
  if (!pipeline) return { title: "Agent team", body: empty("This workspace has no workflow configuration.") };
  const agents = pipeline.config.configurables ?? [];
  const admin = snapshot.roles.includes("admin");
  const selected = agents.find(agent => agent.id === id);
  const starter = AGENT_STARTERS.find(item => item.id === preset) ?? AGENT_STARTERS[0];
  const editing = id === "new" || !!selected;
  const draftKey = `team:${id === "new" ? "new:" + starter.id : id ?? ""}`;
  const draft = ui.drafts[draftKey];
  const field = (key: string, fallback: string) => escape(draft?.[key] ?? fallback);
  const model = draft?.model ?? selected?.model ?? snapshot.chat.model ?? "";
  const tools = draft ? (draft.tools ?? "").split(",") : selected?.bot.allowedTools ?? [];
  const modelChoices = [...models];
  if (model && !modelChoices.some(item => item.id === model)) modelChoices.push({ id: model, label: model, provider: "Saved model", local: false, available: false, detail: "Refresh models to check configuration." });
  const modelOptions = modelChoices.map(item => `<option value="${escape(item.id)}" ${model === item.id ? "selected" : ""}>${escape(item.label)}${item.available ? "" : " · not connected"}</option>`).join("");
  const stageList = `<div class="team-stages">${pipeline.config.stages.map(stage => `<a href="#/workflows/${escape(stage.id)}"><small>${escape(stage.name)}</small><strong>${escape(stage.agent)}</strong><span>${stage.assistantId ? "Approved assistant" : stage.bot?.kind && stage.bot.kind !== "manual" ? escape(stage.model) : "Manual"}</span>${stage.approval ? '<span>Review required</span>' : ""}</a>`).join("")}</div>`;
  const library = agents.length ? `<div class="team-library">${agents.map(agent => {
    const known = models.find(item => item.id === agent.model);
    return `<a class="employee-card" href="#/team/${agent.id}"><div class="employee-card-heading"><span class="marketplace-category">${escape(agent.bot.kind)}</span>${status(known?.available ? "ok" : "neutral", known?.available ? "Configured" : "Check model")}</div><h2>${escape(agent.name)}</h2><p>${escape(agent.purpose)}</p><small>${escape(agent.model)} · ${effectiveToolPolicy(agent.bot).allowedTools.length} read tools</small></a>`;
  }).join("")}</div>` : empty("No saved agents yet.");
  const starters = `<div class="team-starters">${AGENT_STARTERS.map(item => `<a href="#/team/new?preset=${item.id}"><strong>${escape(item.name)}</strong><span>${escape(item.purpose)}</span></a>`).join("")}</div>`;
  const form = editing ? panel(selected?.name ?? "New agent", `<form id="team-agent" data-agent="${selected?.id ?? ""}" data-draft="${draftKey}" class="team-form">
    <div class="form-grid"><label>Name<input name="name" required maxlength="80" value="${field("name", selected?.name ?? starter.name)}"></label><label>Model<select name="model" required>${modelOptions || '<option value="">Connect a model first</option>'}</select></label></div>
    <label>Purpose<input name="purpose" required maxlength="300" value="${field("purpose", selected?.purpose ?? starter.purpose)}"></label>
    <label>Instructions<textarea name="instructions" required maxlength="4000" rows="5">${field("instructions", selected?.instructions ?? starter.instructions)}</textarea></label>
    ${more("Tools and execution limits", `<label>Role<select name="kind">${["planner", "coder", "reviewer", "validator"].map(kind => `<option ${kind === (draft?.kind ?? selected?.bot.kind ?? starter.kind) ? "selected" : ""}>${kind}</option>`).join("")}</select></label><fieldset><legend>Repository access</legend>${BOT_REPOSITORY_TOOLS.map(tool => `<label class="checkbox"><input type="checkbox" name="tools" value="${tool}" ${tools.includes(tool) ? "checked" : ""}>${toolNames[tool]}</label>`).join("")}<small>Unchecked means no access. Tools require an attached repository in local mode.</small></fieldset><div class="form-grid"><label>Model calls<input name="maxSteps" type="number" min="1" max="12" required value="${field("maxSteps", String(selected?.bot.maxSteps ?? 4))}"></label><label>Timeout (seconds)<input name="timeoutSeconds" type="number" min="15" max="300" required value="${field("timeoutSeconds", String(selected?.bot.timeoutSeconds ?? 120))}"></label><label>Tool calls<input name="maxToolCalls" type="number" min="0" max="11" required value="${field("maxToolCalls", String(selected?.bot.maxToolCalls ?? 3))}"></label></div>`)}
    <p class="text-3">Supervised configuration · No automatic approval or external delivery.</p><button class="primary" ${admin ? "" : "disabled"}>Save agent</button><a class="quiet" href="#/team">Back to team</a>
    </form>${selected ? `<form id="team-assign" data-agent="${selected.id}" class="team-assign"><label>Apply saved agent to a stage<select name="stage">${pipeline.config.stages.map(stage => `<option value="${escape(stage.id)}" ${stage.assistantId ? "disabled" : ""}>${escape(stage.name)}${stage.assistantId ? " · approved assistant assigned" : ""}</option>`).join("")}</select></label><button class="secondary" ${admin ? "" : "disabled"}>Apply to stage</button><small>Copies the saved configuration for future runs. Keeps context, Jira mapping and review gates.</small></form>` : ""}`) : `${library}${admin ? more("Start from a role", starters, !agents.length) : ""}`;
  return { title: "Agent team", context: "Choose a model. Give it a role. Reuse it across your workflow.",
    actions: `<button class="secondary" id="refresh-models">Refresh models</button>${!editing && admin ? '<a class="primary" href="#/team/new">New agent</a>' : ""}`,
    body: `<p class="text-3">${pipeline.storage === "file" ? "Saved locally" : "Demo memory · cleared on server restart"}${admin ? "" : " · An admin can edit the team"}</p>${stageList}${form}${more("How agents work here", '<p>These are reusable instructions and tool policies, not trained models or approved Studio releases. Run repository agents from the local Work desk. Each stage receives the brief and earlier handoffs; a person accepts its output.</p><a href="#/mcp">Inspect MCP connections →</a>')}` };
}
