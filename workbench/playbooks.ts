export interface SessionDraft { title: string; brief: string }

export interface DevelopmentPlaybook {
  id: string;
  name: string;
  category: string;
  description: string;
  title: string;
  outcome: string;
  acceptance: string[];
  context: string;
}

// Starters describe work rather than silently changing a workspace's tools,
// models or review gates. Each developer still chooses those in configuration.
export const DEVELOPMENT_PLAYBOOKS: readonly DevelopmentPlaybook[] = [
  {
    id: "web", name: "Web product", category: "WEB & SERVICES",
    description: "Take a user journey from interface to API, with accessible interactions and verified behavior.",
    title: "Build an accessible service experience",
    outcome: "Help a specific user complete one useful task through a responsive interface and a working API.",
    acceptance: ["Define the user, task and measurable success criteria.", "Cover loading, empty, error and success states.", "Verify keyboard navigation, small screens and the API contract.", "Record an end-to-end test and a reproducible demo."],
    context: "Name the existing repository, frontend, API and deployment target. Identify which data is real and which is a fixture.",
  },
  {
    id: "mobile", name: "Mobile experience", category: "MOBILE & DESKTOP",
    description: "Develop a focused app experience with clear device, offline and cross-platform requirements.",
    title: "Build an offline-friendly field workflow",
    outcome: "Let a field user capture and review a work item on the selected device platforms, including interrupted connectivity.",
    acceptance: ["Choose the target platforms and supported devices.", "Specify permissions, accessibility and offline behavior.", "Verify persistence, reconnect behavior and duplicate prevention.", "Record device or emulator results; distinguish tested from untested platforms."],
    context: "Choose the application's stack, such as Kotlin, Swift or a cross-platform framework. Magentic coordinates the repository's own build tools.",
  },
  {
    id: "data-ai", name: "Data & AI prototype", category: "DATA & RESEARCH",
    description: "Turn a documented dataset and a clear question into a reproducible analysis or AI feature.",
    title: "Explore a public-service dataset",
    outcome: "Help a named user answer one question using a documented public dataset and an explainable result.",
    acceptance: ["Record the dataset URL, publisher, license, version and limitations.", "Validate schema, missing values and representative edge cases.", "Compare the result against a stated baseline; cite source evidence.", "Keep a reproducible evaluation and a short walkthrough of limitations."],
    context: "Supply the actual dataset and selected stack. Public-sector examples need real public data; this starter has not downloaded or validated a dataset.",
  },
  {
    id: "automation", name: "Workflow automation", category: "TOOLS & INTEGRATIONS",
    description: "Connect an event to a reviewed action with permission checks, retries and traceable evidence.",
    title: "Turn validation failures into reviewed work items",
    outcome: "Convert a test or evaluation failure into a proposed Jira action, with a human review before delivery.",
    acceptance: ["Map the source event to the issue fields and supporting evidence.", "Enforce workspace permissions and authorization for the exact payload.", "Test duplicate events, rate limits and uncertain delivery outcomes.", "Demonstrate preview mode and distinguish it from confirmed external delivery."],
    context: "Name the event source, target project and connector. Jira delivery requires a configured adapter; this starter does not connect external accounts.",
  },
];

export function playbookBrief(playbook: DevelopmentPlaybook): string {
  return `USE CASE: ${playbook.name}\n\nOUTCOME\n${playbook.outcome}\n\nCONTEXT & STACK\n${playbook.context}\n\nACCEPTANCE CRITERIA\n${playbook.acceptance.map(item => `- ${item}`).join("\n")}\n\nPERSONALIZE\nAdd your user, constraints, chosen tools and evidence sources before starting.`;
}
