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
- built runtime entry: `dist/index.js`
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

## Available tools

- `jules_list_sources`
- `jules_get_source`
- `jules_create_session`
- `jules_list_sessions`
- `jules_get_session`
- `jules_delete_session`
- `jules_list_activities`
- `jules_send_message`
- `jules_approve_plan`
- `jules_get_skill`

## Session creation UX conventions (important)

To reduce failed calls when creating sessions:

- Use `jules_list_sources` and pass `sources[].canonicalSource` into `jules_create_session.source`.
- `jules_create_session.source` accepts both:
  - `sources/github/org/repo` (recommended)
  - `github/org/repo` (auto-normalized by server)
- Prefer passing `startingBranch` explicitly (`main`, `master`, or repo-specific branch).

If `startingBranch` is omitted, the server now retries with sensible fallbacks (`main`, then `master`) before returning an actionable error.

## Source discovery UX

`jules_list_sources.filter` supports two modes:

- **AIP expression** (server-side): e.g. `name=sources/github/myorg/myrepo`
- **Simple substring** (local fallback): e.g. `jules-mcp`

If server-side filtering is rejected as `INVALID_ARGUMENT`, the server automatically falls back to local substring matching and returns a warning plus matched sources.

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

## Skill tool for new agents

Use `jules_get_skill` to get tool + parameter guidance directly from the server.

Parameters:

- `toolName` (optional): return only one tool's details.
- `compact` (optional): return purpose + required params only.
- `includeExamples` (optional): include or omit example values.

Common calls:

- `{ "compact": true }`
- `{ "toolName": "jules_create_session" }`
- `{ "toolName": "jules_list_sessions", "includeExamples": false }`

## Agent-Focused Workflows (v0.3.0+)

This version extends Jules MCP with comprehensive agent-management capabilities. Agents can now handle complete development workflows without manual steps.

### New Tools for Agents

**Session Lifecycle Management:**
- `jules_wait_for_session` - Poll until session reaches terminal state
- `jules_get_session_state` - Quick state check (lightweight)
- `jules_list_activities_filtered` - Activities with type filtering
- `jules_get_session_output` - Extract PRs and files from completed sessions

**Error Recovery & Observability:**
- `jules_health_check` - Verify API connectivity before starting
- `jules_describe_error` - Parse API errors into actionable guidance

**Templates:**
- `jules_build_session_prompt` - Pre-configured prompts for common tasks

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
- Use `jules_build_session_prompt` for consistent templates
- One task per session (atomicity)

**Polling Strategy**
- Use `timeoutSeconds=300` (5 min) for typical tasks
- Increase to `600` (10 min) for large refactors
- Use `pollIntervalMs=2000` (2 sec) for normal tasks, `5000` for quieter polling

**Error Handling**
- Call `jules_health_check` before creating sessions
- Use `jules_describe_error` to parse failures
- For `retryable: true` errors, implement exponential backoff
- For `retryable: false` errors, fix input and retry

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
| `Invalid session ID format` | Bad session reference | Use `jules_list_sessions` to get valid IDs |
| `Rate limited (429)` | API quota hit | Increase `pollIntervalMs` to 5-10 seconds |
| `Unauthorized (401)` | Missing/invalid API key | Verify `JULES_API_KEY` environment variable |
| `Source not found (404)` | Wrong repo format | Use `jules_list_sources` to find canonical source path |

## Version History

### v0.3.0 (Current)
- ✅ Complete Jules API coverage (16 tools)
- ✅ Session polling and state management
- ✅ Activity filtering
- ✅ Error description and recovery helpers
- ✅ Session templates for common flows
- ✅ Agent-focused workflows and best practices

### v0.2.0
- 10 core Jules API tools
- Compact response modes
- Skill guidance tool

### v0.1.0
- Initial release
