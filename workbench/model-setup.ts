import type { ChatModelOption } from "./chat.js";
import { escape } from "./ui.js";

/**
 * The notice shown when the selected model cannot be used yet.
 *
 * A local model that is not running is a setup state, not a failure: the
 * person has to start Ollama and install the model once. A cloud provider
 * without a key is the same kind of state. The wording names the one next
 * step for each, and the tone is a warning rather than an error.
 */
export interface ModelSetupNotice { tone: "warn" | "bad"; title: string; body: string; steps: string[] }

export function modelSetupNotice(selected: ChatModelOption): ModelSetupNotice {
  if (selected.local) {
    return {
      tone: "warn", title: "Ollama is not running",
      body: "Magentic looks for Ollama on this computer at 127.0.0.1:11434 (or the address in MAGENTIC_LLM_BASE_URL). Nothing leaves the machine until a model answers.",
      steps: [
        `Install Ollama from <a href="https://ollama.com/download" target="_blank" rel="noopener noreferrer">ollama.com/download</a> and start it.`,
        `In a terminal run <code>ollama pull ${escape(selected.id)}</code> to install the model.`,
        "Choose Refresh models, then start a new chat.",
      ],
    };
  }
  return { tone: "warn", title: `Connect ${selected.provider}`, body: selected.detail, steps: ["Choose a connected model to start a new chat."] };
}

export function modelSetupHtml(selected: ChatModelOption): string {
  const notice = modelSetupNotice(selected);
  return `<div class="chat-setup ${notice.tone}" role="status"><strong>${escape(notice.title)}</strong><p>${escape(notice.body)}</p>
    <ol>${notice.steps.map(step => `<li>${step}</li>`).join("")}</ol><button class="secondary" data-refresh-models>Refresh models</button></div>`;
}
