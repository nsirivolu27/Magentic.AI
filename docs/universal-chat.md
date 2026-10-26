# Connected chat

Open **Services → Chat** for general chat or workspace MCP chat, and
**Services → Models & connections** for model setup.

Free access uses local models or personal API credentials. OpenAI, Anthropic and
Gemini connections are scoped to the authenticated workspace and member. The
provider's models endpoint verifies the key and selected model IDs before saving.
Use text-generation models supported by the provider's chat API. Listing a model
does not guarantee quota, inference access or JSON output support. These API connections use provider API billing. Provider-supported subscription
authorization is a separate integration and is not implemented by these forms.

Credentials are encrypted with AES-256-GCM in the application's data directory.
The local key is in `chat-connections/vault.key`. For managed installations set
`MAGENTIC_CONNECTIONS_KEY` to a 32-byte key encoded as 64 hexadecimal characters,
kept outside the data directory. Back up data and key separately. Encryption does
not protect against the server administrator or a compromised running server.
The browser cannot retrieve saved keys. Disconnect removes that provider from
future requests; it cannot recall a request already sent.

## Ollama and server API setup

Workbench chat, workflow bots and Chat MCP share the workbench model configuration.
Ollama chat uses its native `/api/tags` and `/api/chat` endpoints; it does not need
an optional LangChain package. The standalone relay's retrieval and embedding
tools retain their own optional-adapter requirements.

For local Ollama, run it on a machine reachable from the application server,
install the selected model separately, and configure:

```sh
export MAGENTIC_LLM_PROVIDER=ollama
export MAGENTIC_LLM_BASE_URL=http://127.0.0.1:11434
export MAGENTIC_LLM_CHAT_MODEL=YOUR_INSTALLED_MODEL_ID
corepack pnpm build:workbench
corepack pnpm local:workbench
```

`127.0.0.1` means the application server, not a remote user's laptop. This
conversation environment does not provide an Ollama daemon or a hosted model.
The app lists installed models, refuses unknown selections, and never pulls a
model automatically. Source reads and independent workflow review are unchanged.
Native requests carry structured output format, output limits and cancellation;
usage appears only when Ollama actually reports it.

API-only installations may configure server secrets (`OPENAI_API_KEY`,
`ANTHROPIC_API_KEY`, `GEMINI_API_KEY` or `GOOGLE_API_KEY`) and supported text model
IDs through the existing `MAGENTIC_*_MODELS` settings. They do not need to enable
Ollama or set `MAGENTIC_LLM_PROVIDER` merely to make API models available.
An explicitly selected `MAGENTIC_LLM_CHAT_MODEL` is retained. An OpenAI-compatible
`MAGENTIC_LLM_BASE_URL` is routed through that endpoint, never silently replaced
by the public OpenAI API. Keys are server secrets, never command-line examples
or committed configuration.

Connections now shows server models separately from personal API accounts,
with refresh and unavailable states. “Configured” means settings or model
discovery are available, not that a paid inference request has succeeded.
Personal credentials are not granted to workflow agents.

## Managed models and Auto

Paid chat requires configured Clerk membership, Stripe customer mapping and an
active or trialing subscription containing the configured price. Entitlement is
checked against Stripe before use and on each managed model invocation. A browser
plan flag, checkout return URL or unrelated active subscription grants nothing.
Test-mode Stripe subscriptions are suitable only for development.

Configure server provider keys through the existing settings. Override the offered
text model IDs with `MAGENTIC_OPENAI_MODELS`, `MAGENTIC_ANTHROPIC_MODELS` and
`MAGENTIC_GOOGLE_MODELS` (comma separated). Azure deployments and compatible
gateways retain their existing settings. A local router can be used through
`MAGENTIC_GATEWAY_BASE_URL` and `MAGENTIC_GATEWAY_MODELS`; install and authorize it
separately. This application does not reuse consumer subscription sessions.

Point `MAGENTIC_CHAT_PLAN_FILE` to a strict JSON configuration. This illustrative
example uses gateway aliases that must actually exist in your gateway:

```json
{
  "dailyTokens": 100000,
  "models": [
    {
      "id": "gateway/efficient-text",
      "tasks": ["quick", "general", "code"],
      "strength": "efficient",
      "priority": 0,
      "maxOutputTokens": 2048
    },
    {
      "id": "gateway/reasoning-text",
      "tasks": ["general", "code", "analysis"],
      "strength": "capable",
      "priority": 1,
      "maxOutputTokens": 4096
    }
  ]
}
```

Auto is explicit and off by default. Enabling it permits provider changes for
the selected conversation. Economy favors configured efficient models, Balanced
favors balanced models, and Quality favors capable models, within the task's
eligible pool. Priority breaks ties. These are operator-defined roles, not
benchmarked accuracy or price rankings. There is no silent retry on another
provider after a failed invocation. Approved assistant profiles reject Auto.

Task rules inspect the current prompt without an extra model call. Output budgets
start at 512, 1024, 2048 or 3072 tokens for quick, general, coding or analysis work.
Economy reduces them and Quality increases them, bounded by the plan. The user
chooses current-message, recent-history or full-history context; history is not
silently summarized. Routing model, reason, cap and reported usage are visible.
Longer output is not proof of accuracy. Evaluate actual workloads before claiming
optimal routing or percentage savings.

The daily managed allowance is shared by the workspace, resets at UTC midnight
and persists across restarts. Each invocation reserves prompt UTF-8 bytes plus
the output cap and framing overhead before the provider call. Reported token
counts replace that reservation on success. Unmetered or failed calls retain the
reservation. This conservative admission estimate is not a dollar budget or a
provider-exact tokenizer. Usage may exceed a reservation when a provider reports
extra tokens; subsequent calls are refused. Production metering needs provider
reconciliation and a transactional store before running multiple server replicas.

## Portable MCP connection

Connections can create a separate seven-day credential for `/api/chat-mcp`.
It is scoped to one member and workspace. Rotation replaces the previous grant;
revocation and membership removal stop future calls. Only the token hash is saved.
Existing registry and pipeline credentials cannot use this endpoint.

The Streamable HTTP endpoint exposes `list_chat_models` and `chat`. The latter
accepts the same message, model, output cap, history, routing and preference fields
as general chat. It cannot use assistant profiles or workspace tools. It shares
the same entitlement, usage and concurrency checks as browser chat. A call may
send its conversation to an external provider and consume API credits.
MCP client cancellation propagates to the provider and releases the shared
active-request slot; the two-minute request deadline still applies.

Example client configuration (syntax varies by client):

```json
{
  "mcpServers": {
    "magentic": {
      "url": "http://127.0.0.1:4182/api/chat-mcp",
      "headers": { "Authorization": "Bearer <scoped chat credential>" }
    }
  }
}
```

Do not paste the credential into a conversation or commit it. Localhost works
only for clients on this machine. Cloud clients require a separately deployed,
reachable HTTPS endpoint and compatible authentication; this change does not
publish the local server or implement MCP OAuth discovery.

This release is text-only. General chat has no live weather, web search, image,
audio or file tools. Workspace MCP chat keeps its existing read-only tool gate.
No hosted inference, real subscription or secret is supplied by this code.

The protocol regression tests exercise a disposable Ollama-shaped HTTP server,
the actual browser-chat HTTP routes, and an SDK Streamable HTTP Chat MCP client.
Those fixtures validate routing, parsing, usage and access controls; they do
not demonstrate a live model's quality, a provider account's quota, or a working
connection from ChatGPT's cloud to a loopback-only server.

## Free, Pro and Max

Free uses local models and personal connections. Existing `billing.priceId` names
Pro; optional `billing.maxPriceId` names Max. Prices must be distinct. Checkout
accepts a plan name, never a client-supplied price or customer. Existing subscribers
use the Stripe portal to change plans; configure the allowed products there.
The paid tiers expose only configured models, not every model a provider offers.

The existing chat plan `models` and `dailyTokens` fields define Pro. An optional
`max` object has its own `models` and `dailyTokens`, using the same validation.
Its allowance cannot be lower than Pro. If omitted, Max inherits Pro's limits;
configure the difference before offering Max for sale. Both tiers share the same
workspace usage record, so upgrading or downgrading does not reset consumption.
A downgrade is rechecked before inference and refuses stale model access or caps.

## Account linking and company access

Clerk signs a person into Magentic. Matching email addresses alone do not link
provider accounts or authorize a company model server. Current membership remains
an explicit workspace-to-user mapping. Provider OAuth and organization SSO are
not activated by the personal API forms, and are not yet implemented here.

The intended company flow is verified organization membership followed by an
administrator-configured model server and model allowlist. A domain can help
route sign-in; it must not grant model access on its own. Company conversations
must not silently fall back to personal or platform-funded providers.

Provider account linking must use official supported flows and separate inference
consent. The relevant integration references are:

- https://developers.openai.com/siwc/quickstart
- https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan
- https://clerk.com/docs/guides/organizations/add-members/verified-domains

These references describe provider capabilities, not completed Magentic connections.
