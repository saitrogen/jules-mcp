/**
 * perplexity.js — Jules MCP Server for Perplexity  v3.0.0
 *
 * TRANSPORT: Legacy SSE (confirmed working with Perplexity)
 *   GET  /sse       → opens SSE stream, sends endpoint event
 *   POST /messages  → client posts JSON-RPC; response pushed via SSE
 *
 * SECONDARY: Streamable HTTP (fallback / future)
 *   POST /mcp
 *
 * Perplexity connector config:
 *   URL:  https://jules-mcp.saitrogen.deno.net/sse
 *   Auth: API Key → Header: Authorization, Value: Bearer <your-jules-api-key>
 *
 * Jules API key is forwarded to Google Jules API per request.
 */

const SERVER_NAME    = "jules-mcp";
const SERVER_VERSION = "3.0.0";
const PROTO_V        = "2025-03-26";
const JULES_BASE     = "https://jules.googleapis.com/v1alpha";

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------
const CORS = {
  "Access-Control-Allow-Origin":   "*",
  "Access-Control-Allow-Methods":  "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":  "Content-Type, Authorization, Accept, Mcp-Session-Id, Last-Event-Id, X-Api-Key",
  "Access-Control-Expose-Headers": "Mcp-Session-Id",
};

// ---------------------------------------------------------------------------
// SSE client store  { clientId → { controller, apiKey } }
// ---------------------------------------------------------------------------
const sseClients = new Map();

function pushSSE(clientId, data) {
  const client = sseClients.get(clientId);
  if (!client) return;
  try {
    client.controller.enqueue(
      new TextEncoder().encode(`event: message\ndata: ${JSON.stringify(data)}\n\n`)
    );
  } catch {
    sseClients.delete(clientId);
  }
}

// ---------------------------------------------------------------------------
// Streamable HTTP session store
// ---------------------------------------------------------------------------
const sessions = new Map();

// ---------------------------------------------------------------------------
// Jules API client
// ---------------------------------------------------------------------------
async function julesRequest(apiKey, { method = "GET", path, query, body }) {
  const url = new URL(path.replace(/^\//, ""), JULES_BASE.replace(/\/$/, "") + "/");
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }
  }
  const headers = { "x-goog-api-key": apiKey };
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(url.toString(), {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed;
  try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text }; }
  if (!res.ok) {
    const msg = parsed?.error?.message || parsed?.message || text || `HTTP ${res.status}`;
    const err = new Error(`Jules API error (${res.status}): ${msg}`);
    err.httpStatus = res.status;
    err.apiStatus  = parsed?.error?.status;
    throw err;
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Static data
// ---------------------------------------------------------------------------
const SESSION_STATES = ["QUEUED","PLANNING","AWAITING_PLAN_APPROVAL","AWAITING_USER_FEEDBACK","IN_PROGRESS","PAUSED","COMPLETED","FAILED"];
const TERMINAL_STATES = ["COMPLETED","FAILED"];

const SESSION_TEMPLATES = {
  add_tests:      { title: "Add tests",             prompt: "Add comprehensive unit tests for the existing code. Include tests for happy path and edge cases." },
  fix_bug:        { title: "Fix bug",               prompt: "Identify and fix the bug described. Include a test that verifies the fix. Minimal changes only." },
  refactor:       { title: "Refactor for clarity",  prompt: "Refactor the code for better readability and maintainability. Keep functionality unchanged." },
  review:         { title: "Code review",           prompt: "Review the code for best practices, performance issues, and security concerns. Suggest improvements." },
  add_docs:       { title: "Add documentation",     prompt: "Add clear documentation, comments, and docstrings to the code. Focus on intent and usage." },
  add_types:      { title: "Add TypeScript types",  prompt: "Add TypeScript type annotations. Ensure all functions, parameters, and return values are typed. Do not change runtime logic." },
  security_audit: { title: "Security audit",        prompt: "Audit the codebase for security vulnerabilities: injection risks, exposed secrets, insecure dependencies, improper auth, and unsafe defaults. List issues with severity ratings." },
  add_ci:         { title: "Add CI workflow",       prompt: "Add a GitHub Actions CI workflow that runs tests and linting on every push and pull request to main." },
  upgrade_deps:   { title: "Upgrade dependencies",  prompt: "Identify outdated dependencies and upgrade them to their latest stable versions. Run tests to confirm nothing broke." },
  add_readme:     { title: "Write README",          prompt: "Write a comprehensive README.md covering: project purpose, installation, usage examples, configuration, and contributing guide." },
};

const ERROR_CATALOG = {
  400: { suggestion: "Check required fields and formats. Verify source/sessionId format.", retryable: false },
  401: { suggestion: "Verify JULES_API_KEY is set correctly.",                             retryable: false },
  403: { suggestion: "Check if your account has access to this source or session.",        retryable: false },
  404: { suggestion: "Verify the session/source ID exists and use canonical format.",      retryable: false },
  429: { suggestion: "Rate limited — wait before retrying.",                               retryable: true  },
  500: { suggestion: "Jules service may be temporarily unavailable. Retry soon.",          retryable: true  },
  503: { suggestion: "Jules service is temporarily down. Retry in a few moments.",         retryable: true  },
};

// ---------------------------------------------------------------------------
// Tool definitions (inputSchema as JSON Schema)
// ---------------------------------------------------------------------------
const TOOLS = [
  // ─── UTILITY ─────────────────────────────────────────────────────────────
  {
    name: "jules_health_check",
    description: "Check Jules API connectivity and health. Returns server version, reachability, and current timestamp.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "jules_describe_error",
    description: "Parse a Jules API error and return a human-readable explanation with recovery suggestions.",
    inputSchema: {
      type: "object",
      properties: {
        httpStatus: { type: "integer", description: "HTTP status code from the failed request (e.g. 400, 404, 429)" },
        apiStatus:  { type: "string",  description: "API error status string (e.g. INVALID_ARGUMENT, NOT_FOUND)" },
        message:    { type: "string",  description: "Original error message text" },
      },
      required: [],
    },
  },

  // ─── SOURCES ─────────────────────────────────────────────────────────────
  {
    name: "jules_list_sources",
    description: "List all GitHub repositories connected to Jules. Supports pagination and substring filtering by owner, repo name, or full path.",
    inputSchema: {
      type: "object",
      properties: {
        pageSize:  { type: "integer", minimum: 1, maximum: 100, description: "Number of results per page (default: 20)" },
        pageToken: { type: "string",  description: "Pagination token from a previous response" },
        filter:    { type: "string",  description: "Substring to filter by owner or repo name (e.g. 'myorg/myrepo' or just 'myrepo')" },
      },
      required: [],
    },
  },
  {
    name: "jules_get_source",
    description: "Get full details for one Jules source (repository). Accepts github/owner/repo or sources/github/owner/repo format.",
    inputSchema: {
      type: "object",
      properties: {
        sourceId: { type: "string", description: "Source identifier, e.g. github/myorg/myrepo or sources/github/myorg/myrepo" },
      },
      required: ["sourceId"],
    },
  },

  // ─── SESSION CREATION ────────────────────────────────────────────────────
  {
    name: "jules_create_session",
    description: "Create a new Jules AI coding session. Jules will plan and implement the task on the specified repository branch.",
    inputSchema: {
      type: "object",
      properties: {
        prompt:              { type: "string",  description: "Detailed task instruction for Jules (be specific about what to build/fix/test)" },
        source:              { type: "string",  description: "Repository source, e.g. sources/github/myorg/myrepo" },
        startingBranch:      { type: "string",  description: "Branch to start from (e.g. main). Auto-detected if omitted." },
        title:               { type: "string",  description: "Optional human-readable session title" },
        requirePlanApproval: { type: "boolean", description: "If true, Jules pauses for your approval before writing code (default: false)" },
      },
      required: ["prompt", "source"],
    },
  },
  {
    name: "jules_quick_session",
    description: "One-shot shortcut: pick a template + repo name substring and instantly create a session. Ideal for common recurring tasks.",
    inputSchema: {
      type: "object",
      properties: {
        template:            { type: "string", enum: Object.keys(SESSION_TEMPLATES), description: "Preset task template name" },
        sourceFilter:        { type: "string", description: "Substring to identify the repo (e.g. 'myorg/myrepo'). Must match exactly one source." },
        startingBranch:      { type: "string", description: "Branch to start from (optional)" },
        customPrompt:        { type: "string", description: "Override the template prompt with custom instructions" },
        requirePlanApproval: { type: "boolean", description: "Require plan approval before coding starts (default: false)" },
      },
      required: ["template", "sourceFilter"],
    },
  },
  {
    name: "jules_build_session_prompt",
    description: "Preview or customise a built-in session template without creating a session. Returns title + prompt ready for jules_create_session.",
    inputSchema: {
      type: "object",
      properties: {
        template:            { type: "string", enum: Object.keys(SESSION_TEMPLATES), description: "Template to build from" },
        customTitle:         { type: "string", description: "Override the default template title" },
        customPrompt:        { type: "string", description: "Override the default template prompt" },
        requirePlanApproval: { type: "boolean", description: "Whether to recommend plan approval (default: true)" },
      },
      required: ["template"],
    },
  },
  {
    name: "jules_clone_session",
    description: "Clone an existing session: copies its prompt, source, and branch into a new session. Useful for retrying failed sessions.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId:           { type: "string",  description: "ID of the session to clone" },
        newTitle:            { type: "string",  description: "Title for the new cloned session" },
        newPrompt:           { type: "string",  description: "Override the original prompt (optional)" },
        requirePlanApproval: { type: "boolean", description: "Require plan approval on the new session (default: false)" },
      },
      required: ["sessionId"],
    },
  },

  // ─── SESSION READ ─────────────────────────────────────────────────────────
  {
    name: "jules_list_sessions",
    description: "List your Jules sessions with pagination and optional compact mode to reduce response size.",
    inputSchema: {
      type: "object",
      properties: {
        pageSize:             { type: "integer", minimum: 1, maximum: 100, description: "Results per page (default: 20)" },
        pageToken:            { type: "string",  description: "Pagination token from a previous response" },
        compact:              { type: "boolean", description: "Return only id, title, state, timestamps (default: false)" },
        includePrompt:        { type: "boolean", description: "Include prompt text (default: true unless compact=true)" },
        includeOutputs:       { type: "boolean", description: "Include output payloads — can be large (default: true unless compact=true)" },
        includeSourceContext: { type: "boolean", description: "Include sourceContext object (default: true unless compact=true)" },
        maxPromptChars:       { type: "integer", minimum: 1, maximum: 20000, description: "Truncate prompt to this many characters" },
      },
      required: [],
    },
  },
  {
    name: "jules_list_sessions_by_state",
    description: "Filter sessions by one or more states. Great for finding all failed sessions, all awaiting approval, or all active sessions.",
    inputSchema: {
      type: "object",
      properties: {
        states:     { type: "array", items: { type: "string", enum: SESSION_STATES }, description: "States to include, e.g. [\"FAILED\",\"AWAITING_PLAN_APPROVAL\"]" },
        maxResults: { type: "integer", minimum: 1, maximum: 200, description: "Stop after collecting this many matching sessions (default: 20)" },
        pageSize:   { type: "integer", minimum: 1, maximum: 100, description: "API page size for scanning (default: 50)" },
      },
      required: ["states"],
    },
  },
  {
    name: "jules_get_session",
    description: "Get full details for a specific Jules session by ID.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId:            { type: "string",  description: "Session identifier" },
        compact:              { type: "boolean", description: "Return compact summary only (default: false)" },
        includePrompt:        { type: "boolean", description: "Include prompt in response" },
        includeOutputs:       { type: "boolean", description: "Include output payloads" },
        includeSourceContext: { type: "boolean", description: "Include sourceContext object" },
        maxPromptChars:       { type: "integer", minimum: 1, maximum: 20000, description: "Truncate prompt text to this length" },
      },
      required: ["sessionId"],
    },
  },
  {
    name: "jules_get_session_state",
    description: "Lightweight check of a session's current state. Returns only id, title, state, and timestamps — no large payloads.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "Session identifier" },
      },
      required: ["sessionId"],
    },
  },
  {
    name: "jules_session_summary",
    description: "Get a rich single-call summary of a session: state, activity count, latest agent message, and output links.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "Session identifier" },
      },
      required: ["sessionId"],
    },
  },
  {
    name: "jules_wait_for_session",
    description: "Poll a session until it reaches COMPLETED or FAILED. Returns the final session object. Use for automating workflows after session creation.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId:       { type: "string",  description: "Session identifier to wait for" },
        timeoutSeconds:  { type: "integer", minimum: 1, maximum: 3600, description: "Maximum wait time in seconds (default: 300)" },
        pollIntervalMs:  { type: "integer", minimum: 500, maximum: 30000, description: "Milliseconds between poll requests (default: 3000)" },
      },
      required: ["sessionId"],
    },
  },

  // ─── SESSION OUTPUTS ─────────────────────────────────────────────────────
  {
    name: "jules_get_session_output",
    description: "Extract structured outputs from a completed session: pull request URLs, changed files, or both.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId:  { type: "string", description: "Session identifier" },
        outputType: { type: "string", enum: ["pullRequest","files","all"], description: "What to extract (default: all)" },
      },
      required: ["sessionId"],
    },
  },
  {
    name: "jules_list_pr_outputs",
    description: "Scan recent sessions and return only those that produced pull requests. Great for a dashboard of all AI-generated PRs.",
    inputSchema: {
      type: "object",
      properties: {
        maxSessions:  { type: "integer", minimum: 1, maximum: 200, description: "Max sessions to scan (default: 50)" },
        sourceFilter: { type: "string",  description: "Optional substring to filter by repo name" },
      },
      required: [],
    },
  },

  // ─── ACTIVITIES ──────────────────────────────────────────────────────────
  {
    name: "jules_list_activities",
    description: "List all activity events for a session — Jules' step-by-step log of what it is doing.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string",  description: "Session identifier" },
        pageSize:  { type: "integer", minimum: 1, maximum: 100, description: "Results per page (default: 30)" },
        pageToken: { type: "string",  description: "Pagination token" },
      },
      required: ["sessionId"],
    },
  },
  {
    name: "jules_list_activities_filtered",
    description: "List session activities filtered by type (e.g. only ACTIVITY_COMPLETED events). Useful for extracting just the agent messages.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId:    { type: "string",  description: "Session identifier" },
        pageSize:     { type: "integer", minimum: 1, maximum: 100, description: "Results per page (default: 30)" },
        pageToken:    { type: "string",  description: "Pagination token" },
        activityType: { type: "string",  description: "Filter by activity type string (e.g. ACTIVITY_COMPLETED, ACTIVITY_FAILED, ACTIVITY_STARTED)" },
      },
      required: ["sessionId"],
    },
  },
  {
    name: "jules_get_latest_activity",
    description: "Get only the single most recent activity from a session — the last thing Jules said or did.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "Session identifier" },
      },
      required: ["sessionId"],
    },
  },

  // ─── SESSION ACTIONS ─────────────────────────────────────────────────────
  {
    name: "jules_send_message",
    description: "Send a follow-up instruction to an active Jules session — redirect it, add context, or ask it to revise.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "Session identifier" },
        prompt:    { type: "string", description: "Follow-up instruction to send" },
      },
      required: ["sessionId", "prompt"],
    },
  },
  {
    name: "jules_approve_plan",
    description: "Approve the plan Jules has proposed for a session in AWAITING_PLAN_APPROVAL state. Jules will then begin coding.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "Session identifier awaiting plan approval" },
      },
      required: ["sessionId"],
    },
  },
  {
    name: "jules_rename_session",
    description: "Update the title of an existing session.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "Session identifier" },
        newTitle:  { type: "string", description: "New title to assign to the session" },
      },
      required: ["sessionId", "newTitle"],
    },
  },

  // ─── SESSION DELETION ────────────────────────────────────────────────────
  {
    name: "jules_delete_session",
    description: "Delete a Jules session permanently.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "Session identifier to delete" },
      },
      required: ["sessionId"],
    },
  },
  {
    name: "jules_bulk_delete_sessions",
    description: "Delete multiple sessions by ID in parallel. Returns a per-session success/error report.",
    inputSchema: {
      type: "object",
      properties: {
        sessionIds:      { type: "array", items: { type: "string" }, description: "Array of session IDs to delete" },
        continueOnError: { type: "boolean", description: "If true, continue deleting even if one fails (default: true)" },
      },
      required: ["sessionIds"],
    },
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function ok(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function withCanonical(source) {
  if (!source || typeof source !== "object") return source;
  const canonical = source?.name || (source?.id ? `sources/${source.id}` : undefined);
  return canonical ? { ...source, canonicalSource: canonical } : source;
}

function extractOutputs(session) {
  const prs = [], files = [];
  for (const out of session?.outputs ?? []) {
    if (out?.pullRequest) prs.push(out.pullRequest);
    if (Array.isArray(out?.files)) files.push(...out.files);
  }
  return { pullRequests: prs, files };
}

function sanitizeSession(session, { compact, includePrompt, includeOutputs, includeSourceContext, maxPromptChars } = {}) {
  if (!compact && includePrompt === undefined && includeOutputs === undefined && includeSourceContext === undefined && !maxPromptChars) return session;
  const s = compact
    ? { name: session?.name, id: session?.id, title: session?.title, state: session?.state, createTime: session?.createTime, updateTime: session?.updateTime, url: session?.url }
    : { ...session };
  const wantPrompt  = compact ? false : (includePrompt  !== false);
  const wantOutputs = compact ? false : (includeOutputs !== false);
  const wantSource  = compact ? false : (includeSourceContext !== false);
  if (compact && session?.sourceContext?.source) s.source = session.sourceContext.source;
  if (!wantPrompt)  delete s.prompt;
  else if (maxPromptChars && typeof s.prompt === "string" && s.prompt.length > maxPromptChars)
    s.prompt = s.prompt.slice(0, maxPromptChars) + ` …(truncated ${s.prompt.length - maxPromptChars} chars)`;
  if (!wantOutputs) delete s.outputs;
  if (!wantSource)  delete s.sourceContext;
  return s;
}

function sourceMatchesFilter(source, query) {
  if (!query) return true;
  const q = query.toLowerCase();
  return [source?.name, source?.id, source?.githubRepo?.owner, source?.githubRepo?.repo,
    source?.githubRepo?.owner && source?.githubRepo?.repo ? `${source.githubRepo.owner}/${source.githubRepo.repo}` : undefined]
    .filter(Boolean).some(v => String(v).toLowerCase().includes(q));
}

// ---------------------------------------------------------------------------
// Tool runner
// ---------------------------------------------------------------------------
async function runTool(apiKey, name, args) {
  switch (name) {

    // ── UTILITY ────────────────────────────────────────────────────────────

    case "jules_health_check": {
      try {
        await julesRequest(apiKey, { path: "/sources", query: { pageSize: 1 } });
        return ok({ status: "healthy", apiReachable: true, server: SERVER_NAME, version: SERVER_VERSION, timestamp: new Date().toISOString() });
      } catch (e) {
        return ok({ status: "unhealthy", apiReachable: false, error: e?.message, server: SERVER_NAME, version: SERVER_VERSION, timestamp: new Date().toISOString() });
      }
    }

    case "jules_describe_error": {
      const { httpStatus, apiStatus, message } = args;
      const catalog = ERROR_CATALOG[httpStatus] ?? {};
      return ok({
        httpStatus: httpStatus ?? "unknown",
        apiStatus:  apiStatus  ?? "unknown",
        originalMessage: message ?? "(none)",
        description: catalog.description ?? "Unexpected error",
        suggestion:  catalog.suggestion  ?? "Check the Jules API docs or try again.",
        retryable:   catalog.retryable   ?? false,
      });
    }

    // ── SOURCES ────────────────────────────────────────────────────────────

    case "jules_list_sources": {
      const { pageSize = 20, pageToken, filter } = args;
      const result = await julesRequest(apiKey, { path: "/sources", query: { pageSize, pageToken } });
      let sources = Array.isArray(result.sources) ? result.sources.map(withCanonical) : [];
      if (filter) sources = sources.filter(s => sourceMatchesFilter(s, filter));
      return ok({ ...result, sources, total: sources.length });
    }

    case "jules_get_source": {
      const { sourceId } = args;
      if (!sourceId) throw new Error("sourceId is required");
      const raw = String(sourceId).replace(/^sources\//, "");
      for (const path of [`/sources/${raw}`, `/sources/${encodeURIComponent(raw)}`]) {
        try { return ok(withCanonical(await julesRequest(apiKey, { path }))); }
        catch (e) { if (e?.httpStatus !== 404) throw e; }
      }
      throw new Error(`Source not found: ${sourceId}. Use jules_list_sources to find valid sourceIds.`);
    }

    // ── SESSION CREATION ───────────────────────────────────────────────────

    case "jules_create_session": {
      const { prompt, source, startingBranch, title, requirePlanApproval } = args;
      if (!prompt) throw new Error("prompt is required");
      if (!source) throw new Error("source is required");
      const normalizedSource = source.startsWith("sources/") ? source : `sources/${source}`;
      const body = { prompt, sourceContext: { source: normalizedSource } };
      if (title) body.title = title;
      if (typeof requirePlanApproval === "boolean") body.requirePlanApproval = requirePlanApproval;
      const branches = startingBranch ? [startingBranch] : [undefined, "main", "master"];
      let lastErr;
      for (const branch of branches) {
        try {
          const payload = { ...body, sourceContext: { ...body.sourceContext } };
          if (branch) payload.sourceContext.githubRepoContext = { startingBranch: branch };
          return ok(await julesRequest(apiKey, { method: "POST", path: "/sessions", body: payload }));
        } catch (e) {
          lastErr = e;
          if (!(e?.httpStatus === 400 && e?.apiStatus === "INVALID_ARGUMENT")) throw e;
        }
      }
      throw lastErr;
    }

    case "jules_quick_session": {
      const { template, sourceFilter, startingBranch, customPrompt, requirePlanApproval = false } = args;
      if (!template) throw new Error("template is required");
      if (!sourceFilter) throw new Error("sourceFilter is required");
      const tmpl = SESSION_TEMPLATES[template];
      if (!tmpl) throw new Error(`Unknown template: ${template}. Available: ${Object.keys(SESSION_TEMPLATES).join(", ")}`);

      // Find source
      const listResult = await julesRequest(apiKey, { path: "/sources", query: { pageSize: 100 } });
      const allSources = Array.isArray(listResult.sources) ? listResult.sources : [];
      const matched = allSources.filter(s => sourceMatchesFilter(s, sourceFilter));
      if (matched.length === 0) throw new Error(`No source matching '${sourceFilter}'. Run jules_list_sources to see available repositories.`);
      if (matched.length > 1)  throw new Error(`Multiple sources match '${sourceFilter}': ${matched.map(s => s?.name || s?.id).join(", ")}. Be more specific.`);

      const source = matched[0];
      const sourceId = source?.name || (source?.id ? `sources/${source.id}` : undefined);
      const body = {
        prompt: customPrompt || tmpl.prompt,
        title: tmpl.title,
        requirePlanApproval,
        sourceContext: { source: sourceId },
      };
      const branches = startingBranch ? [startingBranch] : [undefined, "main", "master"];
      let lastErr;
      for (const branch of branches) {
        try {
          const payload = { ...body, sourceContext: { ...body.sourceContext } };
          if (branch) payload.sourceContext.githubRepoContext = { startingBranch: branch };
          const session = await julesRequest(apiKey, { method: "POST", path: "/sessions", body: payload });
          return ok({ ...session, _usedSource: sourceId, _template: template });
        } catch (e) {
          lastErr = e;
          if (!(e?.httpStatus === 400 && e?.apiStatus === "INVALID_ARGUMENT")) throw e;
        }
      }
      throw lastErr;
    }

    case "jules_build_session_prompt": {
      const { template, customTitle, customPrompt, requirePlanApproval = true } = args;
      const tmpl = SESSION_TEMPLATES[template];
      if (!tmpl) throw new Error(`Unknown template: ${template}. Available: ${Object.keys(SESSION_TEMPLATES).join(", ")}`);
      return ok({
        template,
        title: customTitle || tmpl.title,
        prompt: customPrompt || tmpl.prompt,
        requirePlanApproval,
        hint: "Pass title and prompt directly to jules_create_session or jules_quick_session.",
      });
    }

    case "jules_clone_session": {
      const { sessionId, newTitle, newPrompt, requirePlanApproval = false } = args;
      if (!sessionId) throw new Error("sessionId is required");
      const orig = await julesRequest(apiKey, { path: `/sessions/${encodeURIComponent(sessionId)}` });
      const origSource = orig?.sourceContext?.source;
      const origBranch = orig?.sourceContext?.githubRepoContext?.startingBranch;
      if (!origSource) throw new Error("Original session has no sourceContext.source — cannot clone.");
      const body = {
        prompt: newPrompt || orig?.prompt || "",
        title: newTitle || `Clone of: ${orig?.title || sessionId}`,
        requirePlanApproval,
        sourceContext: { source: origSource },
      };
      if (origBranch) body.sourceContext.githubRepoContext = { startingBranch: origBranch };
      const newSession = await julesRequest(apiKey, { method: "POST", path: "/sessions", body });
      return ok({ ...newSession, _clonedFrom: sessionId });
    }

    // ── SESSION READ ───────────────────────────────────────────────────────

    case "jules_list_sessions": {
      const { pageSize = 20, pageToken, compact, includePrompt, includeOutputs, includeSourceContext, maxPromptChars } = args;
      const result = await julesRequest(apiKey, { path: "/sessions", query: { pageSize, pageToken } });
      const sessions_ = Array.isArray(result.sessions)
        ? result.sessions.map(s => sanitizeSession(s, { compact, includePrompt, includeOutputs, includeSourceContext, maxPromptChars }))
        : [];
      return ok({ ...result, sessions: sessions_, total: sessions_.length });
    }

    case "jules_list_sessions_by_state": {
      const { states, maxResults = 20, pageSize = 50 } = args;
      if (!Array.isArray(states) || states.length === 0) throw new Error("states array is required");
      const stateSet = new Set(states.map(s => String(s).toUpperCase()));
      const collected = [];
      let nextPageToken;
      let scanned = 0;
      do {
        const page = await julesRequest(apiKey, { path: "/sessions", query: { pageSize, pageToken: nextPageToken } });
        const pageSessions = Array.isArray(page.sessions) ? page.sessions : [];
        for (const s of pageSessions) {
          if (stateSet.has(String(s?.state).toUpperCase())) {
            collected.push({ id: s?.id, name: s?.name, title: s?.title, state: s?.state, createTime: s?.createTime, updateTime: s?.updateTime });
            if (collected.length >= maxResults) break;
          }
        }
        scanned += pageSessions.length;
        nextPageToken = page.nextPageToken;
      } while (nextPageToken && collected.length < maxResults);
      return ok({ sessions: collected, total: collected.length, scanned, filter: states });
    }

    case "jules_get_session": {
      const { sessionId, compact, includePrompt, includeOutputs, includeSourceContext, maxPromptChars } = args;
      if (!sessionId) throw new Error("sessionId is required");
      const session = await julesRequest(apiKey, { path: `/sessions/${encodeURIComponent(sessionId)}` });
      return ok(sanitizeSession(session, { compact, includePrompt, includeOutputs, includeSourceContext, maxPromptChars }));
    }

    case "jules_get_session_state": {
      const { sessionId } = args;
      if (!sessionId) throw new Error("sessionId is required");
      const s = await julesRequest(apiKey, { path: `/sessions/${encodeURIComponent(sessionId)}` });
      return ok({ id: s?.id, name: s?.name, title: s?.title, state: s?.state, createTime: s?.createTime, updateTime: s?.updateTime });
    }

    case "jules_session_summary": {
      const { sessionId } = args;
      if (!sessionId) throw new Error("sessionId is required");
      const [session, activitiesPage] = await Promise.all([
        julesRequest(apiKey, { path: `/sessions/${encodeURIComponent(sessionId)}` }),
        julesRequest(apiKey, { path: `/sessions/${encodeURIComponent(sessionId)}/activities`, query: { pageSize: 5 } }),
      ]);
      const activities = Array.isArray(activitiesPage?.activities) ? activitiesPage.activities : [];
      const { pullRequests, files } = extractOutputs(session);
      return ok({
        id:          session?.id,
        title:       session?.title,
        state:       session?.state,
        source:      session?.sourceContext?.source,
        branch:      session?.sourceContext?.githubRepoContext?.startingBranch,
        createTime:  session?.createTime,
        updateTime:  session?.updateTime,
        promptSnippet: typeof session?.prompt === "string" ? session.prompt.slice(0, 200) + (session.prompt.length > 200 ? "…" : "") : undefined,
        latestActivity: activities[0] ?? null,
        activityCount: activitiesPage?.totalSize ?? activities.length,
        outputs: { pullRequests, fileCount: files.length },
      });
    }

    case "jules_wait_for_session": {
      const { sessionId, timeoutSeconds = 300, pollIntervalMs = 3000 } = args;
      if (!sessionId) throw new Error("sessionId is required");
      const start = Date.now();
      const timeoutMs = timeoutSeconds * 1000;
      let lastState;
      while (true) {
        const elapsed = Date.now() - start;
        if (elapsed > timeoutMs) throw new Error(`Timeout after ${timeoutSeconds}s. Last known state: ${lastState ?? "unknown"}.`);
        try {
          const session = await julesRequest(apiKey, { path: `/sessions/${encodeURIComponent(sessionId)}` });
          lastState = session?.state;
          if (TERMINAL_STATES.includes(lastState)) return ok({ ...session, _waitedMs: elapsed });
        } catch (e) {
          if ((e?.httpStatus ?? 0) >= 500) { /* transient — keep polling */ }
          else throw e;
        }
        await new Promise(r => setTimeout(r, Math.max(500, pollIntervalMs)));
      }
    }

    // ── SESSION OUTPUTS ────────────────────────────────────────────────────

    case "jules_get_session_output": {
      const { sessionId, outputType = "all" } = args;
      if (!sessionId) throw new Error("sessionId is required");
      const session = await julesRequest(apiKey, { path: `/sessions/${encodeURIComponent(sessionId)}` });
      const { pullRequests, files } = extractOutputs(session);
      const result = { sessionId, state: session?.state };
      if (outputType === "pullRequest" || outputType === "all") result.pullRequests = pullRequests;
      if (outputType === "files"       || outputType === "all") result.files = files;
      return ok(result);
    }

    case "jules_list_pr_outputs": {
      const { maxSessions = 50, sourceFilter } = args;
      let nextPageToken;
      let scanned = 0;
      const withPRs = [];
      do {
        const page = await julesRequest(apiKey, { path: "/sessions", query: { pageSize: 50, pageToken: nextPageToken } });
        const pageSessions = Array.isArray(page.sessions) ? page.sessions : [];
        for (const s of pageSessions) {
          if (scanned >= maxSessions) break;
          if (sourceFilter && !sourceMatchesFilter(s?.sourceContext, sourceFilter)) { scanned++; continue; }
          const { pullRequests } = extractOutputs(s);
          if (pullRequests.length > 0) {
            withPRs.push({ id: s?.id, title: s?.title, state: s?.state, source: s?.sourceContext?.source, pullRequests, updateTime: s?.updateTime });
          }
          scanned++;
        }
        nextPageToken = scanned < maxSessions ? page.nextPageToken : undefined;
      } while (nextPageToken);
      return ok({ sessions: withPRs, total: withPRs.length, scanned });
    }

    // ── ACTIVITIES ─────────────────────────────────────────────────────────

    case "jules_list_activities": {
      const { sessionId, pageSize = 30, pageToken } = args;
      if (!sessionId) throw new Error("sessionId is required");
      return ok(await julesRequest(apiKey, {
        path: `/sessions/${encodeURIComponent(sessionId)}/activities`,
        query: { pageSize, pageToken },
      }));
    }

    case "jules_list_activities_filtered": {
      const { sessionId, pageSize = 30, pageToken, activityType } = args;
      if (!sessionId) throw new Error("sessionId is required");
      const result = await julesRequest(apiKey, {
        path: `/sessions/${encodeURIComponent(sessionId)}/activities`,
        query: { pageSize, pageToken },
      });
      if (!activityType) return ok(result);
      const filtered = (Array.isArray(result?.activities) ? result.activities : [])
        .filter(a => String(a?.activityType ?? a?.type ?? "").toUpperCase().includes(activityType.toUpperCase()));
      return ok({ ...result, activities: filtered, _filteredBy: activityType, _filteredCount: filtered.length });
    }

    case "jules_get_latest_activity": {
      const { sessionId } = args;
      if (!sessionId) throw new Error("sessionId is required");
      const result = await julesRequest(apiKey, {
        path: `/sessions/${encodeURIComponent(sessionId)}/activities`,
        query: { pageSize: 5 },
      });
      const activities = Array.isArray(result?.activities) ? result.activities : [];
      return ok({ sessionId, latestActivity: activities[0] ?? null, totalActivities: result?.totalSize ?? activities.length });
    }

    // ── SESSION ACTIONS ────────────────────────────────────────────────────

    case "jules_send_message": {
      const { sessionId, prompt } = args;
      if (!sessionId) throw new Error("sessionId is required");
      if (!prompt)    throw new Error("prompt is required");
      return ok(await julesRequest(apiKey, {
        method: "POST", path: `/sessions/${encodeURIComponent(sessionId)}:sendMessage`, body: { prompt },
      }));
    }

    case "jules_approve_plan": {
      const { sessionId } = args;
      if (!sessionId) throw new Error("sessionId is required");
      return ok(await julesRequest(apiKey, {
        method: "POST", path: `/sessions/${encodeURIComponent(sessionId)}:approvePlan`, body: {},
      }));
    }

    case "jules_rename_session": {
      const { sessionId, newTitle } = args;
      if (!sessionId) throw new Error("sessionId is required");
      if (!newTitle)  throw new Error("newTitle is required");
      // Jules API: PATCH session with updateMask
      return ok(await julesRequest(apiKey, {
        method: "PATCH",
        path: `/sessions/${encodeURIComponent(sessionId)}`,
        query: { updateMask: "title" },
        body: { title: newTitle },
      }));
    }

    // ── SESSION DELETION ───────────────────────────────────────────────────

    case "jules_delete_session": {
      const { sessionId } = args;
      if (!sessionId) throw new Error("sessionId is required");
      return ok(await julesRequest(apiKey, { method: "DELETE", path: `/sessions/${encodeURIComponent(sessionId)}` }));
    }

    case "jules_bulk_delete_sessions": {
      const { sessionIds, continueOnError = true } = args;
      if (!Array.isArray(sessionIds) || sessionIds.length === 0) throw new Error("sessionIds array is required and must not be empty");
      const results = await Promise.allSettled(
        sessionIds.map(id =>
          julesRequest(apiKey, { method: "DELETE", path: `/sessions/${encodeURIComponent(id)}` })
            .then(() => ({ id, deleted: true }))
            .catch(e  => ({ id, deleted: false, error: e?.message }))
        )
      );
      const report = results.map(r => r.value ?? r.reason);
      const succeeded = report.filter(r => r?.deleted).length;
      const failed    = report.filter(r => !r?.deleted).length;
      return ok({ total: sessionIds.length, succeeded, failed, results: report });
    }

    default:
      throw Object.assign(new Error(`Unknown tool: ${name}`), { code: -32601 });
  }
}

// ---------------------------------------------------------------------------
// JSON-RPC dispatcher
// ---------------------------------------------------------------------------
async function dispatch(apiKey, rpc) {
  const id = rpc?.id ?? null;
  try {
    switch (rpc?.method) {
      case "initialize":
        return {
          jsonrpc: "2.0", id,
          result: {
            protocolVersion: rpc?.params?.protocolVersion ?? PROTO_V,
            capabilities: { tools: {} },
            serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          },
        };

      case "notifications/initialized":
        return null;

      case "tools/list":
        return { jsonrpc: "2.0", id, result: { tools: TOOLS } };

      case "tools/call": {
        const { name, arguments: toolArgs } = rpc?.params ?? {};
        if (!name) return { jsonrpc: "2.0", id, error: { code: -32602, message: "params.name required" } };
        if (!apiKey) return { jsonrpc: "2.0", id, error: { code: -32001, message: "Jules API key required. Set Authorization: Bearer <key> on the Perplexity connector." } };
        const result = await runTool(apiKey, name, toolArgs ?? {});
        return { jsonrpc: "2.0", id, result };
      }

      case "ping":
        return { jsonrpc: "2.0", id, result: {} };

      default:
        return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${rpc?.method}` } };
    }
  } catch (err) {
    return { jsonrpc: "2.0", id, error: { code: err?.code ?? -32603, message: err?.message ?? String(err) } };
  }
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------
function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...CORS, ...extra },
  });
}

function wantsSSE(req) {
  return (req.headers.get("accept") ?? "").includes("text/event-stream");
}

function extractApiKey(req) {
  const auth = req.headers.get("authorization") ?? "";
  if (auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  return (req.headers.get("x-api-key") ?? "").trim();
}

// ---------------------------------------------------------------------------
// Main request handler
// ---------------------------------------------------------------------------
async function handle(req) {
  const url  = new URL(req.url);
  const path = url.pathname;

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  // ── Health / info ─────────────────────────────────────────────────────────
  if (path === "/" || path === "/health") {
    return json({
      server: SERVER_NAME, version: SERVER_VERSION, protocol: PROTO_V, status: "ok",
      transports: {
        primary:   "Legacy SSE → GET /sse then POST /messages",
        secondary: "Streamable HTTP → POST /mcp",
      },
      perplexity_connector_url: `${url.origin}/sse`,
      toolCount: TOOLS.length,
      tools: TOOLS.map(t => t.name),
    });
  }

  // =========================================================================
  // PRIMARY: LEGACY SSE TRANSPORT
  // =========================================================================

  if (path === "/sse" && req.method === "GET") {
    const clientId    = crypto.randomUUID();
    const apiKey      = extractApiKey(req);
    const messagesUrl = `${url.origin}/messages?clientId=${clientId}`;

    const stream = new ReadableStream({
      start(ctrl) {
        sseClients.set(clientId, { controller: ctrl, apiKey });
        ctrl.enqueue(new TextEncoder().encode(`event: endpoint\ndata: ${messagesUrl}\n\n`));
        console.log(`[SSE] connected: ${clientId}`);
      },
      cancel() {
        sseClients.delete(clientId);
        console.log(`[SSE] disconnected: ${clientId}`);
      },
    });

    return new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache", "connection": "keep-alive", ...CORS },
    });
  }

  if (path === "/messages" && req.method === "POST") {
    const clientId = url.searchParams.get("clientId");
    const client   = sseClients.get(clientId);
    const apiKey   = extractApiKey(req) || client?.apiKey || "";

    let rpc;
    try { rpc = await req.json(); }
    catch {
      if (clientId && client) pushSSE(clientId, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      return new Response(null, { status: 202, headers: CORS });
    }

    const rpcs = Array.isArray(rpc) ? rpc : [rpc];
    for (const r of rpcs) {
      const result = await dispatch(apiKey, r);
      if (result !== null && clientId && client) pushSSE(clientId, result);
    }
    return new Response(null, { status: 202, headers: CORS });
  }

  // =========================================================================
  // SECONDARY: STREAMABLE HTTP TRANSPORT
  // =========================================================================

  if (path === "/mcp" && req.method === "DELETE") {
    const sid = req.headers.get("mcp-session-id");
    if (sid && sessions.has(sid)) { sessions.delete(sid); return new Response(null, { status: 200, headers: CORS }); }
    return json({ error: "Session not found" }, 404);
  }

  if (path === "/mcp" && req.method === "GET") {
    const sid = req.headers.get("mcp-session-id");
    if (!sid || !sessions.has(sid)) return json({ error: "Missing or invalid Mcp-Session-Id" }, 400);
    return new Response("", {
      status: 200,
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache", "mcp-session-id": sid, ...CORS },
    });
  }

  if (path === "/mcp" && req.method === "POST") {
    const apiKey = extractApiKey(req);
    let rpc;
    try { rpc = await req.json(); }
    catch { return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400); }

    const isInit      = Array.isArray(rpc) ? rpc.some(r => r?.method === "initialize") : rpc?.method === "initialize";
    const incomingSid = req.headers.get("mcp-session-id");
    let sessionId;

    if (isInit) {
      sessionId = crypto.randomUUID();
      sessions.set(sessionId, { created: Date.now() });
    } else {
      if (!incomingSid || !sessions.has(incomingSid)) {
        return json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: incomingSid ? `Unknown session: ${incomingSid}` : "Mcp-Session-Id header required" } }, 400);
      }
      sessionId = incomingSid;
    }

    const sessionHeader = { "mcp-session-id": sessionId };

    if (Array.isArray(rpc)) {
      const results = (await Promise.all(rpc.map(r => dispatch(apiKey, r)))).filter(Boolean);
      const payload = results.length === 1 ? results[0] : results;
      const body    = wantsSSE(req) ? `event: message\ndata: ${JSON.stringify(payload)}\n\n` : JSON.stringify(payload);
      const ct      = wantsSSE(req) ? "text/event-stream" : "application/json";
      return new Response(body, { status: 200, headers: { "content-type": ct, ...CORS, ...sessionHeader } });
    }

    const result = await dispatch(apiKey, rpc);
    if (result === null) return new Response(null, { status: 204, headers: { ...CORS, ...sessionHeader } });
    const body = wantsSSE(req) ? `event: message\ndata: ${JSON.stringify(result)}\n\n` : JSON.stringify(result);
    const ct   = wantsSSE(req) ? "text/event-stream" : "application/json";
    return new Response(body, { status: 200, headers: { "content-type": ct, ...CORS, ...sessionHeader } });
  }

  return json({ error: "Not found", hint: "Try GET /health or GET /sse" }, 404);
}

Deno.serve(handle);
console.log(`\n🔧 ${SERVER_NAME} v${SERVER_VERSION} — ${TOOLS.length} tools loaded`);
console.log(`   ✅ PRIMARY   → GET  /sse          (Perplexity connector URL)`);
console.log(`   ✅ SECONDARY → POST /mcp          (Streamable HTTP)`);
console.log(`   ✅ HEALTH    → GET  /health\n`);
