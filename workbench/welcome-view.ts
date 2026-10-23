export function welcomePage(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="description" content="Magentic connects agents, reference material, and human review in one browser workspace.">
  <title>Magentic · Your work, connected</title>
  <link rel="icon" href="/icon.svg"><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/agency.css">
</head>
<body class="welcome-page">
  <a class="skip-link" href="#welcome-main">Skip to content</a>
  <header class="welcome-nav">
    <a href="/welcome" class="welcome-brand" aria-label="Magentic home"><span aria-hidden="true">◆</span> Magentic</a>
    <nav aria-label="Website navigation"><a href="#workflow">How it works</a><a href="/login?next=chat" class="welcome-enter">Open chat <span aria-hidden="true">↗</span></a></nav>
  </header>
  <main id="welcome-main">
    <section class="welcome-hero" aria-labelledby="welcome-title">
      <div class="welcome-intro"><p class="welcome-kicker">THE AGENT WORKSPACE</p>
        <h1 id="welcome-title">Chat. Build.<br><span>Automate.</span></h1>
        <p class="welcome-summary">Your models, agents, and workflows in one place.</p>
        <div class="welcome-actions"><a href="/login?next=chat" class="primary">Open chat <span aria-hidden="true">↗</span></a><a href="#workflow">Explore the workflow <span aria-hidden="true">↓</span></a></div>
        <p class="welcome-caption">Browser workspace. Your model connections.</p>
      </div>
      <figure class="welcome-preview" aria-labelledby="preview-title">
        <figcaption><span class="welcome-kicker">WORKFLOW PREVIEW</span><span>Illustrative example</span></figcaption>
        <h2 id="preview-title">Turn a policy update into a team guide.</h2>
        <ol class="welcome-timeline">
          <li><span class="welcome-step" aria-hidden="true">01</span><div><h3>Add the context</h3><p>Policy document + team requirements</p></div><span class="welcome-kind">YOU</span></li>
          <li><span class="welcome-step" aria-hidden="true">02</span><div><h3>Prepare the draft</h3><p>An agent works from the supplied material</p></div><span class="welcome-kind">AGENT</span></li>
          <li><span class="welcome-step" aria-hidden="true">03</span><div><h3>Check the evidence</h3><p>Inspect the output before accepting it</p></div><span class="welcome-kind">REVIEW</span></li>
        </ol>
        <p class="welcome-preview-note">A person decides what moves forward.</p>
      </figure>
    </section>
    <section class="welcome-workflow" id="workflow" aria-labelledby="workflow-title">
      <div class="welcome-section-heading"><p class="welcome-kicker">FROM TASK TO HANDOFF</p><h2 id="workflow-title">One workspace. Three places to start.</h2></div>
      <div class="welcome-cards">
        <article><span class="welcome-number">01 / CHAT</span><h3>Start with a conversation.</h3><p>Ask a model. Add workspace tools when needed.</p><a href="/login?next=chat">Open chat <span aria-hidden="true">↗</span></a></article>
        <article><span class="welcome-number">02 / AGENT STUDIO</span><h3>Shape how the agent works.</h3><p>Choose instructions, tools, and checks.</p><a href="/#/agent-studio">Open Agent Studio <span aria-hidden="true">↗</span></a></article>
        <article><span class="welcome-number">03 / WORKFLOWS</span><h3>Keep the handoffs clear.</h3><p>Assign stages. Review before advancing.</p><a href="/#/workflows">Open workflows <span aria-hidden="true">↗</span></a></article>
      </div>
    </section>
    <section class="welcome-details" aria-labelledby="connections-title">
      <div><p class="welcome-kicker">CONNECTED, WITH BOUNDARIES</p><h2 id="connections-title">Your tools. Your context.<br>Your review process.</h2></div>
      <div class="welcome-questions">
        <details><summary>Where do models and tools connect?</summary><p>Providers run models; MCP connects tools. Each connection needs setup and permission.</p><a href="/#/mcp">Inspect MCP connections ↗</a></details>
        <details><summary>What requires a person?</summary><p>You configure the workflow gates. Releases require the workspace’s approval policy, and edits invalidate approvals tied to old content.</p><a href="/#/workflow">View review policy ↗</a></details>
        <details><summary>Can I use it without installing a desktop app?</summary><p>Yes. Open this webpage in your browser. The current preview runs on a local server; a shared hosted workspace is a separate deployment.</p></details>
      </div>
    </section>
  </main>
  <footer class="welcome-footer"><a class="welcome-brand" href="/welcome"><span aria-hidden="true">◆</span> Magentic</a><span>Agents with context. Work with oversight.</span><a href="/login">Workspace access ↗</a></footer>
</body></html>`;
}
