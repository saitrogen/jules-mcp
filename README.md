# Jules MCP Server

Model Context Protocol (MCP) server for the Jules REST API.

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

- `npm start`

## Smoke test (recommended)

Run this first to confirm everything is wired correctly:

- `npm run test:smoke`

What it validates:

- MCP stdio startup + initialization
- `tools/list` returns all Jules MCP tools
- live API check via `jules_list_sources` (if `JULES_API_KEY` is set)

If successful, it prints `✅ Smoke test passed`.

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
      "args": ["-y", "github:YOUR_GITHUB_USER/YOUR_REPO_NAME"],
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
