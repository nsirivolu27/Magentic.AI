import type { SlackPreview, SlackSummary } from "./slack.js";
import { escape } from "./ui.js";

export function slackControls(summary?: SlackSummary, preview?: SlackPreview): string {
  const canSend = summary?.ready && summary.canSend;
  return `<section class="console-drawer" aria-labelledby="slack-heading"><h2 id="slack-heading">Slack</h2>
    <p>${summary?.configured ? escape(summary.channel) + " · " + (summary.ready ? "Configured · not connection-tested" : "Server credential needed") : "Not connected"}</p>
    <p class="text-3">Company audit summaries and team updates. Approvals stay in Magentic.</p>
    ${!summary?.configured ? '<p class="text-3">An operator configures MAGENTIC_SLACK_FILE and a private webhook setting on the company server.</p>' : ""}
    ${canSend ? (preview ? `<div class="console-message"><h3>Preview for ${escape(preview.channel)}</h3><pre>${escape(preview.text)}</pre><p class="text-3">Expires in five minutes. Check the content and channel before sending.</p><button class="primary" data-slack-action="send">Send to Slack</button><button class="secondary" data-slack-action="cancel">Discard</button></div>`
      : '<label>Message type<select id="slack-kind"><option value="audit">Workflow audit summary</option><option value="message">Team update</option></select></label><label>Message or optional audit note<textarea id="slack-note" rows="3" maxlength="1000" placeholder="No secrets or sensitive records"></textarea></label><button class="secondary" data-slack-action="preview">Preview message</button>')
      : summary?.configured ? '<p class="text-3">Sending requires an administrator in the company application and a configured webhook.</p>' : ""}
    ${summary?.receipts.length ? `<details><summary>Recent delivery receipts</summary><ul>${summary.receipts.map(receipt => `<li>${escape(receipt.at)} · ${escape(receipt.actor)} · ${receipt.state === "sent" ? "Accepted by Slack" : "Unconfirmed — check the channel; do not retry blindly"}</li>`).join("")}</ul></details>` : ""}</section>`;
}
