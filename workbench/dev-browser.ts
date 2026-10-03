import "./browser.js";

declare const __MAGENTIC_DEV_REVISION__: string;

const banner = document.createElement("aside");
banner.className = "development-status";
banner.setAttribute("aria-label", "Development server status");
const status = document.createElement("span");
status.setAttribute("role", "status");
status.textContent = "Development · watching source files";
const reload = document.createElement("button");
reload.className = "secondary";
reload.textContent = "Reload latest build";
reload.hidden = true;
reload.addEventListener("click", () => location.reload());
banner.append(status, reload);
document.body.append(banner);
let edited = false;
let reconnectedRevision: string | undefined;
document.addEventListener("input", () => { edited = true; });
document.addEventListener("change", () => { edited = true; });
document.addEventListener("click", event => {
  if ((event.target as Element).closest("[data-bot-template], [data-use-playbook], [data-pipeline-edit], [data-work-federal], [data-material-remove]")) edited = true;
});

async function check() {
  try {
    const response = await fetch("/manifest.webmanifest", { cache: "no-store", signal: AbortSignal.timeout(2000) });
    if (!response.ok) throw new Error("Backend restarting");
    const manifest = await response.json() as { magenticDevRevision?: string };
    if (manifest.magenticDevRevision && manifest.magenticDevRevision !== __MAGENTIC_DEV_REVISION__) {
      if (reconnectedRevision !== manifest.magenticDevRevision) {
        // Claim the restarted session while keeping unsaved fields on screen.
        // Waiting for a manual reload could miss the normal bootstrap window.
        const page = await fetch("/", { cache: "no-store", signal: AbortSignal.timeout(2000) });
        if (!page.ok) throw new Error("Backend restarting");
        reconnectedRevision = manifest.magenticDevRevision;
      }
      status.textContent = "New build ready · reload to reconnect";
      reload.hidden = false;
      // A rebuild must not silently discard an unsaved form or a review.
      // After any editing, let the user choose when to replace the page.
      if (!edited && !document.querySelector("dialog[open], main[aria-busy='true'], #stop-chat")) location.reload();
    } else status.textContent = "Development · watching source files";
  } catch { status.textContent = "Development server reconnecting…"; }
  setTimeout(() => { void check(); }, 1500);
}
void check();
