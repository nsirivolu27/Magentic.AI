import type { Mailbox } from "./email.js";

export type MailFolder = "inbox" | "outbox" | "invitations";
const escape = (value: string) => value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
const labels = { review: "Review request", approval: "Approval update", changes: "Changes requested", retired: "Retirement", invitation: "Invitation" };

export function emailView(mail: Mailbox | undefined, actor: string, folder: MailFolder, query: string, selectedId?: string): string {
  if (!mail) return '<p class="empty">Email previews are not configured for this workspace.</p>';
  const inbox = mail.messages.filter((message) => message.recipientActor === actor);
  const invitations = mail.messages.filter((message) => message.kind === "invitation");
  const outbox = mail.messages.filter((message) => message.sender === actor || mail.canInvite);
  const folderMessages = folder === "inbox" ? inbox : folder === "invitations" ? invitations : outbox;
  const messages = folderMessages.filter((message) => `${message.subject} ${message.recipient} ${message.sender} ${message.text}`.toLowerCase().includes(query.toLowerCase()));
  const selected = messages.find((message) => message.id === selectedId);
  return `<div class="mail-banner"><span class="mail-banner-icon">✉</span><div><strong>Your workspace, in the loop.</strong><p>Review requests and approval updates live here. Delivery is in preview mode: no emails leave this app.</p></div><span class="mail-mode">PREVIEW MODE</span></div>
    <div class="mail-toolbar"><div class="mail-folders" role="group" aria-label="Email folders">
      <button class="${folder === "inbox" ? "selected" : ""}" data-mail-folder="inbox">Inbox <span>${inbox.filter((message) => !message.viewed).length}</span></button>
      <button class="${folder === "outbox" ? "selected" : ""}" data-mail-folder="outbox">Outbox <span>${outbox.length}</span></button>
      ${mail.canInvite ? `<button class="${folder === "invitations" ? "selected" : ""}" data-mail-folder="invitations">Invitations <span>${invitations.filter((message) => message.status === "preview").length}</span></button>` : ""}
      </div><button class="secondary" id="mail-preferences">Notification preferences</button></div>
    <div class="mail-layout ${selected ? "has-selection" : ""}"><section class="mail-list" aria-label="Messages">
      <label class="mail-search"><span>⌕</span><input type="search" id="mail-search" aria-label="Search email" placeholder="Search messages…" value="${escape(query)}"></label>
      <div class="mail-list-heading">${folder === "inbox" ? "FOR YOU" : folder === "outbox" ? "WORKSPACE OUTBOX" : "INVITATION DRAFTS"}<span>${messages.length} messages</span></div>
      ${messages.map((message) => `<button class="mail-row ${selected?.id === message.id ? "selected" : ""} ${!message.viewed && message.recipientActor === actor ? "unread" : ""}" data-mail-id="${message.id}">
        <div class="mail-row-top"><span>${escape(message.sender)}</span><time>${escape(new Date(message.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric" }))}</time></div>
        <strong>${escape(message.subject)}</strong><p>To ${escape(message.recipient)}</p><span class="mail-kind ${message.kind}">${labels[message.kind]}</span>${message.status === "cancelled" ? '<span class="mail-cancelled">Cancelled</span>' : ""}</button>`).join("") || '<div class="empty">Nothing here yet.<p>Messages appear as your team reviews agents.</p></div>'}
      </section><section class="mail-reader" aria-label="Email preview">
      ${selected ? `<div class="mail-reader-top"><button class="secondary mail-back" id="mail-back">← Messages</button><span class="mail-kind ${selected.kind}">${labels[selected.kind]}</span><span class="mail-delivery">${selected.status === "cancelled" ? "Cancelled draft" : "Preview · not sent"}</span></div>
        <h2>${escape(selected.subject)}</h2><div class="mail-envelope"><div><span>From</span><strong>Magentic workspace</strong></div><div><span>To</span><strong>${escape(selected.recipient)}</strong></div><div><span>Created by</span><strong>${escape(selected.sender)}</strong></div><div><span>Date</span><strong>${escape(new Date(selected.createdAt).toLocaleString())}</strong></div></div>
        <div class="mail-letter"><div class="mail-letter-brand"><span class="mark">m</span> magentic.</div><p class="mail-body">${escape(selected.text)}</p>
        ${selected.agentName ? `<button class="primary" data-mail-agent="${escape(selected.agentName)}">Open agent for review ↗</button>` : '<p class="mail-invite-note">No account is created by this draft. Delivery and membership onboarding must be connected before invitations can be accepted.</p>'}
        </div><div class="mail-reader-footer"><span>Only the recipient can mark this preview as viewed.</span>${mail.canInvite && selected.kind === "invitation" && selected.status === "preview" ? `<button class="secondary" data-cancel-invite="${selected.id}">Cancel invitation draft</button>` : ""}</div>`
        : '<div class="mail-placeholder"><span class="mail-placeholder-icon">✉</span><h2>A little clarity in every message.</h2><p>Select a message to see the email your teammate would receive, with a direct path back to their work.</p><span>Private to this workspace · preview only</span></div>'}
      </section></div>`;
}
