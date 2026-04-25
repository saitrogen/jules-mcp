/**
 * lib/server.js
 * Core Jules MCP server factory.
 * Used by both the stdio entrypoint (index.js) and the HTTP/Deno entrypoint (http.js).
 *
 * createServer(apiKey?) returns a fully-configured McpServer instance.
 * If apiKey is omitted, falls back to process.env.JULES_API_KEY (stdio mode).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

function buildJulesRequest(apiKey, baseUrl) {
  return async function julesRequest({ method = "GET", path, query, body }) {
    const key = apiKey || (typeof process !== "undefined" ? process.env?.JULES_API_KEY : undefined);
    if (!key) {
      throw new Error(
        "Missing JULES_API_KEY. Provide it via environment variable or Authorization header."
      );
    }

    const base = baseUrl || (typeof process !== "undefined" ? process.env?.JULES_BASE_URL : undefined) || "https://jules.googleapis.com/v1alpha";
    const url = buildUrl(path, query, base);
    const headers = { "x-goog-api-key": key };
    if (body !== undefined) headers["content-type"] = "application/json";

    const response = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    const raw = await response.text();
    let parsed;
    try { parsed = raw ? JSON.parse(raw) : {}; } catch { parsed = { raw }; }

    if (!response.ok) {
      const message = parsed?.error?.message || parsed?.message || raw || `HTTP ${response.status}`;
      const error = new Error(`Jules API error (${response.status}): ${message}`);
      error.httpStatus = response.status;
      error.apiStatus = parsed?.error?.status;
      error.apiMessage = parsed?.error?.message || parsed?.message || undefined;
      throw error;
    }

    return parsed;
  };
}

function buildUrl(path, query, base) {
  const url = new URL(path.replace(/^\//, ""), `${base.replace(/\/$/, "")}/`);
  if (query && typeof query === "object") {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, String(value));
      }
    }
  }
  return url;
}

// ---------------------------------------------------------------------------
// Utility helpers (pure — no side effects)
// ---------------------------------------------------------------------------

function requireNonEmpty(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Missing required string argument: ${name}`);
  return value.trim();
}

function optionalTrimmed(value) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function normalizePositiveInt(value) {
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

function truncateText(text, maxChars) {
  if (typeof text !== "string") return text;
  if (!maxChars || text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)} …(truncated ${text.length - maxChars} chars)`;
}

function normalizeSourceForSessionCreation(source) {
  const normalized = requireNonEmpty(source, "source");
  if (normalized.startsWith("sources/")) return normalized;
  if (normalized.startsWith("github/")) return `sources/${normalized}`;
  return normalized;
}

function sourceIdPathCandidates(sourceId) {
  const normalized = requireNonEmpty(sourceId, "sourceId");
  const slashId = normalized.replace(/^sources\//, "");
  const candidates = [
    `/sources/${encodeURIComponent(normalized)}`,
    `/sources/${slashId}`,
    `/sources/${encodeURIComponent(slashId)}`,
  ];
  const seen = new Set();
  return candidates.filter((c) => { if (seen.has(c)) return false; seen.add(c); return true; });
}

function withCanonicalSource(source) {
  if (!source || typeof source !== "object") return source;
  const canonicalSource = source?.name || (typeof source?.id === "string" ? `sources/${source.id}` : undefined);
  if (!canonicalSource) return source;
  return { ...source, canonicalSource };
}

function isAdvancedFilterExpression(filter) {
  return /[=<>]|\b(OR|AND|NOT)\b/i.test(filter);
}

function sourceMatchesFilterQuery(source, rawQuery) {
  const query = String(rawQuery || "").toLowerCase();
  if (!query) return true;
  const owner = source?.githubRepo?.owner;
  const repo = source?.githubRepo?.repo;
  const candidates = [source?.name, source?.id, owner, repo, owner && repo ? `${owner}/${repo}` : undefined]
    .filter((v) => typeof v === "string");
  return candidates.some((v) => v.toLowerCase().includes(query));
}

function sanitizeSession(session, options = {}) {
  const compact = options.compact === true;
  const includePrompt = options.includePrompt ?? !compact;
  const includeOutputs = options.includeOutputs ?? !compact;
  const includeSourceContext = options.includeSourceContext ?? !compact;
  const maxPromptChars = normalizePositiveInt(options.maxPromptChars);

  if (!compact && includePrompt && includeOutputs && includeSourceContext && maxPromptChars === undefined) return session;

  const sanitized = compact
    ? { name: session?.name, id: session?.id, title: session?.title, state: session?.state, createTime: session?.createTime, updateTime: session?.updateTime, url: session?.url }
    : { ...session };

  if (compact && session?.sourceContext?.source) sanitized.source = session.sourceContext.source;
  if (includeSourceContext && session?.sourceContext) sanitized.sourceContext = session.sourceContext;
  else if (!compact) delete sanitized.sourceContext;
  if (includePrompt && typeof session?.prompt === "string") sanitized.prompt = truncateText(session.prompt, maxPromptChars);
  else if (!compact) delete sanitized.prompt;
  if (includeOutputs && session?.outputs !== undefined) sanitized.outputs = session.outputs;
  else if (!compact) delete sanitized.outputs;
  if (session?.requirePlanApproval !== undefined) sanitized.requirePlanApproval = session.requirePlanApproval;

  return sanitized;
}

function textResult(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function extractSessionOutputs(session) {
  const outputs = { pullRequests: [], files: [], raw: session?.outputs || [] };
  if (Array.isArray(session?.outputs)) {
    for (const output of session.outputs) {
      if (output?.pullRequest) outputs.pullRequests.push(output.pullRequest);
      if (Array.isArray(output?.files)) outputs.files.push(...output.files);
    }
  }
  return outputs;
}

// ---------------------------------------------------------------------------
// Static data
// ---------------------------------------------------------------------------

const SESSION_STATES = {
  QUEUED: "QUEUED",
  PLANNING: "PLANNING",
  AWAITING_PLAN_APPROVAL: "AWAITING_PLAN_APPROVAL",
  AWAITING_USER_FEEDBACK: "AWAITING_USER_FEEDBACK",
  IN_PROGRESS: "IN_PROGRESS",
  PAUSED: "PAUSED",
  COMPLETED: "COMPLETED",
  FAILED: "FAILED",
};

const TERMINAL_STATES = [SESSION_STATES.COMPLETED, SESSION_STATES.FAILED];

const SESSION_TEMPLATES = {
  add_tests: { title: "Add tests", prompt: "Add comprehensive unit tests for the existing code. Include tests for happy path and edge cases." },
  fix_bug: { title: "Fix bug", prompt: "Identify and fix the bug described. Include a test that verifies the fix. Minimal changes only." },
  refactor: { title: "Refactor for clarity", prompt: "Refactor the code for better readability and maintainability. Keep functionality unchanged." },
  review: { title: "Code review", prompt: "Review the code for best practices, performance issues, and security concerns. Suggest improvements." },
  add_docs: { title: "Add documentation", prompt: "Add clear documentation, comments, and docstrings to the code. Focus on intent and usage." },
};

const ERROR_CATALOG = {
  400: { INVALID_ARGUMENT: { description: "Invalid request parameters", suggestion: "Check required fields and formats. Verify source/sessionId format.", retryable: false } },
  401: { description: "Unauthorized - check API key", suggestion: "Verify JULES_API_KEY is set correctly", retryable: false },
  403: { description: "Forbidden - insufficient permissions", suggestion: "Check if your account has access to this source or session", retryable: false },
  404: { description: "Resource not found", suggestion: "Verify the session/source ID exists and use canonical format", retryable: false },
  429: { description: "Rate limited", suggestion: "Wait before retrying. Consider increasing poll intervals.", retryable: true },
  500: { description: "Server error", suggestion: "The Jules service may be temporarily unavailable. Retry soon.", retryable: true },
  503: { description: "Service unavailable", suggestion: "Jules service is temporarily down. Retry in a few moments.", retryable: true },
};

const TOOL_REFERENCE = {
  jules_list_sources: {
    purpose: "List connected Jules sources (repositories).",
    params: [
      { name: "pageSize", type: "integer", required: false, description: "Number of results per page (1-100).", default: 10, example: 10 },
      { name: "pageToken", type: "string", required: false, description: "Pagination token from previous result.", example: "NEXT_PAGE_TOKEN" },
      { name: "filter", type: "string", required: false, description: "Optional filter. Supports AIP-160 expressions and simple substring matching.", example: "jules-mcp" },
    ],
  },
  jules_get_source: {
    purpose: "Fetch one source by sourceId.",
    params: [{ name: "sourceId", type: "string", required: true, description: "Source identifier. Accepts `github/org/repo` or full `sources/github/org/repo`.", example: "github/myorg/myrepo" }],
  },
  jules_create_session: {
    purpose: "Create a new coding session.",
    params: [
      { name: "prompt", type: "string", required: true, description: "Task instruction for Jules.", example: "Add unit tests for auth middleware" },
      { name: "source", type: "string", required: true, description: "Source resource. Prefer `sources/github/org/repo`.", example: "sources/github-myorg-myrepo" },
      { name: "startingBranch", type: "string", required: false, description: "Branch to start work from.", default: "auto-retry fallback: main, then master", example: "main" },
      { name: "title", type: "string", required: false, description: "Optional session title.", example: "Auth middleware tests" },
      { name: "automationMode", type: "string", required: false, description: "Optional Jules automation mode.", example: "AUTO_CREATE_PR" },
      { name: "requirePlanApproval", type: "boolean", required: false, description: "Require explicit plan approval before execution.", default: false, example: true },
    ],
  },
  jules_list_sessions: {
    purpose: "List sessions with optional compact controls.",
    params: [
      { name: "pageSize", type: "integer", required: false, description: "Number of sessions per page (1-100).", default: 10, example: 5 },
      { name: "pageToken", type: "string", required: false, description: "Pagination token from previous response.", example: "NEXT_PAGE_TOKEN" },
      { name: "compact", type: "boolean", required: false, description: "Return minimal summary fields only.", default: false, example: true },
      { name: "includePrompt", type: "boolean", required: false, description: "Include prompt text in response.", default: "true when compact=false, else false", example: false },
      { name: "includeOutputs", type: "boolean", required: false, description: "Include outputs payloads (can be large).", default: "true when compact=false, else false", example: false },
      { name: "includeSourceContext", type: "boolean", required: false, description: "Include sourceContext object.", default: "true when compact=false, else false", example: false },
      { name: "maxPromptChars", type: "integer", required: false, description: "Truncate prompt to maximum characters (1-20000).", example: 500 },
    ],
  },
  jules_get_session: {
    purpose: "Get one session with optional compact controls.",
    params: [
      { name: "sessionId", type: "string", required: true, description: "Session identifier.", example: "12345678901234567890" },
      { name: "compact", type: "boolean", required: false, description: "Return minimal summary fields only.", default: false, example: true },
      { name: "includePrompt", type: "boolean", required: false, description: "Include prompt text in response.", default: "true when compact=false, else false", example: false },
      { name: "includeOutputs", type: "boolean", required: false, description: "Include outputs payloads (can be large).", default: "true when compact=false, else false", example: false },
      { name: "includeSourceContext", type: "boolean", required: false, description: "Include sourceContext object.", default: "true when compact=false, else false", example: false },
      { name: "maxPromptChars", type: "integer", required: false, description: "Truncate prompt to maximum characters (1-20000).", example: 500 },
    ],
  },
  jules_delete_session: {
    purpose: "Delete one session by sessionId.",
    params: [{ name: "sessionId", type: "string", required: true, description: "Session identifier to delete.", example: "12345678901234567890" }],
  },
  jules_list_activities: {
    purpose: "List activity events for a session.",
    params: [
      { name: "sessionId", type: "string", required: true, description: "Session identifier.", example: "12345678901234567890" },
      { name: "pageSize", type: "integer", required: false, description: "Number of activities per page (1-100).", default: 30, example: 30 },
      { name: "pageToken", type: "string", required: false, description: "Pagination token from previous response.", example: "NEXT_PAGE_TOKEN" },
    ],
  },
  jules_send_message: {
    purpose: "Send follow-up instruction to a session.",
    params: [
      { name: "sessionId", type: "string", required: true, description: "Session identifier.", example: "12345678901234567890" },
      { name: "prompt", type: "string", required: true, description: "Message to send to Jules in that session.", example: "Please include integration tests as well." },
    ],
  },
  jules_approve_plan: {
    purpose: "Approve a waiting plan for a session.",
    params: [{ name: "sessionId", type: "string", required: true, description: "Session identifier waiting for plan approval.", example: "12345678901234567890" }],
  },
  jules_get_skill: {
    purpose: "Return built-in tool and parameter guidance for agents.",
    params: [
      { name: "toolName", type: "string", required: false, description: "Return details for one tool only.", example: "jules_create_session" },
      { name: "compact", type: "boolean", required: false, description: "Return compact summary (tool purpose + required params).", default: false, example: true },
      { name: "includeExamples", type: "boolean", required: false, description: "Include example values in parameter docs.", default: true, example: true },
    ],
  },
  jules_wait_for_session: {
    purpose: "Poll session until terminal state (COMPLETED or FAILED).",
    params: [
      { name: "sessionId", type: "string", required: true, description: "Session identifier to wait for.", example: "12345678901234567890" },
      { name: "timeoutSeconds", type: "integer", required: false, description: "Maximum time to wait (1-3600 seconds).", default: 300, example: 300 },
      { name: "pollIntervalMs", type: "integer", required: false, description: "Time between polls in milliseconds (100-30000).", default: 2000, example: 2000 },
    ],
  },
  jules_get_session_state: {
    purpose: "Quickly check session state without fetching full data.",
    params: [{ name: "sessionId", type: "string", required: true, description: "Session identifier.", example: "12345678901234567890" }],
  },
  jules_list_activities_filtered: {
    purpose: "List session activities with optional type filtering.",
    params: [
      { name: "sessionId", type: "string", required: true, description: "Session identifier.", example: "12345678901234567890" },
      { name: "pageSize", type: "integer", required: false, description: "Number of activities per page (1-100).", default: 30, example: 30 },
      { name: "pageToken", type: "string", required: false, description: "Pagination token from previous response.", example: "NEXT_PAGE_TOKEN" },
      { name: "activityType", type: "string", required: false, description: "Filter by activity type (e.g., ACTIVITY_COMPLETED).", example: "ACTIVITY_COMPLETED" },
    ],
  },
  jules_get_session_output: {
    purpose: "Extract structured outputs (PRs, files) from completed session.",
    params: [
      { name: "sessionId", type: "string", required: true, description: "Session identifier.", example: "12345678901234567890" },
      { name: "outputType", type: "string", required: false, description: 'Output type to extract: "pullRequest", "files", or "all".', default: "all", example: "pullRequest" },
    ],
  },
  jules_health_check: { purpose: "Check Jules API connectivity and health.", params: [] },
  jules_describe_error: {
    purpose: "Parse API error and provide human-readable guidance for recovery.",
    params: [
      { name: "httpStatus", type: "integer", required: false, description: "HTTP status code from failed request.", example: 400 },
      { name: "apiStatus", type: "string", required: false, description: "API error status (e.g., INVALID_ARGUMENT).", example: "INVALID_ARGUMENT" },
      { name: "message", type: "string", required: false, description: "Original error message.", example: "Invalid session ID format" },
    ],
  },
  jules_build_session_prompt: {
    purpose: "Build pre-configured session prompts from templates for common tasks.",
    params: [
      { name: "template", type: "string", required: true, description: 'Template name: "add_tests", "fix_bug", "refactor", "review", or "add_docs".', example: "add_tests" },
      { name: "customTitle", type: "string", required: false, description: "Override template title if needed.", example: "Add unit tests for auth module" },
      { name: "customPrompt", type: "string", required: false, description: "Override template prompt with custom instructions.", example: "Add tests focusing on edge cases" },
      { name: "requirePlanApproval", type: "boolean", required: false, description: "Whether to require plan approval before execution (default: true).", default: true, example: true },
    ],
  },
};

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

/**
 * createServer(apiKey?, baseUrl?)
 *
 * Returns a configured McpServer instance.
 * - apiKey: optional override; if omitted, falls back to process.env.JULES_API_KEY
 * - baseUrl: optional override; if omitted, falls back to process.env.JULES_BASE_URL or default
 *
 * This factory is called once per connection in HTTP mode (stateless),
 * and once at startup in stdio mode.
 */
export function createServer(apiKey, baseUrl) {
  const julesRequest = buildJulesRequest(apiKey, baseUrl);

  // ---- helpers that close over julesRequest --------------------------------

  async function listSourcesWithLocalFilter({ pageSize, pageToken, filter }) {
    const normalizedFilter = optionalTrimmed(filter) || "";
    const requestedPageSize = normalizePositiveInt(pageSize) || 30;
    const apiPageSize = Math.min(100, Math.max(30, requestedPageSize));
    const maxPages = 10;
    let nextPageToken = optionalTrimmed(pageToken);
    let scannedPages = 0;
    const matches = [];
    while (scannedPages < maxPages && matches.length < requestedPageSize) {
      const page = await julesRequest({ path: "/sources", query: { pageSize: apiPageSize, pageToken: nextPageToken } });
      const sources = Array.isArray(page.sources) ? page.sources : [];
      for (const source of sources) {
        if (sourceMatchesFilterQuery(source, normalizedFilter)) {
          matches.push(source);
          if (matches.length >= requestedPageSize) break;
        }
      }
      nextPageToken = optionalTrimmed(page.nextPageToken);
      scannedPages += 1;
      if (!nextPageToken) break;
    }
    return { sources: matches, nextPageToken, filterMode: "local-substring", filterQuery: normalizedFilter, scannedPages };
  }

  async function pollSessionUntilReady(sessionId, timeoutSeconds, pollIntervalMs) {
    const startTime = Date.now();
    const timeoutMs = timeoutSeconds * 1000;
    while (true) {
      const elapsed = Date.now() - startTime;
      if (elapsed > timeoutMs) throw new Error(`Timeout waiting for session ${sessionId} after ${timeoutSeconds}s. Last state may be IN_PROGRESS.`);
      try {
        const session = await julesRequest({ path: `/sessions/${encodeURIComponent(sessionId)}` });
        if (TERMINAL_STATES.includes(session?.state)) return session;
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      } catch (error) {
        if (error?.httpStatus >= 500) await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
        else throw error;
      }
    }
  }

  function buildSkillPayload({ toolName, compact, includeExamples }) {
    const normalizedToolName = optionalTrimmed(toolName);
    const showExamples = includeExamples !== false;
    const toolEntries = normalizedToolName
      ? Object.fromEntries(Object.entries(TOOL_REFERENCE).filter(([name]) => name === normalizedToolName))
      : TOOL_REFERENCE;
    if (normalizedToolName && !toolEntries[normalizedToolName]) throw new Error(`Unknown toolName: ${normalizedToolName}`);
    return {
      server: { name: "jules-mcp-server", version: "0.3.0" },
      focus: "jules-tooling",
      description: "Tool and parameter guidance for agents interacting with Jules.",
      usageHints: [
        "Use source.canonicalSource from jules_list_sources as the jules_create_session source value.",
        "For jules_list_sources, use filter='jules-mcp' for simple substring discovery.",
        "Pass startingBranch explicitly when possible for deterministic session creation.",
        "Use jules_list_sessions with compact=true for discovery.",
        "Use jules_get_session for one session detail.",
        "Enable includeOutputs only when reviewing final generated artifacts.",
      ],
      tools: compact
        ? Object.fromEntries(Object.entries(toolEntries).map(([n, i]) => [n, { purpose: i.purpose, requiredParams: (i.params || []).filter((p) => p.required).map((p) => p.name) }]))
        : Object.fromEntries(Object.entries(toolEntries).map(([n, i]) => [n, { ...i, params: showExamples ? i.params : (i.params || []).map(({ example, ...rest }) => rest) }])),
      compact: compact === true ? true : undefined,
      includeExamples: showExamples,
    };
  }

  function buildSessionTemplate(templateName, customParams = {}) {
    const template = SESSION_TEMPLATES[templateName];
    if (!template) throw new Error(`Unknown template: ${templateName}. Available: ${Object.keys(SESSION_TEMPLATES).join(", ")}`);
    return { title: customParams.title || template.title, prompt: customParams.prompt || template.prompt, requirePlanApproval: customParams.requirePlanApproval !== false };
  }

  // ---- McpServer -----------------------------------------------------------

  const server = new McpServer({ name: "jules-mcp-server", version: "0.3.0" });
  const paginationSchema = { pageSize: z.number().int().min(1).max(100).optional(), pageToken: z.string().optional() };

  server.registerTool("jules_get_skill",
    { description: "Get built-in tool and parameter guidance for agents.", inputSchema: z.object({ toolName: z.string().optional(), compact: z.boolean().optional(), includeExamples: z.boolean().optional() }) },
    async ({ toolName, compact, includeExamples }) => textResult(buildSkillPayload({ toolName, compact, includeExamples }))
  );

  server.registerTool("jules_list_sources",
    { description: "List repositories (sources) connected to Jules.", inputSchema: z.object({ ...paginationSchema, filter: z.string().optional() }) },
    async ({ pageSize, pageToken, filter }) => {
      const normalizedFilter = optionalTrimmed(filter);
      if (!normalizedFilter) {
        const result = await julesRequest({ path: "/sources", query: { pageSize, pageToken } });
        return textResult({ ...result, sources: Array.isArray(result.sources) ? result.sources.map(withCanonicalSource) : result.sources });
      }
      if (!isAdvancedFilterExpression(normalizedFilter)) {
        const result = await listSourcesWithLocalFilter({ pageSize, pageToken, filter: normalizedFilter });
        return textResult({ ...result, sources: Array.isArray(result.sources) ? result.sources.map(withCanonicalSource) : result.sources });
      }
      try {
        const result = await julesRequest({ path: "/sources", query: { pageSize, pageToken, filter: normalizedFilter } });
        return textResult({ ...result, sources: Array.isArray(result.sources) ? result.sources.map(withCanonicalSource) : result.sources });
      } catch (error) {
        if (error?.httpStatus === 400 && error?.apiStatus === "INVALID_ARGUMENT") {
          const result = await listSourcesWithLocalFilter({ pageSize, pageToken, filter: normalizedFilter });
          return textResult({ ...result, sources: Array.isArray(result.sources) ? result.sources.map(withCanonicalSource) : result.sources, warning: "Server-side filter was rejected (INVALID_ARGUMENT). Fallback to local substring filtering was applied." });
        }
        throw error;
      }
    }
  );

  server.registerTool("jules_get_source",
    { description: "Get details for one Jules source by sourceId.", inputSchema: z.object({ sourceId: z.string().min(1) }) },
    async ({ sourceId }) => {
      const candidates = sourceIdPathCandidates(requireNonEmpty(sourceId, "sourceId"));
      let lastError;
      for (const path of candidates) {
        try { return textResult(withCanonicalSource(await julesRequest({ path }))); }
        catch (error) { lastError = error; if (error?.httpStatus !== 404) break; }
      }
      if (lastError?.httpStatus === 404) {
        const fallbackHint = sourceId.startsWith("sources/") ? sourceId.replace(/^sources\//, "") : `sources/${sourceId}`;
        throw new Error(`Source not found: ${sourceId}. Try using the exact value from jules_list_sources.canonicalSource (example: ${fallbackHint}).`);
      }
      throw lastError;
    }
  );

  server.registerTool("jules_create_session",
    { description: "Create a Jules coding session for a prompt and source.", inputSchema: z.object({ prompt: z.string().min(1), source: z.string().min(1), startingBranch: z.string().optional(), title: z.string().optional(), automationMode: z.string().optional(), requirePlanApproval: z.boolean().optional() }) },
    async ({ prompt, source, startingBranch, title, automationMode, requirePlanApproval }) => {
      const normalizedPrompt = requireNonEmpty(prompt, "prompt");
      const normalizedSource = normalizeSourceForSessionCreation(source);
      const body = { prompt: normalizedPrompt, sourceContext: { source: normalizedSource } };
      const normalizedTitle = optionalTrimmed(title);
      const normalizedAutomationMode = optionalTrimmed(automationMode);
      const normalizedStartingBranch = optionalTrimmed(startingBranch);
      if (normalizedTitle) body.title = normalizedTitle;
      if (normalizedAutomationMode) body.automationMode = normalizedAutomationMode;
      if (typeof requirePlanApproval === "boolean") body.requirePlanApproval = requirePlanApproval;
      const tryCreate = async (branchName) => {
        const payload = { ...body, sourceContext: { ...body.sourceContext } };
        if (branchName) payload.sourceContext.githubRepoContext = { startingBranch: branchName };
        return julesRequest({ method: "POST", path: "/sessions", body: payload });
      };
      const branchCandidates = normalizedStartingBranch ? [normalizedStartingBranch] : [undefined, "main", "master"];
      let lastError;
      for (const branch of branchCandidates) {
        try { return textResult(await tryCreate(branch)); }
        catch (error) { lastError = error; if (!(error?.httpStatus === 400 && error?.apiStatus === "INVALID_ARGUMENT")) break; }
      }
      if (lastError?.httpStatus === 400 && lastError?.apiStatus === "INVALID_ARGUMENT") throw new Error(`Session creation failed with INVALID_ARGUMENT for source '${normalizedSource}'. Please set startingBranch explicitly (for example: 'main' or 'master').`);
      throw lastError;
    }
  );

  server.registerTool("jules_list_sessions",
    { description: "List your Jules sessions (supports compact response controls).", inputSchema: z.object({ ...paginationSchema, compact: z.boolean().optional(), includePrompt: z.boolean().optional(), includeOutputs: z.boolean().optional(), includeSourceContext: z.boolean().optional(), maxPromptChars: z.number().int().min(1).max(20000).optional() }) },
    async ({ pageSize, pageToken, compact, includePrompt, includeOutputs, includeSourceContext, maxPromptChars }) => {
      const result = await julesRequest({ path: "/sessions", query: { pageSize, pageToken } });
      return textResult({ ...result, sessions: Array.isArray(result.sessions) ? result.sessions.map((s) => sanitizeSession(s, { compact, includePrompt, includeOutputs, includeSourceContext, maxPromptChars })) : result.sessions });
    }
  );

  server.registerTool("jules_get_session",
    { description: "Get details for a Jules session (supports compact response controls).", inputSchema: z.object({ sessionId: z.string().min(1), compact: z.boolean().optional(), includePrompt: z.boolean().optional(), includeOutputs: z.boolean().optional(), includeSourceContext: z.boolean().optional(), maxPromptChars: z.number().int().min(1).max(20000).optional() }) },
    async ({ sessionId, compact, includePrompt, includeOutputs, includeSourceContext, maxPromptChars }) => {
      const result = await julesRequest({ path: `/sessions/${encodeURIComponent(requireNonEmpty(sessionId, "sessionId"))}` });
      return textResult(sanitizeSession(result, { compact, includePrompt, includeOutputs, includeSourceContext, maxPromptChars }));
    }
  );

  server.registerTool("jules_delete_session",
    { description: "Delete a Jules session.", inputSchema: z.object({ sessionId: z.string().min(1) }) },
    async ({ sessionId }) => textResult(await julesRequest({ method: "DELETE", path: `/sessions/${encodeURIComponent(requireNonEmpty(sessionId, "sessionId"))}` }))
  );

  server.registerTool("jules_list_activities",
    { description: "List activities for a Jules session.", inputSchema: z.object({ sessionId: z.string().min(1), ...paginationSchema }) },
    async ({ sessionId, pageSize, pageToken }) => textResult(await julesRequest({ path: `/sessions/${encodeURIComponent(requireNonEmpty(sessionId, "sessionId"))}/activities`, query: { pageSize, pageToken } }))
  );

  server.registerTool("jules_send_message",
    { description: "Send a follow-up message to an active Jules session.", inputSchema: z.object({ sessionId: z.string().min(1), prompt: z.string().min(1) }) },
    async ({ sessionId, prompt }) => textResult(await julesRequest({ method: "POST", path: `/sessions/${encodeURIComponent(requireNonEmpty(sessionId, "sessionId"))}:sendMessage`, body: { prompt: requireNonEmpty(prompt, "prompt") } }))
  );

  server.registerTool("jules_approve_plan",
    { description: "Approve plan for a session waiting on plan approval.", inputSchema: z.object({ sessionId: z.string().min(1) }) },
    async ({ sessionId }) => textResult(await julesRequest({ method: "POST", path: `/sessions/${encodeURIComponent(requireNonEmpty(sessionId, "sessionId"))}:approvePlan`, body: {} }))
  );

  server.registerTool("jules_wait_for_session",
    { description: "Poll a session until it reaches a terminal state (COMPLETED or FAILED). Returns the final session object.", inputSchema: z.object({ sessionId: z.string().min(1), timeoutSeconds: z.number().int().min(1).max(3600).optional(), pollIntervalMs: z.number().int().min(100).max(30000).optional() }) },
    async ({ sessionId, timeoutSeconds = 300, pollIntervalMs = 2000 }) => textResult(await pollSessionUntilReady(requireNonEmpty(sessionId, "sessionId"), timeoutSeconds, pollIntervalMs))
  );

  server.registerTool("jules_get_session_state",
    { description: "Get the current state of a session without fetching full data.", inputSchema: z.object({ sessionId: z.string().min(1) }) },
    async ({ sessionId }) => {
      const result = await julesRequest({ path: `/sessions/${encodeURIComponent(requireNonEmpty(sessionId, "sessionId"))}` });
      return textResult({ id: result?.id, name: result?.name, state: result?.state, title: result?.title, updateTime: result?.updateTime });
    }
  );

  server.registerTool("jules_list_activities_filtered",
    { description: "List activities for a session with optional type filtering.", inputSchema: z.object({ sessionId: z.string().min(1), pageSize: z.number().int().min(1).max(100).optional(), pageToken: z.string().optional(), activityType: z.string().optional().describe("Filter by activity type: ACTIVITY_QUEUED, ACTIVITY_RUNNING, ACTIVITY_COMPLETED, etc.") }) },
    async ({ sessionId, pageSize, pageToken, activityType }) => {
      const result = await julesRequest({ path: `/sessions/${encodeURIComponent(requireNonEmpty(sessionId, "sessionId"))}/activities`, query: { pageSize, pageToken } });
      let activities = Array.isArray(result.activities) ? result.activities : [];
      if (activityType) activities = activities.filter((a) => a?.type === activityType);
      return textResult({ ...result, activities, filterApplied: { type: activityType || null, matchCount: activities.length } });
    }
  );

  server.registerTool("jules_get_session_output",
    { description: "Extract structured outputs from a completed session (pull requests, files, etc.).", inputSchema: z.object({ sessionId: z.string().min(1), outputType: z.enum(["pullRequest", "files", "all"]).optional().default("all") }) },
    async ({ sessionId, outputType }) => {
      const session = await julesRequest({ path: `/sessions/${encodeURIComponent(requireNonEmpty(sessionId, "sessionId"))}` });
      const extracted = extractSessionOutputs(session);
      const result = { sessionId, state: session?.state };
      if (outputType === "pullRequest" || outputType === "all") result.pullRequests = extracted.pullRequests;
      if (outputType === "files" || outputType === "all") result.files = extracted.files;
      return textResult(result);
    }
  );

  server.registerTool("jules_health_check",
    { description: "Check Jules API connectivity and basic health without requiring a session.", inputSchema: z.object({}) },
    async () => {
      try {
        await julesRequest({ path: "/sources", query: { pageSize: 1 } });
        return textResult({ status: "healthy", apiReachable: true, version: "0.3.0", timestamp: new Date().toISOString() });
      } catch (error) {
        return textResult({ status: "unhealthy", apiReachable: false, version: "0.3.0", error: error?.message || String(error), timestamp: new Date().toISOString() });
      }
    }
  );

  server.registerTool("jules_describe_error",
    { description: "Parse and contextualize an API error to help agents understand and recover.", inputSchema: z.object({ httpStatus: z.number().int().optional(), apiStatus: z.string().optional(), message: z.string().optional() }) },
    async ({ httpStatus, apiStatus, message }) => {
      const catalog = ERROR_CATALOG[httpStatus] || {};
      const details = typeof catalog === "object" && apiStatus ? catalog[apiStatus] : catalog;
      return textResult({ httpStatus, apiStatus, originalMessage: message, description: details?.description, suggestion: details?.suggestion, retryable: details?.retryable ?? false });
    }
  );

  server.registerTool("jules_build_session_prompt",
    { description: "Build a pre-configured session prompt from common templates (add_tests, fix_bug, refactor, review, add_docs).", inputSchema: z.object({ template: z.enum(["add_tests", "fix_bug", "refactor", "review", "add_docs"]), customTitle: z.string().optional(), customPrompt: z.string().optional(), requirePlanApproval: z.boolean().optional() }) },
    async ({ template, customTitle, customPrompt, requirePlanApproval }) => textResult(buildSessionTemplate(template, { title: customTitle, prompt: customPrompt, requirePlanApproval }))
  );

  return server;
}
