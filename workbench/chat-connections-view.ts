import type { ChatAccessSummary } from "./chat-access.js";
import type { ChatModelOption } from "./chat.js";
import type { Page } from "./studio-view.js";
import { status } from "./ui.js";

const escape = (value: string) => value.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
export interface ConnectionFeedback {
  provider: string;
  state: "verifying" | "error";
  message?: string;
  models: string[];
}
export function chatConnectionsPage(access?: ChatAccessSummary, error?: string, feedback?: ConnectionFeedback, server?: { models: ChatModelOption[]; loading: boolean; error?: string }): Page {
  if (!access) return { title: "Connections", body: `<section class="panel account-panel"><p role="status">${escape(error ?? "Loading your connections…")}</p><button class="secondary" data-chat-access-refresh>Retry</button></section>` };
  const providers = [{ id: "openai", name: "OpenAI", url: "https://platform.openai.com/api-keys" },
    { id: "anthropic", name: "Claude", url: "https://console.anthropic.com/settings/keys" },
    { id: "google", name: "Gemini", url: "https://aistudio.google.com/apikey" }];
  return { title: "Connections", context: "Models and access.", actions: '<a class="primary" href="#/base-chat">Back to chat</a>', body: `
    ${error ? `<p role="alert">${escape(error)}</p>` : ""}
    <section class="panel account-panel" aria-labelledby="server-models-title"><div class="provider-head"><h2 id="server-models-title">Server models</h2><button class="secondary" data-refresh-models ${server?.loading ? "disabled" : ""}>${server?.loading ? "Checking models…" : "Refresh models"}</button></div>
      <p>Ollama and administrator-configured APIs. Personal API accounts below remain private to your workspace account; workflow agents use server configuration, not your personal keys.</p>
      ${server?.error ? `<p role="status">${escape(server.error)}</p>` : ""}
      ${server?.loading ? '<p role="status">Checking model service availability…</p>' : server?.models.length ? `<ul class="agent-readiness">${server.models.filter(model => !model.id.startsWith("personal/")).map(model => `<li><div><strong>${escape(model.label)}</strong> · ${escape(model.provider)} ${status(model.available ? "ok" : "warn", model.available ? "Configured" : "Unavailable")}<small>${escape(model.detail)}</small></div></li>`).join("")}</ul>` : '<p class="text-2">No server models have been listed yet. Refresh to check the connection.</p>'}
      <details><summary>Ollama and API setup</summary><p>On the application server, set <code>MAGENTIC_LLM_PROVIDER=ollama</code>, <code>MAGENTIC_LLM_BASE_URL</code> and <code>MAGENTIC_LLM_CHAT_MODEL</code>, then restart. Install the chosen model in Ollama separately; this app never downloads one automatically.</p><p>Ollama must be reachable from the application server. A loopback address points to that server, not to your laptop.</p><p>API-only setups do not need Ollama. Store provider keys as server secrets and set the corresponding <code>MAGENTIC_OPENAI_MODELS</code>, <code>MAGENTIC_ANTHROPIC_MODELS</code> or <code>MAGENTIC_GOOGLE_MODELS</code> to model IDs your account supports. Azure and compatible gateways use their existing server settings.</p><p>Configured access is not an inference health check. A provider may still reject a model request.</p></details>
    </section>
    <section class="panel account-panel connection-accounts"><div class="provider-head"><h2>Your accounts</h2><button class="secondary" data-chat-access-refresh>Refresh connections</button></div><p>Connect a provider, then choose a model in Chat. Provider charges apply.</p>
      <div class="provider-cards">${providers.map(provider => {
        const connected = access.connections.find(item => item.provider === provider.id);
        const update = feedback?.provider === provider.id ? feedback : undefined;
        const state = update?.state ?? (connected ? "connected" : "disconnected");
        const models = update?.models ?? connected?.models ?? [];
        const label = state === "verifying" ? "Verifying" : state === "error" ? "Update failed" : connected ? "Connected" : "Not connected";
        const tone = state === "verifying" ? "progress" : state === "error" ? "bad" : connected ? "ok" : "neutral";
        // A saved key is not a health check; keep the last saved models visible after a failed replacement.
        return `<article class="provider-card ${state}" aria-labelledby="provider-${provider.id}" aria-busy="${state === "verifying"}">
          <div class="provider-head"><h3 id="provider-${provider.id}">${provider.name}</h3>${status(tone, label)}</div>
          ${connected ? `<p class="provider-models">${connected.models.map(model => `<span>${escape(model)}</span>`).join("")}</p><p class="provider-note">Saved API access · model availability may change.</p>` : '<p>Add your API key and text model IDs.</p>'}
          ${update?.state === "error" ? `<p class="provider-error" role="alert">${escape(update.message ?? "Could not update this connection. Try again.")}${connected ? " Previously saved models are shown. Refresh to confirm access." : ""}</p>` : ""}
          ${state === "verifying" ? '<p role="status">Checking API access…</p>' : ""}
          <div class="provider-actions">${connected ? '<a class="secondary" href="#/base-chat">Open chat</a>' : `<a href="${provider.url}" target="_blank" rel="noreferrer">Get API key ↗</a>`}</div>
          <details ${update ? "open" : ""}><summary>${connected ? "Manage connection" : "Connect"}</summary>
            <form data-provider-connect="${provider.id}"><label>API key<input type="password" name="apiKey" autocomplete="off" required maxlength="4096" ${feedback?.state === "verifying" ? "disabled" : ""}></label><label>Model IDs<input name="models" required maxlength="3000" placeholder="Model IDs, separated by commas" value="${escape(models.join(", "))}" ${feedback?.state === "verifying" ? "disabled" : ""}></label><small>Text models only. Verification checks access, not inference.</small><button class="primary" type="submit" ${feedback?.state === "verifying" ? "disabled" : ""}>${state === "verifying" ? "Verifying…" : "Verify & save"}</button></form>
            ${connected ? `<div class="provider-actions"><a href="${provider.url}" target="_blank" rel="noreferrer">Provider console ↗</a><button class="secondary" data-provider-disconnect="${provider.id}" ${feedback?.state === "verifying" ? "disabled" : ""}>Disconnect</button></div>` : ""}
          </details></article>`;
      }).join("")}</div>
      <details><summary>Connection details</summary><p>Keys stay encrypted on this server and private to your workspace account. Provider sign-in requires separate authorization.</p><p>An administrator can configure Azure or a compatible gateway.</p></details>
    </section>
    <details class="panel account-panel connection-plans"><summary>Plans &amp; company access</summary>
    <div class="chat-plan-grid">
      <section class="panel account-panel"><span class="chat-plan-status">${access.tier === "free" ? "CURRENT PLAN" : "ALWAYS AVAILABLE"}</span><h2>Free · Your connections</h2><p>Your models. Provider charges apply.</p></section>
      <section class="panel account-panel"><span class="chat-plan-status">${access.tier === "paid" && access.plan !== "max" ? "CURRENT PLAN" : access.managedReady ? "PAID PLAN" : "SETUP NEEDED"}</span><h2>Pro</h2><p>Managed models. Auto routing.</p><a href="#/account">${access.tier === "paid" ? "Manage plan" : "View plan"}</a>${access.dailyTokens && access.plan !== "max" ? `<p>${access.accountedTokens.toLocaleString("en-US")} / ${access.dailyTokens.toLocaleString("en-US")} workspace tokens today.</p><details><summary>Usage details</summary><p>Failed or unmetered calls retain a reservation. This allowance is not an invoice.</p></details>` : ""}</section>
      <section class="panel account-panel"><span class="chat-plan-status">${access.plan === "max" ? "CURRENT PLAN" : access.managedReady ? "PLAN OPTION" : "SETUP NEEDED"}</span><h2>Max</h2><p>Custom model pool and allowance.</p><a href="#/account">View plans</a>${access.plan === "max" && access.dailyTokens ? `<p>${access.accountedTokens.toLocaleString("en-US")} / ${access.dailyTokens.toLocaleString("en-US")} tokens accounted today.</p>` : ""}</section>
    </div>
    <section class="panel account-panel"><details><summary>Company access</summary><p>Company SSO and model routing need administrator setup. Email alone does not grant access.</p><a href="/login?next=chat">Workspace sign-in</a></details></section>
    </details>
    <section class="panel account-panel"><h2>MCP access</h2><p>Use chat in a compatible MCP app.</p><p>${access.mcp.active ? `Credential active until ${escape(access.mcp.expiresAt ?? "")}.` : "No active chat credential."}</p>
      <details><summary>Connect an app</summary><p>A trusted app can use your models and allowance for seven days. Requests may send conversations to providers and incur charges. A new credential replaces the previous one.</p><button class="secondary" data-chat-token="issue">Create 7-day credential</button>${access.mcp.active ? '<button class="secondary" data-chat-token="revoke">Revoke access</button>' : ""}<div id="chat-token-result"></div></details>
      <details><summary>Technical details</summary><p>Streamable HTTP: <code>/api/chat-mcp</code>. Tools: <code>list_chat_models</code>, <code>chat</code>.</p><p>Local clients only unless you deploy a reachable server. Client support varies.</p></details>
    </section>` };
}
