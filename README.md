# Jules MCP Server

Model Context Protocol (MCP) server for the Jules REST API.

Built using the high-level `McpServer` API (not deprecated low-level `Server`).

## What this gives you

This MCP server exposes Jules as tools so your MCP client can:

- list/get sources
- create/list/get/delete sessions
- list session activities
- send session messages
- approve plans

## Prerequisites

- Node.js 18+
- A Jules API key from https://jules.google.com/settings#api

## Environment

Set:

- `JULES_API_KEY` (required)
- `JULES_BASE_URL` (optional, defaults to `https://jules.googleapis.com/v1alpha`)

If/when stable `v1` is available for your account, you can override with `JULES_BASE_URL=https://jules.googleapis.com/v1`.

Base URL precedence is:

1. CLI args in MCP client config (`--jules-base-url` or `--base-url`)
2. `JULES_BASE_URL` environment variable
3. default `https://jules.googleapis.com/v1alpha`

You can copy `.env.example` and fill it in.

## Run locally

After installing dependencies:

- `npm run build`
- `npm start`

## Smoke test (recommended)

Run this first to confirm everything is wired correctly:

- `npm run test:smoke`

What it validates:

- MCP stdio startup + initialization
- `tools/list` returns all Jules MCP tools
- live API check via `jules_list_sources` (if `JULES_API_KEY` is set)

If successful, it prints `✅ Smoke test passed`.

## Build output (`dist`)

This project now follows npm-style packaging:

- source entry: `index.js`
- shared server factory: `lib/server.js`
- built runtime entry: `dist/index.js` + `dist/lib/server.js`
- package `bin` points to `dist/index.js`

That means it behaves like a published package layout, even when run from GitHub via `npx`.

## Use with MCP clients via npx (GitHub-hosted, no npm publish)

Use GitHub as the package source directly.

### Option A (recommended): GitHub shorthand

`npx -y github:YOUR_GITHUB_USER/YOUR_REPO_NAME`

### Option B: GitHub tarball URL

`npx -y https://codeload.github.com/YOUR_GITHUB_USER/YOUR_REPO_NAME/tar.gz/refs/heads/main`

> Note: `npx` does not reliably execute a single `raw.githubusercontent.com/.../file.js` URL as a package. Use a GitHub repo (or tarball) so `package.json` + `bin` are available.

## Example MCP client config

```json
{
  "mcpServers": {
    "jules": {
      "command": "npx",
      "args": ["-y", "github:saitrogen/jules-mcp"],
      "env": {
        "JULES_API_KEY": "YOUR_JULES_API_KEY"
      }
    }
  }
}
```

## Production-style base URL override in MCP config

You can override base URL directly in MCP client `args` (without relying on `.env` files):

```json
{
  "mcpServers": {
    "jules": {
      "command": "npx",
      "args": [
        "-y",
        "github:saitrogen/jules-mcp",
        "--jules-base-url=https://jules.googleapis.com/v1alpha"
      ],
      "env": {
        "JULES_API_KEY": "YOUR_JULES_API_KEY"
      }
    }
  }
}
```

---

## Use with Perplexity (Remote MCP Connector)

Perplexity supports custom remote MCP connectors over HTTP. This repo ships a
`http.js` entrypoint (Deno) that exposes the same Jules tools over the
**MCP Streamable HTTP** transport — the standard for remote connectors.

### How it works

```
Perplexity → POST /mcp (Authorization: Bearer <your Jules API key>)
                 ↓
           http.js extracts key from header
                 ↓
           Creates a fresh McpServer scoped to your key (stateless)
                 ↓
           Handles MCP request → calls Jules API → returns result
```

Each request is fully stateless. Jules holds all session state; the server
holds nothing between requests.

### Step 1 — Deploy to Deno Deploy (free)

1. Go to [https://dash.deno.com](https://dash.deno.com) → **New Project** → **Deploy from GitHub**.
2. Select this repo (`saitrogen/jules-mcp`).
3. Set **Entrypoint** to `http.js`.
4. Leave all env vars blank — the Jules API key comes per-request from Perplexity.
5. Deploy. You'll get a URL like `https://jules-mcp-xxxx.deno.dev`.

Verify it's running:
```
curl https://jules-mcp-xxxx.deno.dev/health
# → {"status":"ok","server":"jules-mcp","version":"3.1.0"}
```

### Step 2 — Add the connector in Perplexity

1. Open **Perplexity** → **Settings** → **Connectors** → **Add custom MCP connector**.
2. Fill in:

| Field | Value |
|---|---|
| **URL** | `https://jules-mcp-xxxx.deno.dev/mcp` |
| **Auth type** | Bearer Token |
| **Token** | Your Jules API key (from https://jules.google.com/settings#api) |

3. Save. Perplexity will verify the endpoint and list the Jules tools.

### Step 3 — Use it

In any Perplexity conversation, you can now say things like:

- *"List my Jules sources"*
- *"Create a Jules session to add unit tests to my auth module"*
- *"Check the status of Jules session 12345"*

Perplexity will call the correct Jules tool automatically.

### Security notes

- Your Jules API key is **never stored** on the server — it is read from the
  `Authorization` header on each request and discarded immediately after.
- The Deno Deploy deployment has no persistent storage.
- If you share the deployment URL, anyone with a valid Jules API key can use it —
  there is no additional layer of auth beyond the Jules key itself.
- For a private deployment, add a `CONNECTOR_SECRET` env var check in `http.js`
  (e.g., verify a shared secret before passing through the Jules key).

### Local HTTP testing (Node + Deno)

```bash
# With Deno installed:
JULES_API_KEY=your_key deno run --allow-net --allow-env --allow-read http.js

# Or via npm script:
JULES_API_KEY=your_key npm run start:http

# Test:
curl -X POST http://localhost:8000/mcp \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your_jules_api_key" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

---

## Available tools

### Sources
- `jules_list_sources`: List all GitHub repositories connected to Jules.
- `jules_get_source`: Get full details for one Jules source (repository).

### Sessions
- `jules_create_session`: Create a new Jules AI coding session.
- `jules_quick_session`: One-shot shortcut: pick a template + repo name substring and instantly create a session.
- `jules_clone_session`: Clone an existing session into a new session.
- `jules_list_sessions`: List your Jules sessions with pagination and optional compact mode.
- `jules_list_sessions_by_state`: Filter sessions by one or more states.
- `jules_get_session`: Get full details for a specific Jules session by ID.
- `jules_get_session_state`: Lightweight check of a session's current state.

### Monitoring
- `jules_health_check`: Check Jules API connectivity and health.
- `jules_session_summary`: Get a rich single-call summary of a session (state, activity, output links).
- `jules_wait_for_session`: Poll a session until it reaches COMPLETED or FAILED.

### Outputs
- `jules_get_session_output`: Extract structured outputs (PR URLs, changed files) from a completed session.
- `jules_list_pr_outputs`: Scan recent sessions and return only those that produced pull requests.

### Activities
- `jules_list_activities`: Check what Jules is doing (heartbeat or full timeline).
- `jules_get_activity`: Get a single activity by its full resource name.

### Lifecycle
- `jules_send_message`: Send a follow-up instruction to a Jules session.
- `jules_approve_plan`: Approve the plan Jules has proposed for a session.
- `jules_delete_session`: Delete a Jules session permanently.
- `jules_bulk_delete_sessions`: Delete multiple sessions by ID in parallel.
- `jules_archive_session`: Archive a Jules session.
- `jules_unarchive_session`: Unarchive a previously archived Jules session.

## Session creation UX conventions (important)

To reduce failed calls when creating sessions:

- Use `jules_list_sources` and pass `sources[].canonicalSource` into `jules_create_session.source`.
- `jules_create_session.source` accepts both:
  - `sources/github/org/repo` (recommended)
  - `github/org/repo` (auto-normalized by server)
- Prefer passing `startingBranch` explicitly (`main`, `master`, or repo-specific branch).

If `startingBranch` is omitted, the server now retries with sensible fallbacks (`main`, then `master`) before returning an actionable error.

## Source discovery UX

`jules_list_sources.filter` supports simple substring matching. It checks the source name, ID, owner, and repository name for the provided string (case-insensitive).

## Efficient context controls (new)

For large sessions, use these optional params on:

- `jules_list_sessions`
- `jules_get_session`

Parameters:

- `compact` (boolean): returns a smaller summary payload.
- `includePrompt` (boolean): include or omit `prompt` text.
- `includeOutputs` (boolean): include or omit large `outputs` blocks.
- `includeSourceContext` (boolean): include or omit source context.
- `maxPromptChars` (number): truncate long prompts to a max length.

Example strategy for efficiency:

1. `jules_list_sessions` with `compact: true, includePrompt: false, includeOutputs: false, pageSize: 5`
2. Pick one `sessionId`
3. `jules_get_session` with only fields you need (e.g., `includeOutputs: true` only when reviewing a final patch)

## Agent-Focused Workflows

This version extends Jules MCP with comprehensive agent-management capabilities. Agents can now handle complete development workflows without manual steps.

### New Tools for Agents

**Session Lifecycle Management:**
- `jules_wait_for_session` — Poll until session reaches terminal state.
- `jules_get_session_state` — Quick state check (lightweight).
- `jules_session_summary` — Rich single-call session summary.
- `jules_get_session_output` — Extract PRs and files from completed sessions.

**Error Recovery & Observability:**
- `jules_health_check` - Verify API connectivity before starting

**Templates:**
- `jules_quick_session` - One-shot creation from templates

### Complete Workflow Example

Create, wait, and extract outputs in one agent action:

```javascript
// 1. Health check
const health = await callTool('jules_health_check');

// 2. Create session
const session = await callTool('jules_create_session', {
  source: 'github/saitrogen/my-repo',
  prompt: 'Add unit tests for auth module',
  requirePlanApproval: true,
});

// 3. Approve plan
await callTool('jules_approve_plan', {
  sessionId: session.id,
});

// 4. Wait for completion
const completed = await callTool('jules_wait_for_session', {
  sessionId: session.id,
  timeoutSeconds: 300,
});

// 5. Extract outputs
const outputs = await callTool('jules_get_session_output', {
  sessionId: session.id,
  outputType: 'pullRequest',
});

console.log('PR created:', outputs.pullRequests[0].url);
```

### Best Practices for Agents

**Session Creation**
- Always start with `requirePlanApproval: true` to validate approach
- Use `jules_quick_session` for common tasks like bug fixes or tests
- One task per session (atomicity)

**Polling Strategy**
- Use `timeoutSeconds=300` (5 min) for typical tasks
- Increase to `600` (10 min) for large refactors
- Use `pollIntervalMs=3000` (3 sec) for normal tasks

**Error Handling**
- Call `jules_health_check` before creating sessions
- For transient errors, implement exponential backoff

**Data Extraction**
- Always extract `outputs` before deleting sessions
- Use `jules_get_session_output` to structure PR/file data
- Check `state` field: only extract if `state === 'COMPLETED'`

**Parallelization**
- Create multiple independent sessions in parallel
- Use separate polling loops per session
- Batch cleanup operations

### Troubleshooting

| Error | Cause | Solution |
|-------|-------|----------|
| `Timeout waiting for session` | Task exceeds timeout | Increase `timeoutSeconds` or check session state manually |
| `Rate limited (429)` | API quota hit | Increase `pollIntervalMs` |
| `Unauthorized (401)` | Missing/invalid API key | Verify `JULES_API_KEY` environment variable |
| `Source not found (404)` | Wrong repo format | Use `jules_list_sources` to find canonical source path |

## Version History

### v3.1.0 (Current)
- ✅ Expanded Jules API coverage (22 tools)
- ✅ Logical tool grouping (Sources, Sessions, Monitoring, Outputs, Activities, Lifecycle)
- ✅ One-shot `jules_quick_session` with built-in templates
- ✅ Parallel `jules_bulk_delete_sessions`
- ✅ Session archiving and unarchiving
- ✅ Rich `jules_session_summary`
- ✅ Agent-focused workflows and best practices
- ✅ **Perplexity remote MCP connector** (HTTP/Deno entrypoint)

### v0.3.0
- 10 core Jules API tools
- Compact response modes
- Skill guidance tool

### v0.1.0
- Initial release
