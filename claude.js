/**
 * claude.js — Jules MCP Server for Claude.ai  (self-contained, no deps)
 *
 * Claude.ai custom connectors don't support static bearer tokens, so this
 * entrypoint uses a SECRET URL PATH for access control, and reads the Jules
 * API key from a Deno Deploy environment variable.
 *
 * This file is intentionally self-contained (no MCP SDK, no node_modules) —
 * the same proven shape as perplexity.js — so it deploys cleanly on Deno
 * Deploy with no install/build step.
 *
 * Deploy (Deno Deploy):
 *   Entrypoint:      claude.js
 *   Install command: (leave blank)
 *   Build command:   (leave blank)
 *   Env vars:
 *     JULES_API_KEY    = your Google Jules API key
 *     MCP_PATH_SECRET  = a long random string (e.g. openssl rand -hex 32)
 *
 * Claude.ai connector config:
 *   URL:  https://<project>.deno.net/mcp/<MCP_PATH_SECRET>
 *   Auth: (none — the secret path IS the auth)
 *   Transport: Streamable HTTP
 */

const SERVER_NAME    = "jules-mcp";
const SERVER_VERSION = "3.1.0";
const PROTO_V        = "2025-03-26";
const JULES_BASE     = "https://jules.googleapis.com/v1alpha";

const JULES_API_KEY   = Deno.env.get("JULES_API_KEY") ?? "";
const MCP_PATH_SECRET = Deno.env.get("MCP_PATH_SECRET") ?? "";
const MCP_PATH        = `/mcp/${MCP_PATH_SECRET}`;

if (!JULES_API_KEY)   console.error("WARNING: JULES_API_KEY env var is not set.");
if (!MCP_PATH_SECRET) console.error("WARNING: MCP_PATH_SECRET env var is not set — all MCP requests will 404.");

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
// Secret-path access control (constant-time comparison)
// ---------------------------------------------------------------------------
function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

function isAuthorizedPath(pathname) {
  if (!MCP_PATH_SECRET) return false;
  return constantTimeEqual(pathname, MCP_PATH);
}

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

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------
const TOOLS = [
  {
    name: "jules_health_check",
    description: "Check Jules API connectivity and health. Returns server version, reachability, and current timestamp.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
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
    description: "Get full details for one Jules source (repository), including available branches and default branch. Accepts github/owner/repo or sources/github/owner/repo format. Call this before creating a session to see which branches are available.",
    inputSchema: {
      type: "object",
      properties: {
        sourceId: { type: "string", description: "Source identifier, e.g. github/myorg/myrepo or sources/github/myorg/myrepo" },
      },
      required: ["sourceId"],
    },
  },
  {
    name: "jules_create_session",
    description: "Create a new Jules AI coding session. Jules will plan and implement the task on the specified repository branch. Set automationMode to AUTO_CREATE_PR for fully autonomous operation.",
    inputSchema: {
      type: "object",
      properties: {
        prompt:              { type: "string",  description: "Detailed task instruction for Jules (be specific about what to build/fix/test)" },
        source:              { type: "string",  description: "Repository source, e.g. sources/github/myorg/myrepo" },
        startingBranch:      { type: "string",  description: "Branch to start from (e.g. main). Auto-detected if omitted." },
        title:               { type: "string",  description: "Optional human-readable session title" },
        automationMode:      { type: "string",  enum: ["AUTO_CREATE_PR"], description: "Set to AUTO_CREATE_PR to have Jules automatically create a PR when done (no manual step needed)" },
        requirePlanApproval: { type: "boolean", description: "If true, Jules pauses for your approval before writing code (default: false)" },
      },
      required: ["prompt", "source"],
    },
  },
  {
    name: "jules_quick_session",
    description: "One-shot shortcut: pick a template + repo name substring and instantly create a session. Ideal for common recurring tasks. Set automationMode to AUTO_CREATE_PR for hands-free operation.",
    inputSchema: {
      type: "object",
      properties: {
        template:            { type: "string", enum: Object.keys(SESSION_TEMPLATES), description: "Preset task template name" },
        sourceFilter:        { type: "string", description: "Substring to identify the repo (e.g. 'myorg/myrepo'). Must match exactly one source." },
        startingBranch:      { type: "string", description: "Branch to start from (optional)" },
        customPrompt:        { type: "string", description: "Override the template prompt with custom instructions" },
        automationMode:      { type: "string",  enum: ["AUTO_CREATE_PR"], description: "Set to AUTO_CREATE_PR to auto-create a PR when done" },
        requirePlanApproval: { type: "boolean", description: "Require plan approval before coding starts (default: false)" },
      },
      required: ["template", "sourceFilter"],
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
      properties: { sessionId: { type: "string", description: "Session identifier" } },
      required: ["sessionId"],
    },
  },
  {
    name: "jules_session_summary",
    description: "Get a rich single-call summary of a session: state, activity count, latest agent message, and output links.",
    inputSchema: {
      type: "object",
      properties: { sessionId: { type: "string", description: "Session identifier" } },
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
  {
    name: "jules_get_session_output",
    description: "Extract structured outputs from a completed session: pull request URLs, changed files, or both.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId:  { type: "string", description: "Session identifier" },
        outputType: { type: "string", enum: ["pullRequest","files","changeSets","all"], description: "What to extract (default: all)" },
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
    name: "jules_get_latest_activity",
    description: "Get only the single most recent activity from a session — the last thing Jules said or did.",
    inputSchema: {
      type: "object",
      properties: { sessionId: { type: "string", description: "Session identifier" } },
      required: ["sessionId"],
    },
  },
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
      properties: { sessionId: { type: "string", description: "Session identifier awaiting plan approval" } },
      required: ["sessionId"],
    },
  },
  {
    name: "jules_delete_session",
    description: "Delete a Jules session permanently.",
    inputSchema: {
      type: "object",
      properties: { sessionId: { type: "string", description: "Session identifier to delete" } },
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
  {
    name: "jules_archive_session",
    description: "Archive a Jules session. Archived sessions are hidden from default listings but not deleted.",
    inputSchema: {
      type: "object",
      properties: { sessionId: { type: "string", description: "Session identifier to archive" } },
      required: ["sessionId"],
    },
  },
  {
    name: "jules_unarchive_session",
    description: "Unarchive a previously archived Jules session, making it visible in default listings again.",
    inputSchema: {
      type: "object",
      properties: { sessionId: { type: "string", description: "Session identifier to unarchive" } },
      required: ["sessionId"],
    },
  },
  {
    name: "jules_get_activity",
    description: "Get a single activity by its full resource name. Use when you need details on a specific activity event.",
    inputSchema: {
      type: "object",
      properties: { activityName: { type: "string", description: "Full activity resource name, e.g. sessions/123/activities/456" } },
      required: ["activityName"],
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
  const prs = [], files = [], changeSets = [];
  for (const out of session?.outputs ?? []) {
    if (out?.pullRequest) prs.push(out.pullRequest);
    if (Array.isArray(out?.files)) files.push(...out.files);
    if (out?.changeSet) changeSets.push(out.changeSet);
  }
  return { pullRequests: prs, files, changeSets };
}

function sanitizeSession(session, { compact, includePrompt, includeOutputs, includeSourceContext, maxPromptChars } = {}) {
  if (!compact && includePrompt === undefined && includeOutputs === undefined && includeSourceContext === undefined && !maxPromptChars) return session;
  const s = compact
    ? { name: session?.name, id: session?.id, title: session?.title, state: session?.state, archived: session?.archived, createTime: session?.createTime, updateTime: session?.updateTime, url: session?.url }
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

// ponytail: strip heavy nested fields from activities, keep shape useful for agents
function slimActivity(a) {
  if (!a || typeof a !== "object") return a;
  const slim = { id: a.id, createTime: a.createTime, originator: a.originator };
  if (a.planGenerated) slim.type = "planGenerated";
  else if (a.planApproved) slim.type = "planApproved";
  else if (a.sessionCompleted) slim.type = "sessionCompleted";
  else if (a.progressUpdated) {
    slim.type = "progressUpdated";
    const msg = a.progressUpdated?.agentMessage?.content;
    if (msg) slim.message = msg.length > 300 ? msg.slice(0, 300) + "…" : msg;
  }
  else if (a.userMessage) slim.type = "userMessage";
  else slim.type = Object.keys(a).find(k => !["name","createTime","originator","id"].includes(k)) ?? "unknown";
  if (a.artifacts) slim.artifactCount = Array.isArray(a.artifacts) ? a.artifacts.length : 1;
  return slim;
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
    case "jules_health_check": {
      try {
        await julesRequest(apiKey, { path: "/sources", query: { pageSize: 1 } });
        return ok({ status: "healthy", apiReachable: true, server: SERVER_NAME, version: SERVER_VERSION, timestamp: new Date().toISOString() });
      } catch (e) {
        return ok({ status: "unhealthy", apiReachable: false, error: e?.message, server: SERVER_NAME, version: SERVER_VERSION, timestamp: new Date().toISOString() });
      }
    }

    case "jules_list_sources": {
      const { pageSize = 20, pageToken, filter } = args;
      if (filter) {
        // ponytail: paginate all sources before filtering, cap at 5 pages to avoid runaway
        const all = [];
        let token = pageToken;
        for (let page = 0; page < 5; page++) {
          const result = await julesRequest(apiKey, { path: "/sources", query: { pageSize: 100, pageToken: token } });
          if (Array.isArray(result.sources)) all.push(...result.sources);
          token = result.nextPageToken;
          if (!token) break;
        }
        const sources = all.map(withCanonical).filter(s => sourceMatchesFilter(s, filter));
        return ok({ sources, total: sources.length });
      }
      const result = await julesRequest(apiKey, { path: "/sources", query: { pageSize, pageToken } });
      const sources = Array.isArray(result.sources) ? result.sources.map(withCanonical) : [];
      return ok({ sources, total: sources.length, nextPageToken: result.nextPageToken });
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

    case "jules_create_session": {
      const { prompt, source, startingBranch, title, automationMode, requirePlanApproval } = args;
      if (!prompt) throw new Error("prompt is required");
      if (!source) throw new Error("source is required");
      const normalizedSource = source.startsWith("sources/") ? source : `sources/${source}`;
      const body = { prompt, sourceContext: { source: normalizedSource } };
      if (title) body.title = title;
      if (automationMode) body.automationMode = automationMode;
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
      const { template, sourceFilter, startingBranch, customPrompt, automationMode, requirePlanApproval = false } = args;
      if (!template) throw new Error("template is required");
      if (!sourceFilter) throw new Error("sourceFilter is required");
      const tmpl = SESSION_TEMPLATES[template];
      if (!tmpl) throw new Error(`Unknown template: ${template}. Available: ${Object.keys(SESSION_TEMPLATES).join(", ")}`);
      const listResult = await julesRequest(apiKey, { path: "/sources", query: { pageSize: 100 } });
      const allSources = Array.isArray(listResult.sources) ? listResult.sources : [];
      const matched = allSources.filter(s => sourceMatchesFilter(s, sourceFilter));
      if (matched.length === 0) throw new Error(`No source matching '${sourceFilter}'. Run jules_list_sources to see available repositories.`);
      if (matched.length > 1)  throw new Error(`Multiple sources match '${sourceFilter}': ${matched.map(s => s?.name || s?.id).join(", ")}. Be more specific.`);
      const source = matched[0];
      const sourceId = source?.name || (source?.id ? `sources/${source.id}` : undefined);
      const body = { prompt: customPrompt || tmpl.prompt, title: tmpl.title, requirePlanApproval, sourceContext: { source: sourceId } };
      if (automationMode) body.automationMode = automationMode;
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

    case "jules_list_sessions": {
      const { pageSize = 20, pageToken, compact, includePrompt, includeOutputs, includeSourceContext, maxPromptChars } = args;
      const result = await julesRequest(apiKey, { path: "/sessions", query: { pageSize, pageToken } });
      const sessions_ = Array.isArray(result.sessions)
        ? result.sessions.map(s => sanitizeSession(s, { compact, includePrompt, includeOutputs, includeSourceContext, maxPromptChars }))
        : [];
      return ok({ sessions: sessions_, pageCount: sessions_.length, nextPageToken: result.nextPageToken });
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
      return ok({ id: s?.id, name: s?.name, title: s?.title, state: s?.state, archived: s?.archived, createTime: s?.createTime, updateTime: s?.updateTime });
    }

    case "jules_session_summary": {
      const { sessionId } = args;
      if (!sessionId) throw new Error("sessionId is required");
      const [session, activitiesPage] = await Promise.all([
        julesRequest(apiKey, { path: `/sessions/${encodeURIComponent(sessionId)}` }),
        julesRequest(apiKey, { path: `/sessions/${encodeURIComponent(sessionId)}/activities`, query: { pageSize: 100 } }),
      ]);
      const activities = Array.isArray(activitiesPage?.activities) ? activitiesPage.activities : [];
      const { pullRequests, files, changeSets } = extractOutputs(session);
      const created = new Date(session?.createTime);
      const updated = new Date(session?.updateTime);
      const durationMin = Math.round((updated - created) / 60000);
      const rawSource = session?.sourceContext?.source ?? "";
      const summary = {
        title:    session?.title,
        state:    session?.state,
        repo:     rawSource.replace(/^sources\/github\//, ""),
        branch:   session?.sourceContext?.githubRepoContext?.startingBranch,
        duration: `${durationMin}m`,
        prompt:   typeof session?.prompt === "string" ? session.prompt.slice(0, 200) + (session.prompt.length > 200 ? "…" : "") : undefined,
        lastAction: activities.length > 0 ? (slimActivity(activities[activities.length - 1])?.type ?? null) : null,
        steps:    activities.length,
      };
      if (pullRequests.length > 0) summary.prs = pullRequests.map(pr => ({ url: pr.url, title: pr.title }));
      if (changeSets.length > 0) summary.commits = changeSets.map(cs => cs.gitPatch?.suggestedCommitMessage).filter(Boolean);
      if (files.length > 0) summary.fileCount = files.length;
      if (activitiesPage?.nextPageToken) summary.hasMoreSteps = true;
      if (session?.url) summary.url = session.url;
      return ok(summary);
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

    case "jules_get_session_output": {
      const { sessionId, outputType = "all" } = args;
      if (!sessionId) throw new Error("sessionId is required");
      const session = await julesRequest(apiKey, { path: `/sessions/${encodeURIComponent(sessionId)}` });
      const { pullRequests, files, changeSets } = extractOutputs(session);
      const result = { sessionId, state: session?.state };
      if (outputType === "pullRequest" || outputType === "all") result.pullRequests = pullRequests;
      if (outputType === "files"       || outputType === "all") result.files = files;
      if (outputType === "changeSets"  || outputType === "all") result.changeSets = changeSets;
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

    case "jules_list_activities": {
      const { sessionId, pageSize = 30, pageToken } = args;
      if (!sessionId) throw new Error("sessionId is required");
      const result = await julesRequest(apiKey, {
        path: `/sessions/${encodeURIComponent(sessionId)}/activities`,
        query: { pageSize, pageToken },
      });
      const activities = Array.isArray(result?.activities) ? result.activities.map(slimActivity) : [];
      return ok({ activities, pageCount: activities.length, nextPageToken: result?.nextPageToken });
    }

    case "jules_get_latest_activity": {
      const { sessionId } = args;
      if (!sessionId) throw new Error("sessionId is required");
      const result = await julesRequest(apiKey, {
        path: `/sessions/${encodeURIComponent(sessionId)}/activities`,
        query: { pageSize: 100 },
      });
      const activities = Array.isArray(result?.activities) ? result.activities : [];
      return ok({ sessionId, latestActivity: slimActivity(activities[activities.length - 1]) ?? null, totalActivities: activities.length });
    }

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
      await julesRequest(apiKey, {
        method: "POST", path: `/sessions/${encodeURIComponent(sessionId)}:approvePlan`, body: {},
      });
      return ok({ approved: true, sessionId, message: "Plan approved. Jules will now begin coding." });
    }

    case "jules_delete_session": {
      const { sessionId } = args;
      if (!sessionId) throw new Error("sessionId is required");
      await julesRequest(apiKey, { method: "DELETE", path: `/sessions/${encodeURIComponent(sessionId)}` });
      return ok({ deleted: true, sessionId });
    }

    case "jules_bulk_delete_sessions": {
      const { sessionIds } = args;
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

    case "jules_archive_session": {
      const { sessionId } = args;
      if (!sessionId) throw new Error("sessionId is required");
      await julesRequest(apiKey, {
        method: "POST", path: `/sessions/${encodeURIComponent(sessionId)}:archive`, body: {},
      });
      return ok({ archived: true, sessionId });
    }

    case "jules_unarchive_session": {
      const { sessionId } = args;
      if (!sessionId) throw new Error("sessionId is required");
      await julesRequest(apiKey, {
        method: "POST", path: `/sessions/${encodeURIComponent(sessionId)}:unarchive`, body: {},
      });
      return ok({ unarchived: true, sessionId });
    }

    case "jules_get_activity": {
      const { activityName } = args;
      if (!activityName) throw new Error("activityName is required");
      const raw = activityName.startsWith("sessions/") ? activityName : `sessions/${activityName}`;
      const activity = await julesRequest(apiKey, { path: `/${raw}` });
      return ok(activity);
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
      case "notifications/cancelled":
        return null;

      case "tools/list":
        return { jsonrpc: "2.0", id, result: { tools: TOOLS } };

      case "tools/call": {
        const { name, arguments: toolArgs } = rpc?.params ?? {};
        if (!name) return { jsonrpc: "2.0", id, error: { code: -32602, message: "params.name required" } };
        if (!apiKey) return { jsonrpc: "2.0", id, error: { code: -32001, message: "Jules API key not configured on the server (set JULES_API_KEY env var)." } };
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

// ---------------------------------------------------------------------------
// MCP endpoint (Streamable HTTP) — always responds with plain JSON
// ---------------------------------------------------------------------------
async function handleMcp(req) {
  // GET: optional server→client stream. We don't push server-initiated
  // messages, so return an immediately-closing SSE stream (spec-compliant).
  if (req.method === "GET") {
    return new Response("", {
      status: 200,
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache", ...CORS },
    });
  }

  // DELETE: client ending the session. Stateless server — just ack.
  if (req.method === "DELETE") {
    return new Response(null, { status: 200, headers: CORS });
  }

  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  let rpc;
  try { rpc = await req.json(); }
  catch { return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400); }

  const incomingSid = req.headers.get("mcp-session-id");
  const sessionId   = incomingSid || crypto.randomUUID();
  const sessionHeader = { "mcp-session-id": sessionId };

  if (Array.isArray(rpc)) {
    const results = (await Promise.all(rpc.map(r => dispatch(JULES_API_KEY, r)))).filter(Boolean);
    if (results.length === 0) return new Response(null, { status: 202, headers: { ...CORS, ...sessionHeader } });
    const payload = results.length === 1 ? results[0] : results;
    return json(payload, 200, sessionHeader);
  }

  const result = await dispatch(JULES_API_KEY, rpc);
  if (result === null) return new Response(null, { status: 202, headers: { ...CORS, ...sessionHeader } });
  return json(result, 200, sessionHeader);
}

// ---------------------------------------------------------------------------
// Main request handler
// ---------------------------------------------------------------------------
async function handle(req) {
  const url  = new URL(req.url);
  const path = url.pathname;

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  if (path === "/" || path === "/health") {
    return json({
      server: SERVER_NAME, version: SERVER_VERSION, protocol: PROTO_V, status: "ok",
      transport: "Streamable HTTP at /mcp/<secret>",
      toolCount: TOOLS.length,
      apiKeyConfigured: Boolean(JULES_API_KEY),
      secretConfigured: Boolean(MCP_PATH_SECRET),
    });
  }

  // MCP endpoint — gated by the secret path
  if (isAuthorizedPath(path)) {
    return await handleMcp(req);
  }

  // Everything else — generic 404 (don't reveal the secret endpoint exists)
  return json({ error: "Not found" }, 404);
}

Deno.serve(handle);
console.log(`\n🔧 ${SERVER_NAME} v${SERVER_VERSION} (Claude connector) — ${TOOLS.length} tools loaded`);
console.log(`   ✅ MCP    → /mcp/<secret>   (Streamable HTTP, JSON responses)`);
console.log(`   ✅ HEALTH → GET /health`);
console.log(`   apiKey configured: ${Boolean(JULES_API_KEY)} | secret configured: ${Boolean(MCP_PATH_SECRET)}\n`);
