# Presentation and submission website

The existing presentation design is extended in place. This is a static website, not a company workspace or a replacement for its authentication.

## Preview

From the Magentic checkout, using Node 22:

```powershell
node docs/site/serve.mjs --port=4184
```

Open http://127.0.0.1:4184/. The server binds to loopback and serves only the HTML, CSS and JavaScript presentation assets. It exposes no repository files or workspace data. Keep 4182 for the application and the company server on its existing port. An occupied port fails rather than stopping another process.

You can also open `index.html` directly. No installation, build or API key is required. The two typefaces load from Google Fonts when the machine is online and fall back to system fonts offline. Relative CSS and JavaScript must remain beside it. Source links and the local-app link need their destinations to be available.

## Presentation route

1. Introduce the documentation request: explain repository access from an SOP, without claiming to grant access.
2. Walk through Workspace, Request, Grounding and Draft. All displayed records and output are synthetic.
3. In Review, try owner approval. Simulate reviewer A: handoff still needs a second reviewer. Simulate reviewer B to complete this scenario's two-reviewer policy.
4. Revise the sample draft. Both simulated signatures clear. Review again to enable Handoff. These controls illustrate the rule; they are not backend authentication or real signatures.
5. Open Audit. Explain the separate company Slack message preview and delivery receipts. No message is sent by this website.
6. Switch the architecture panels to explain frontend state, backend policy, model/tool execution and company access. Each panel links to implementation files on `main`.
7. Open Company security. Select Sign in, Read, Draft, Approve and Audit to compare built-in controls with proposed AWS protections. Expand "How to verify it" for each stage. These examples run no authentication or security checks and connect to no cloud services.
8. Close with the verification results and current limits. Print/save PDF captures the currently selected walkthrough, architecture and security panels alongside the static content.

## Real application demonstration

The website links to the existing local app at http://127.0.0.1:4182/#/workspace. That link works only on a machine running the app. Stop at the approval gate if the real workspace has no eligible independent reviewers. Do not present simulated sign-offs as real approvals.

For the repeatable product demo, use:

```powershell
corepack pnpm build:workbench
corepack pnpm demo:agents
```

Open its printed URL (normally port 4183). The model is scripted, while the workflow engine, MCP reads and approval checks are real. See [Agent Studio demo](../agent-studio-demo.md) for the complete procedure and the optional live Ollama mode. A live model run is a separate measurement; do not reuse the website's sample answer as proof of accuracy.

## Submission checklist

- Include `index.html`, `presentation.css` and `presentation.js` together. `serve.mjs` is the optional local preview launcher.
- Include the repository commit/branch and engineering README so reviewers can reproduce the work.
- Record a product walkthrough using synthetic data. Do not include personal workspace records, provider credentials or company documents.
- State whether the recording uses the scripted demo or a live provider. Only quote token counts and latency actually reported for that run.
- Verify the submission's requested format and URL requirements separately. A Git push does not publish this website or submit an entry.

The page does not claim production readiness, federal authorization or regulatory compliance. Company infrastructure, isolated workers, operational recovery and real integrations require additional validation.
