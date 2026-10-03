# Demo script: Northwind Federal (about 8 minutes)

## Before you start

- In VS Code: Terminal → Run Task → `workbench: demo`. Wait for "Magentic Developer: http://127.0.0.1:4173/".
- Ollama must be running with `qwen2.5-coder:7b` installed, or drafts will fail with "fetch failed". Check: open http://127.0.0.1:11434/api/tags in a browser and look for the model name.
- Open http://127.0.0.1:4173/ in Chrome. Identity: Alex · Author. Refresh once.
- Have the architecture diagram open in another tab (`docs/architecture/magentic-architecture.png`).

## 1. The workspace (1 minute)

Home page. Two projects. Point at the Delivery assistant chain: Dataset → Candidate → Evaluation → Release → Assistant, all green. Say: "Every box is a real record. The assistant at the end exists only because two reviewers signed the release."

Point at Agentic units: Northwind Federal delivery bot, v1, Ready. "This is the same assistant seen as a worker."

## 2. The training portal (1.5 minutes)

Model Studio → Delivery assistant. Click through Dataset (80 engagement notes, secrets counted, none shown), Evaluation (4 of 4 metrics), Release (2 of 2 signed), Assistant (instructions in the practice's own words). Read the instructions aloud: agency and org named, numbered steps, ATO evidence named, "Next step:".

## 3. The workflow (1 minute)

Workflows. Salesforce delivery, 7 stages. Discovery is solid (staffed by the assistant); the rest are by hand. Click Discovery: the stage panel shows who does it, what it records, the review gate, the Jira status.

Optional: the template menu (top right) shows the other templates, including software delivery for engineering teams.

## 4. A live engagement (3 minutes)

Start a run. Title: "Grant inquiry routing for the Bureau of Grants Oversight". Brief: "Portal cases must reach the regional team within SLA." Issue key: SFDC-42.

Complete Intake by hand: "The bureau wants grant inquiry cases routed by region and program."

Wait. Discovery shows Queued, then Drafting, then Draft ready with the draft in the practice's voice and its token cost. Say: "Nobody clicked anything. The scheduler saw a staffed stage, took a fresh binding, asked the model, and attached a draft. It cannot complete the stage."

Click "Use draft to complete Discovery". Now Solution design is awaiting review. Switch identity to Alex and try to approve: refused, the owner cannot approve. Switch to Sam, approve; switch to Jordan, approve. Build is active. Point at the Jira status on the stage panel.

## 5. Cost and control (1 minute)

Home page: the units table shows tokens for the assistant.

Model Studio → Delivery assistant → Release → Retire (as Taylor, admin). Back to Workflows: start another run. Refused: "Stage Discovery: the release is retired." Say: "Same rule everywhere. Chat, the editor plugin and any MCP client are refused the same way."

## 6. Close (30 seconds)

Architecture diagram tab. Trace one magenta arrow: resolveProfile. "Everything that acts goes through this one function. That is the whole governance story."

## If something goes wrong

- Draft failed: Ollama is not running or the model is missing. Click Try again after starting it.
- Page does not load: the demo task is not running; re-run it.
- Identity switch not visible: bottom left, "Acting as".
