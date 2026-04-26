# Perplexity Connector Integration — Lessons Learned

> **Audience:** Developer picking up this project.
> **Scope:** Everything we discovered while making `jules-mcp` work as a remote Perplexity MCP connector, from first attempt to working implementation. Covers what we tried, what failed, why it failed, and what the final architecture looks like.

---

## 1. Goal

Make `jules-mcp` (originally a stdio-only MCP server) usable as a **Perplexity remote MCP connector**.

Perplexity's connector system expects a publicly accessible HTTP endpoint that speaks the **MCP Streamable HTTP transport** (also called the "2025-03-26" MCP spec). It is _not_ SSE-over-GET like the older MCP spec — it is a single `POST /mcp` endpoint that handles all messages.

---

## 2. Original Architecture

Before this work, the repo had:

| File | Role |
|---|---|
| `index.js` | stdio entrypoint — reads from stdin, writes to stdout |
| `lib/server.js` | `createServer()` factory — builds and returns the `McpServer` instance |
| `http.js` | First attempt at HTTP — used `SSEServerTransport` (old spec) |

The stdio mode worked correctly with Claude Desktop and any local MCP client. The `http.js` file was the beginning of the remote connector work.

---

## 3. What We Tried and What Failed

### Attempt 1 — SSE Transport (`http.js`, original)

**What it did:** Used `@modelcontextprotocol/sdk`'s `SSEServerTransport`. Exposed `GET /sse` for the stream and `POST /messages` for incoming requests.

**Error:** Perplexity received `Unexpected content type` or connection timeout.

**Root cause:** Perplexity's connector does **not** use the old SSE-split transport. It sends a single `POST` with `Content-Type: application/json` and expects the response body to be a JSON-RPC response (or a stream of SSE events from that same POST connection). The `GET /sse` pattern is the _old_ MCP spec (pre-2025-03-26).

---

### Attempt 2 — Deno Deploy + `perplexity.js` with `StreamableHTTPServerTransport`

**What it did:** Created `perplexity.js`, a new entrypoint using `StreamableHTTPServerTransport` from the SDK. Deployed to Deno Deploy.

**Error:** Same `Unexpected content type` error.

**Root cause (assumed):** Deno Deploy's dashboard entrypoint was still pointing to the old `http.js`. The new file was deployed but never served.

**Lesson:** Deno Deploy does **not** auto-detect entrypoint from file name. You must explicitly set it in the project dashboard under **Settings → Entrypoint**.

---

### Attempt 3 — Entrypoint Updated, Still Failing

**What it did:** Updated Deno Deploy to serve `perplexity.js`.

**Error:** Same error.

**Root cause:** `perplexity.js` was returning `application/json` on the root `GET /` health check route but the Perplexity connector probe was hitting `POST /mcp` and getting a valid JSON-RPC `initialize` response — but _without_ the `Mcp-Session-Id` response header.

**Lesson:** The MCP Streamable HTTP spec (2025-03-26) requires the server to:
1. Generate a session UUID on `initialize`
2. Return it as `Mcp-Session-Id: <uuid>` in the response headers
3. Validate it on all subsequent requests

Without this header, Perplexity treats the connection as stateless/broken and retries or rejects.

---

### Attempt 4 — Session ID Header Added (Current State)

**Status:** Server responds correctly to all manual `curl` tests. Perplexity connector test pending re-validation.

**Implementation in `perplexity.js`:**

```js
// On initialize:
const sessionId = crypto.randomUUID();
activeSessions.set(sessionId, { createdAt: Date.now() });
res.setHeader('Mcp-Session-Id', sessionId);

// On subsequent requests:
const sessionId = req.headers['mcp-session-id'];
if (!sessionId || !activeSessions.has(sessionId)) {
  res.status(404).json({ error: 'Session not found or expired' });
  return;
}
```

---

## 4. Key Technical Facts

### MCP Transport Versions

| Transport | Spec Date | Pattern | Status |
|---|---|---|---|
| stdio | any | stdin/stdout | Works — used for local clients |
| SSE (old) | pre-2025-03-26 | `GET /sse` + `POST /messages` | **Not compatible with Perplexity** |
| Streamable HTTP | 2025-03-26 | `POST /mcp` only | **Required by Perplexity** |

### Streamable HTTP Contract

- `POST /mcp` — all MCP messages (initialize, tool calls, etc.)
- Request: `Content-Type: application/json`
- Response on `initialize`: must include `Mcp-Session-Id: <uuid>` header
- Subsequent requests: must include `Mcp-Session-Id: <uuid>` header
- Response: either a single JSON object or `text/event-stream` SSE (for streaming responses)
- Auth: `Authorization: Bearer <JULES_API_KEY>` or `x-api-key` header

### Deno Deploy Notes

- Entrypoint is set in the **project dashboard**, not in `deno.json` (for GitHub-connected projects).
- `deno.json` is only used when you run `deno deploy` from the CLI.
- The dashboard UI shows the current entrypoint under **Settings → Entrypoint**.
- Deploys are triggered on every push to the connected branch — but they serve the **previously configured entrypoint** until you change it in the dashboard.

### Auth Flow

Perplexity injects secrets as environment variables or passes them as `Authorization: Bearer <token>` headers. The `perplexity.js` server reads the Jules API key from:
1. `Authorization: Bearer <key>` header (per-request, Perplexity injects this)
2. `JULES_API_KEY` environment variable (fallback, set in Deno Deploy dashboard)

---

## 5. Final File Map

```
jules-mcp/
├── index.js              # stdio entrypoint (unchanged)
├── http.js               # old SSE HTTP server (kept for reference, not used by Perplexity)
├── perplexity.js         # ← Perplexity-compatible Streamable HTTP server
├── lib/
│   └── server.js         # McpServer factory — shared by all transports
├── deno.json             # Deno config (import maps, tasks)
└── docs/
    ├── jules-api.md      # Jules REST API reference
    └── perplexity-connector-lessons.md  # ← this file
```

---

## 6. How to Deploy

### Deno Deploy (current)

1. Push to `main` branch — auto-deploys
2. In Deno Deploy dashboard → **Settings → Entrypoint** → set to `perplexity.js`
3. In Deno Deploy dashboard → **Environment Variables** → add `JULES_API_KEY`
4. Your connector URL is `https://<project>.deno.dev`

### Testing Locally

```bash
# Run the Perplexity-compatible server locally
JULES_API_KEY=your_key deno run --allow-net --allow-env perplexity.js

# Test with curl
curl -X POST http://localhost:8000/mcp \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer your_key' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}'
```

### Connecting to Perplexity

1. Go to Perplexity → **Settings → MCP Connectors → Add Connector**
2. Type: **Remote**
3. URL: `https://<your-project>.deno.dev/mcp`
4. Auth: Bearer token → paste your `JULES_API_KEY`
5. Save and test

---

## 7. Current Server Tools (v0.4.0)

The server registers **23 tools** covering the full Jules API surface:

### Core Session Management
| Tool | Purpose |
|---|---|
| `jules_create_session` | Create a new coding session |
| `jules_list_sessions` | List sessions (compact controls) |
| `jules_get_session` | Get one session's details |
| `jules_delete_session` | Delete a session |
| `jules_get_session_state` | Quick state check (no full payload) |
| `jules_wait_for_session` | Poll until COMPLETED or FAILED |

### Activities & Communication
| Tool | Purpose |
|---|---|
| `jules_list_activities` | List all activities for a session |
| `jules_list_activities_filtered` | List activities filtered by type |
| `jules_get_latest_activity` | Get only the most recent activity |
| `jules_send_message` | Send follow-up message to Jules |
| `jules_approve_plan` | Approve a pending plan |

### Sources
| Tool | Purpose |
|---|---|
| `jules_list_sources` | List connected repos |
| `jules_get_source` | Get one source by ID |

### Power / Convenience Tools (new in v0.4.0)
| Tool | Purpose |
|---|---|
| `jules_quick_session` | One-shot: template + source filter → new session |
| `jules_clone_session` | Copy a session's prompt/source into a new session |
| `jules_session_summary` | State + activity count + latest message in one call |
| `jules_list_sessions_by_state` | Filter sessions by state client-side |
| `jules_bulk_delete_sessions` | Delete multiple sessions in parallel |
| `jules_list_pr_outputs` | Find all sessions that produced PRs |
| `jules_rename_session` | Best-effort title update via message |
| `jules_get_session_output` | Extract PRs/files from completed session |

### Meta / Developer Tools
| Tool | Purpose |
|---|---|
| `jules_build_session_prompt` | Build prompt from template |
| `jules_health_check` | API connectivity check |
| `jules_describe_error` | Human-readable error guidance |
| `jules_get_skill` | Tool reference for agents |

---

## 8. Known Limitations

- **No native session rename:** The Jules API has no `PATCH /sessions/{id}` endpoint. `jules_rename_session` sends an informational message to the session instead.
- **No server-side state filtering:** `jules_list_sessions_by_state` scans pages client-side. For large session counts, it may be slow.
- **`automationMode` undocumented values:** Only `AUTO_CREATE_PR` is confirmed. Other values are untested.
- **Session states are polling-only:** There is no webhook/push mechanism. `jules_wait_for_session` polls on a configurable interval.
- **Jules API is v1alpha:** Specs may change. Watch for breaking changes, especially around `sourceContext` field structure.

---

## 9. Checklist for Next Developer

- [ ] Validate Perplexity connector connection after any `perplexity.js` change
- [ ] Check `Mcp-Session-Id` header is present in `initialize` response (inspect with `curl -v`)
- [ ] Confirm Deno Deploy entrypoint is still set to `perplexity.js` after dashboard changes
- [ ] Update `TOOL_REFERENCE` in `lib/server.js` whenever a new tool is added
- [ ] Bump version string in `McpServer({ version })` and `jules_health_check` response when releasing
- [ ] Run `jules_health_check` through Perplexity after deploy to verify end-to-end auth flow
