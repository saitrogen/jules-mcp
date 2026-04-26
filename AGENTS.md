# AGENTS.md — Jules MCP Project Brain

> **For AI assistants:** Read this file first before doing anything in this repo.
> It is the single source of truth for project state, decisions, and what to do next.
> Update the CHANGELOG and TODO sections at the end of every session.

---

## What This Project Is

`jules-mcp` is a **Deno Deploy MCP (Model Context Protocol) server** that exposes Jules (Google's AI coding agent) as a set of tools consumable by AI assistants like Perplexity/GAIA AI via the MCP Streamable HTTP protocol.

It acts as a bridge: **Perplexity ↔ jules-mcp (Deno Deploy) ↔ Jules API (Google)**

The end goal is a fully-featured Jules orchestration layer usable from inside an AI chat interface — treating Jules as a background coding engine that can be dispatched, monitored, and managed without leaving the conversation.

---

## Architecture

```
Perplexity (MCP client)
    │
    │  HTTP POST /mcp  (MCP Streamable HTTP protocol)
    ▼
Deno Deploy — http.js  (MCP server entry point)
    │
    ├── Parses MCP tool calls
    ├── Routes to handler functions in index.js / lib/
    │
    ▼
Jules REST API  (https://jules.google.com/api/v1/...)
    │
    └── Sessions, Sources, Activities, Plans
```

### Key Files

| File | Role |
|---|---|
| `http.js` | Deno Deploy entry point. Handles MCP Streamable HTTP, CORS, session headers (`Mcp-Session-Id`), SSE streaming |
| `index.js` | Tool registry — maps MCP tool names → handler functions |
| `perplexity.js` | All 25 tool implementations (the main logic file) |
| `lib/` | Shared utilities (API client, error helpers, etc.) |
| `deno.json` | Deno config + import map |
| `package.json` | Node-side metadata (used for scripts, not runtime) |
| `.env.example` | Documents all required environment variables |
| `scripts/smoke-test.js` | Node.js smoke test — run with `npm run smoke <BASE_URL> <API_KEY>` |

### Environment Variables

| Var | Required | Description |
|---|---|---|
| `JULES_API_KEY` | ✅ | Jules API key — passed as Bearer token |
| `ALLOWED_ORIGIN` | Optional | Restricts CORS. Defaults to `*` (dev only). Set to `https://www.perplexity.ai` in prod |

---

## Current Tool Inventory (v3.0.0 — 25 tools)

### Infrastructure
- `jules_health_check` — server version + API reachability + timestamp
- `jules_describe_error` — translates API error codes into human-readable recovery hints

### Sources (Repositories)
- `jules_list_sources` — paginated list of all GitHub repos connected to Jules; supports `filter`, `pageSize`, `pageToken`
- `jules_get_source` — full detail for one source by ID (`github/owner/repo` or `sources/github/owner/repo`)

### Sessions — Creation
- `jules_create_session` — full control: `prompt`, `source`, `startingBranch`, `title`, `requirePlanApproval`
- `jules_quick_session` — one-shot: `template` + `sourceFilter` → session instantly; best for common tasks
- `jules_build_session_prompt` — preview/customize a template without creating a session
- `jules_clone_session` — copy a session's prompt + source + branch into a new session (great for retries)

### Sessions — Listing & Filtering
- `jules_list_sessions` — paginated; supports `compact`, `includePrompt`, `includeOutputs`, `includeSourceContext`, `maxPromptChars`
- `jules_list_sessions_by_state` — filter by one or more states (`QUEUED`, `PLANNING`, `AWAITING_PLAN_APPROVAL`, `IN_PROGRESS`, `PAUSED`, `COMPLETED`, `FAILED`)
- `jules_list_pr_outputs` — scan sessions and return only those that produced pull requests; supports `sourceFilter`

### Sessions — Detail
- `jules_get_session` — full session object with same compact controls as list
- `jules_get_session_state` — lightweight: id + title + state + timestamps only
- `jules_session_summary` — rich single call: state + activityCount + latestActivity + output links

### Sessions — Waiting & Automation
- `jules_wait_for_session` — polls until COMPLETED or FAILED; `pollIntervalMs`, `timeoutSeconds`

### Sessions — Interaction
- `jules_send_message` — send a follow-up instruction to an active session
- `jules_approve_plan` — approve plan in `AWAITING_PLAN_APPROVAL` state → Jules starts coding
- `jules_rename_session` — update session title

### Sessions — Deletion
- `jules_delete_session` — delete one session permanently
- `jules_bulk_delete_sessions` — delete many in parallel; returns per-ID success/error report

### Activities
- `jules_list_activities` — all activity events for a session (step-by-step log)
- `jules_list_activities_filtered` — filter by activity type (e.g. `ACTIVITY_COMPLETED`)
- `jules_get_latest_activity` — just the single most recent activity

### Built-in Templates (used by `jules_quick_session` and `jules_build_session_prompt`)
`add_tests`, `fix_bug`, `refactor`, `review`, `add_docs`, `add_types`, `security_audit`, `add_ci`, `upgrade_deps`, `add_readme`

---

## Changelog

### v3.0.0 — 2026-04-26
**Major expansion: 12 → 25 tools**
- Added `jules_quick_session` (template-based one-shot creation)
- Added `jules_build_session_prompt` (template preview without session creation)
- Added `jules_clone_session` (retry failed sessions)
- Added `jules_session_summary` (rich single-call status)
- Added `jules_list_sessions_by_state` (state-based filtering)
- Added `jules_wait_for_session` (automated polling until done)
- Added `jules_list_activities_filtered` (filter by activity type)
- Added `jules_get_latest_activity` (last Jules action only)
- Added `jules_describe_error` (human-readable error recovery)
- Added `jules_bulk_delete_sessions` (parallel multi-delete)
- Added `jules_list_pr_outputs` (PR dashboard from sessions)
- Added `jules_rename_session` (session title update)
- Upgraded `jules_list_sessions` — compact mode, selective field inclusion, prompt truncation
- Upgraded `jules_get_session` — same compact controls
- Upgraded `jules_list_sources` — proper filter param, canonical source output, total count
- Upgraded `jules_health_check` — returns server name + version
- All tools — better error messages with recovery hints
- Added 10 built-in session templates

### v2.x — 2026-04-26 (earlier in day)
- Added `Mcp-Session-Id` header support (Task 1)
- Added `ALLOWED_ORIGIN` env var for CORS lockdown (Task 2)
- Added `scripts/smoke-test.js` Node.js smoke test (Task 3)
- Refactored array filtering/mapping inefficiencies

### v1.0.0 — Initial
- Basic MCP server on Deno Deploy
- 12 tools covering core session CRUD and source listing
- Jules API integration working end-to-end

---

## Known Issues / Bugs

- `jules_list_pr_outputs` correctly returns 0 PRs for the `jules-mcp` repo because Jules pushes commits to branches, not PRs. This is expected behavior — PRs only show for repos where Jules was instructed to open one.
- `jules_session_summary` `latestActivity` sometimes returns the plan-generation step rather than the final completion message. Investigate whether we need to fetch the last activity separately for truly terminal sessions.

---

## TODO / Roadmap

### 🔴 High Priority (Next Session)
- [ ] **`jules_get_session_output` fix** — currently returns `fileCount: 0` even for sessions that changed files. Investigate the Jules API `outputs` field structure and fix extraction logic.
- [ ] **PR creation support** — add `createPullRequest: true` param to `jules_create_session` so Jules opens a PR after completing work instead of just committing to a branch.
- [ ] **Session tagging / notes** — Jules API may support metadata. Explore if we can attach tags like `project:jules-mcp` to sessions for better filtering.

### 🟡 Medium Priority
- [ ] **`jules_wait_for_session` + auto-summary** — after waiting completes, automatically call `jules_session_summary` and return it instead of the raw session object.
- [ ] **`jules_list_sessions` source filter** — add `sourceFilter` param so you can list sessions for a specific repo only (currently lists all).
- [ ] **Pagination cursor passthrough** — `jules_list_sources` returns `nextPageToken` but the AI needs to be reminded to paginate. Add a `hint` field in the response nudging further pages.
- [ ] **`jules_describe_error` expansion** — currently only covers basic HTTP status codes. Map Jules-specific error codes (`INVALID_ARGUMENT`, `NOT_FOUND`, `PERMISSION_DENIED`) to richer suggestions.

### 🟢 Nice to Have
- [ ] **`jules_session_diff`** — fetch and return the git diff of changes Jules made in a session.
- [ ] **`jules_cancel_session`** — if Jules API supports cancelling in-progress sessions, expose it.
- [ ] **Webhook support** — instead of polling with `jules_wait_for_session`, register a webhook URL so Deno Deploy can push a notification when a session completes.
- [ ] **Multi-session orchestration** — `jules_run_parallel` that fires multiple sessions simultaneously and waits for all to complete (batch task runner).

### ✅ Done (don't re-do)
- [x] MCP Streamable HTTP protocol compliance
- [x] CORS lockdown via `ALLOWED_ORIGIN` env var
- [x] `Mcp-Session-Id` header support
- [x] 10 built-in session templates
- [x] Compact mode for list/get operations
- [x] Smoke test script
- [x] Error description tool
- [x] Bulk delete
- [x] State-based session filtering
- [x] PR output scanning

---

## Design Decisions & Rationale

| Decision | Reason |
|---|---|
| Deno Deploy over Node/Vercel | Zero cold starts, edge deployment, native `fetch`, no npm install step |
| Single `http.js` entry point | Deno Deploy requires one entry file; all routing happens inside |
| `perplexity.js` as main logic file | Keeps tool implementations co-located and easy to grep |
| `compact` mode on list/get | Jules sessions can have very large prompt/output payloads; compact prevents token overflow in the AI |
| Templates baked into server | Avoids round-trips; AI can preview + customize without a Jules API call |
| `jules_describe_error` as a tool | LLMs handle structured error objects poorly; this translates them to natural language recovery steps |
| `ALLOWED_ORIGIN=*` default | Dev convenience; production deployment MUST set this to `https://www.perplexity.ai` |

---

## How to Resume Development in a New Chat

1. **Tell the AI:** *"Read AGENTS.md in saitrogen/jules-mcp and continue development"*
2. AI reads this file — instantly knows the full project state
3. Jump straight to the TODO section and pick a task
4. AI uses HEPHAESTUS (coding engine) + GitHub MCP + Jules MCP tools to implement
5. At end of session, AI updates CHANGELOG and TODO in this file

---

## Deployment

- **Platform:** Deno Deploy
- **Auto-deploy:** Yes — pushing to `main` triggers a new deployment automatically
- **Entry point:** `http.js`
- **MCP endpoint:** `https://<your-deno-deploy-url>/mcp`
- **Test:** `npm run smoke <BASE_URL> <JULES_API_KEY>`
