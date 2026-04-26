/**
 * perplexity.js — Jules MCP server built specifically for Perplexity remote connectors.
 *
 * Design decisions (learned from failed SDK transport attempts):
 *  - NO MCP SDK transport layer (SSEServerTransport / StreamableHTTPServerTransport)
 *    Those always return text/event-stream. Perplexity's connector validator expects
 *    application/json and fails with FETCHER_HTML_STATUS_CODE_ERROR on SSE.
 *  - Implements MCP JSON-RPC 2.0 directly: parse request → dispatch → return JSON.
 *  - Stateless per-request. No session IDs, no persistent connections.
 *  - Single Deno Deploy entrypoint. Set this as the entrypoint in deno.json for the
 *    Perplexity-facing deployment, OR deploy as a separate Deno Deploy project.
 *
 * Perplexity connector config:
 *   URL:        https://<your-project>.deno.dev/mcp
 *   Auth type:  Bearer token
 *   Token:      <your Jules API key>
 *
 * Deno Deploy setup:
 *   1. Fork / push this file to your repo
 *   2. Create a new Deno Deploy project pointing to this file as entrypoint
 *   3. No env vars needed — Jules API key comes from the Authorization header
 */

const SERVER_NAME = "jules-mcp-perplexity";
const SERVER_VERSION = "1.0.0";
const PROTOCOL_VERSION = "2024-11-05";
const JULES_BASE_URL = "https://jules.googleapis.com/v1alpha";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Accept",
};

// ---------------------------------------------------------------------------
// Jules API client
// ---------------------------------------------------------------------------

async function julesRequest(apiKey, { method = "GET", path, query, body }) {
  const url = new URL(path.replace(/^\//, ""), JULES_BASE_URL.replace(/\/$/, "") + "/");
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
    err.apiStatus = parsed?.error?.status;
    throw err;
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Tool definitions (what Perplexity sees in tools/list)
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: "jules_health_check",
    description: "Check Jules API connectivity and basic health.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "jules_list_sources",
    description: "List GitHub repositories (sources) connected to Jules.",
    inputSchema: {
      type: "object",
      properties: {
        pageSize: { type: "integer", description: "Results per page (1-100)", minimum: 1, maximum: 100 },
        pageToken: { type: "string", description: "Pagination token from previous response" },
        filter: { type: "string", description: "Substring filter on repo name/owner" },
      },
      required: [],
    },
  },
  {
    name: "jules_get_source",
    description: "Get details for one Jules source by sourceId.",
    inputSchema: {
      type: "object",
      properties: {
        sourceId: { type: "string", description: "Source ID, e.g. github/myorg/myrepo or sources/github/myorg/myrepo" },
      },
      required: ["sourceId"],
    },
  },
  {
    name: "jules_create_session",
    description: "Create a Jules AI coding session for a task prompt on a repository.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Task instruction for Jules (what to code / fix / review)" },
        source: { type: "string", description: "Source resource, e.g. sources/github/myorg/myrepo" },
        startingBranch: { type: "string", description: "Branch to start work from (e.g. main)" },
        title: { type: "string", description: "Optional session title" },
        requirePlanApproval: { type: "boolean", description: "Require plan approval before Jules starts coding" },
      },
      required: ["prompt", "source"],
    },
  },
  {
    name: "jules_list_sessions",
    description: "List your Jules coding sessions.",
    inputSchema: {
      type: "object",
      properties: {
        pageSize: { type: "integer", description: "Results per page (1-100)", minimum: 1, maximum: 100 },
        pageToken: { type: "string", description: "Pagination token from previous response" },
      },
      required: [],
    },
  },
  {
    name: "jules_get_session",
    description: "Get details for a Jules coding session by sessionId.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "Session identifier" },
      },
      required: ["sessionId"],
    },
  },
  {
    name: "jules_get_session_state",
    description: "Quickly check the state of a Jules session (QUEUED, IN_PROGRESS, COMPLETED, FAILED, etc).",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "Session identifier" },
      },
      required: ["sessionId"],
    },
  },
  {
    name: "jules_get_session_output",
    description: "Extract pull requests and files from a completed Jules session.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "Session identifier" },
        outputType: { type: "string", enum: ["pullRequest", "files", "all"], description: "What to extract" },
      },
      required: ["sessionId"],
    },
  },
  {
    name: "jules_list_activities",
    description: "List activity events for a Jules session.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "Session identifier" },
        pageSize: { type: "integer", description: "Results per page (1-100)", minimum: 1, maximum: 100 },
        pageToken: { type: "string", description: "Pagination token from previous response" },
      },
      required: ["sessionId"],
    },
  },
  {
    name: "jules_send_message",
    description: "Send a follow-up message or instruction to an active Jules session.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "Session identifier" },
        prompt: { type: "string", description: "Follow-up instruction to send" },
      },
      required: ["sessionId", "prompt"],
    },
  },
  {
    name: "jules_approve_plan",
    description: "Approve a Jules session plan that is awaiting approval before coding starts.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "Session identifier waiting for plan approval" },
      },
      required: ["sessionId"],
    },
  },
  {
    name: "jules_delete_session",
    description: "Delete a Jules session.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "Session identifier to delete" },
      },
      required: ["sessionId"],
    },
  },
];

// ---------------------------------------------------------------------------
// Tool handlers
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

async function runTool(apiKey, name, args) {
  switch (name) {
    case "jules_health_check": {
      try {
        await julesRequest(apiKey, { path: "/sources", query: { pageSize: 1 } });
        return ok({ status: "healthy", apiReachable: true, version: SERVER_VERSION, timestamp: new Date().toISOString() });
      } catch (e) {
        return ok({ status: "unhealthy", apiReachable: false, error: e?.message, timestamp: new Date().toISOString() });
      }
    }

    case "jules_list_sources": {
      const { pageSize, pageToken, filter } = args ?? {};
      const result = await julesRequest(apiKey, { path: "/sources", query: { pageSize, pageToken } });
      let sources = Array.isArray(result.sources) ? result.sources.map(withCanonical) : [];
      if (filter) {
        const q = String(filter).toLowerCase();
        sources = sources.filter((s) => {
          return [s?.name, s?.id, s?.githubRepo?.owner, s?.githubRepo?.repo]
            .filter(Boolean).some((v) => String(v).toLowerCase().includes(q));
        });
      }
      return ok({ ...result, sources });
    }

    case "jules_get_source": {
      const { sourceId } = args ?? {};
      if (!sourceId) throw new Error("sourceId is required");
      const raw = String(sourceId).replace(/^sources\//, "");
      for (const path of [`/sources/${raw}`, `/sources/${encodeURIComponent(raw)}`]) {
        try { return ok(withCanonical(await julesRequest(apiKey, { path }))); }
        catch (e) { if (e?.httpStatus !== 404) throw e; }
      }
      throw new Error(`Source not found: ${sourceId}`);
    }

    case "jules_create_session": {
      const { prompt, source, startingBranch, title, requirePlanApproval } = args ?? {};
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

    case "jules_list_sessions": {
      const { pageSize, pageToken } = args ?? {};
      return ok(await julesRequest(apiKey, { path: "/sessions", query: { pageSize, pageToken } }));
    }

    case "jules_get_session": {
      const { sessionId } = args ?? {};
      if (!sessionId) throw new Error("sessionId is required");
      return ok(await julesRequest(apiKey, { path: `/sessions/${encodeURIComponent(sessionId)}` }));
    }

    case "jules_get_session_state": {
      const { sessionId } = args ?? {};
      if (!sessionId) throw new Error("sessionId is required");
      const s = await julesRequest(apiKey, { path: `/sessions/${encodeURIComponent(sessionId)}` });
      return ok({ id: s?.id, name: s?.name, state: s?.state, title: s?.title, updateTime: s?.updateTime });
    }

    case "jules_get_session_output": {
      const { sessionId, outputType = "all" } = args ?? {};
      if (!sessionId) throw new Error("sessionId is required");
      const session = await julesRequest(apiKey, { path: `/sessions/${encodeURIComponent(sessionId)}` });
      const { pullRequests, files } = extractOutputs(session);
      const result = { sessionId, state: session?.state };
      if (outputType === "pullRequest" || outputType === "all") result.pullRequests = pullRequests;
      if (outputType === "files" || outputType === "all") result.files = files;
      return ok(result);
    }

    case "jules_list_activities": {
      const { sessionId, pageSize, pageToken } = args ?? {};
      if (!sessionId) throw new Error("sessionId is required");
      return ok(await julesRequest(apiKey, { path: `/sessions/${encodeURIComponent(sessionId)}/activities`, query: { pageSize, pageToken } }));
    }

    case "jules_send_message": {
      const { sessionId, prompt } = args ?? {};
      if (!sessionId) throw new Error("sessionId is required");
      if (!prompt) throw new Error("prompt is required");
      return ok(await julesRequest(apiKey, { method: "POST", path: `/sessions/${encodeURIComponent(sessionId)}:sendMessage`, body: { prompt } }));
    }

    case "jules_approve_plan": {
      const { sessionId } = args ?? {};
      if (!sessionId) throw new Error("sessionId is required");
      return ok(await julesRequest(apiKey, { method: "POST", path: `/sessions/${encodeURIComponent(sessionId)}:approvePlan`, body: {} }));
    }

    case "jules_delete_session": {
      const { sessionId } = args ?? {};
      if (!sessionId) throw new Error("sessionId is required");
      return ok(await julesRequest(apiKey, { method: "DELETE", path: `/sessions/${encodeURIComponent(sessionId)}` }));
    }

    default:
      throw Object.assign(new Error(`Unknown tool: ${name}`), { code: -32601 });
  }
}

// ---------------------------------------------------------------------------
// MCP JSON-RPC dispatcher
// ---------------------------------------------------------------------------

async function dispatch(apiKey, rpc) {
  const id = rpc?.id ?? null;

  try {
    switch (rpc?.method) {
      case "initialize":
        return {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          },
        };

      case "notifications/initialized":
        // Notification — no response needed, return null to skip sending
        return null;

      case "tools/list":
        return {
          jsonrpc: "2.0",
          id,
          result: { tools: TOOLS },
        };

      case "tools/call": {
        const { name, arguments: args } = rpc?.params ?? {};
        if (!name) {
          return jsonRpcError(id, -32602, "tools/call requires params.name");
        }
        const result = await runTool(apiKey, name, args ?? {});
        return { jsonrpc: "2.0", id, result };
      }

      case "ping":
        return { jsonrpc: "2.0", id, result: {} };

      default:
        return jsonRpcError(id, -32601, `Method not found: ${rpc?.method}`);
    }
  } catch (err) {
    const code = err?.code ?? -32603;
    return jsonRpcError(id, code, err?.message ?? String(err));
  }
}

function jsonRpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...CORS },
  });
}

async function handle(request) {
  const url = new URL(request.url);

  // Health check
  if (url.pathname === "/" || url.pathname === "/health") {
    return json({ status: "ok", server: SERVER_NAME, version: SERVER_VERSION });
  }

  // CORS preflight
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }

  // MCP endpoint
  if (url.pathname === "/mcp") {
    if (request.method !== "POST") {
      return json({ error: "POST required" }, 405);
    }

    // Auth
    const auth = request.headers.get("authorization") ?? "";
    const apiKey = auth.toLowerCase().startsWith("bearer ")
      ? auth.slice(7).trim()
      : (request.headers.get("x-api-key") ?? "").trim();

    if (!apiKey) {
      return json(
        { jsonrpc: "2.0", id: null, error: { code: -32001, message: "Missing Jules API key. Set Authorization: Bearer <key> in connector settings." } },
        401
      );
    }

    // Parse body
    let rpc;
    try {
      rpc = await request.json();
    } catch {
      return json(jsonRpcError(null, -32700, "Parse error: invalid JSON"), 400);
    }

    // Batch support (array of requests)
    if (Array.isArray(rpc)) {
      const results = await Promise.all(
        rpc.map((r) => dispatch(apiKey, r))
      );
      const filtered = results.filter(Boolean);
      return json(filtered.length === 1 ? filtered[0] : filtered);
    }

    const result = await dispatch(apiKey, rpc);
    if (result === null) return new Response(null, { status: 204, headers: CORS });
    return json(result);
  }

  return json({ error: "Not found" }, 404);
}

Deno.serve(handle);
console.log(`${SERVER_NAME} v${SERVER_VERSION} running`);
