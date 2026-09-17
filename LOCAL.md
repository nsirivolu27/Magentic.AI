# Running it yourself

No server, no container, no account. Two terminals, a relay on one port and
the adapter on another, and either your desktop client or a browser pointed
at it. Everything below is PowerShell.

## What you need

Node 22 and the pinned pnpm. Check with `node --version`, then
`corepack enable` once per machine.

## 1. The relay, on port 3100

The adapter is a client of LNKZ, so LNKZ has to be running. In the LNKZ
checkout, in its own terminal:

```powershell
cd C:\Users\nsiri\OneDrive\Documents\Playground\LNKZ
corepack pnpm install --frozen-lockfile
corepack pnpm build
$env:LNKZ_API_KEY = "local-dev-key"
corepack pnpm start
```

Leave it running. The console is at http://127.0.0.1:3100/console.html. To
put something in it worth searching, in a third terminal: `corepack pnpm seed`.

The key is a real credential even locally, because the adapter refuses to
start without one. `local-dev-key` is fine on a laptop; use something random
the moment anything is reachable from outside it.

## 2. The adapter

```powershell
cd C:\Users\nsiri\OneDrive\Documents\Playground\lnkz-mcp
corepack pnpm install --frozen-lockfile
corepack pnpm build
corepack pnpm agents
```

`pnpm agents` reads `agents/*.json` and prints what this checkout hosts,
without starting anything. It prints the environment variable for each one,
which is what the next step needs. `corepack pnpm agents -- --json` gives the
same thing in the shape the hosted build serves at `/agents`.

## 3a. Use it from Claude Desktop

Each agent is its own entry, because a desktop client picks a server rather
than an endpoint. Open
`%APPDATA%\Claude\claude_desktop_config.json` and add:

```json
{
  "mcpServers": {
    "lnkz": {
      "command": "node",
      "args": ["C:\\Users\\nsiri\\OneDrive\\Documents\\Playground\\lnkz-mcp\\dist\\stdio.mjs"],
      "env": {
        "LNKZ_BASE_URL": "http://127.0.0.1:3100",
        "LNKZ_API_KEY": "local-dev-key",
        "LNKZ_AGENT": "conversation-relay"
      }
    },
    "lnkz-reader": {
      "command": "node",
      "args": ["C:\\Users\\nsiri\\OneDrive\\Documents\\Playground\\lnkz-mcp\\dist\\stdio.mjs"],
      "env": {
        "LNKZ_BASE_URL": "http://127.0.0.1:3100",
        "LNKZ_API_KEY": "local-dev-key",
        "LNKZ_AGENT": "research-reader"
      }
    }
  }
}
```

Restart Claude Desktop. The first entry gives sixteen tools and can write;
the second gives twelve and cannot, so pointing a conversation at it means
nothing it does can change anything.

Drop `LNKZ_AGENT` entirely for all twenty-nine tools, which is what a
configuration written before agents already does.

## 3b. Use it hosted, on your own machine

```powershell
cd C:\Users\nsiri\OneDrive\Documents\Playground\lnkz-mcp
$env:LNKZ_BASE_URL = "http://127.0.0.1:3100"
corepack pnpm start:http
```

Open http://127.0.0.1:8080 for the page listing what is hosted, and
http://127.0.0.1:8080/agents for the same thing as JSON. Each agent's MCP
endpoint is `http://127.0.0.1:8080/mcp/<name>`.

Hosted mode holds no credential on purpose, so every request carries its own:

```powershell
curl.exe http://127.0.0.1:8080/agents
curl.exe -H "Authorization: Bearer local-dev-key" -H "Content-Type: application/json" -d '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2025-06-18\",\"capabilities\":{},\"clientInfo\":{\"name\":\"curl\",\"version\":\"1\"}}}' http://127.0.0.1:8080/mcp/research-reader
```

This is the same binary that would run on a host. Nothing about deployment
changes what it does; it only changes who can reach it.

## Optional: semantic search, staying on your machine

Two more tools, `semantic_search` and `ask_conversations`, appear when a
provider is configured. Ollama keeps the conversation text on your hardware,
which is the configuration this product is for:

```powershell
ollama pull nomic-embed-text
ollama pull llama3.1
cd C:\Users\nsiri\OneDrive\Documents\Playground\lnkz-mcp
corepack pnpm add @langchain/ollama
$env:LNKZ_LLM_PROVIDER = "ollama"
$env:LNKZ_LLM_BASE_URL = "http://127.0.0.1:11434"
corepack pnpm agents
```

`research-reader` goes from twelve tools to fourteen. Without this, it loads
without them and says so, rather than refusing to start. `LANGCHAIN.md`
explains the cost ceilings and why this lives in the adapter.

## Making your own agent

Copy any file in `agents/`, change the name, cut the tool list to what that
job needs, and rerun `corepack pnpm agents`. A tool name that does not exist
fails immediately and says which file. `CATALOG.md` has the record format.

## When something does not start

- `LNKZ_BASE_URL is required` means the adapter has nowhere to talk to. Set
  it in the same terminal, or in the `env` block of the desktop config.
- `No agent named "x". Available: ...` is the spelling, and the message
  lists what it would have accepted.
- A tool call failing with a relay error means the adapter is fine and the
  relay is not running, or the key does not match. Check
  http://127.0.0.1:3100/ready.
- A desktop client that shows no tools at all is usually a path problem in
  `args`. It must be the absolute path to `dist\stdio.mjs`, with doubled
  backslashes, and `corepack pnpm build` must have been run.
