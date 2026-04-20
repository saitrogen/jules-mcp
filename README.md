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
