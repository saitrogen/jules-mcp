/**
 * perplexity.js — Jules MCP Server for Perplexity
 *
 * PRIMARY TRANSPORT: Legacy SSE (confirmed working with Perplexity)
 *   GET  /sse          → opens SSE stream, sends endpoint event
 *   POST /messages     → client posts JSON-RPC here, response pushed via SSE
 *
 * SECONDARY TRANSPORT: Streamable HTTP (fallback)
 *   POST /mcp
 *
 * Perplexity connector config:
 *   URL:  https://jules-mcp.saitrogen.deno.net/sse
 *   Auth: API Key → Header: Authorization, Value: Bearer <your-jules-api-key>
 *
 * The Jules API key is forwarded to Google Jules API per request.
 */

const SERVER_NAME    = "jules-mcp";
const SERVER_VERSION = "2.0.0";
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
// Tools
// ---------------------------------------------------------------------------
const TOOLS = [
  {
    name: "jules_health_check",
    description: "Check Jules API connectivity and health.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "jules_list_sources",
    description: "List GitHub repositories (sources) connected to Jules.",
    inputSchema: {
      type: "object",
      properties: {
        pageSize:  { type: "integer", description: "Results per page (1-100)" },
        pageToken: { type: "string",  description: "Pagination token" },
        filter:    { type: "string",  description: "Substring filter on repo name/owner" },
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
        sourceId: { type: "string", description: "e.g. github/myorg/myrepo" },
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
        prompt:              { type: "string",  description: "Task for Jules to perform" },
        source:              { type: "string",  description: "Source resource, e.g. sources/github/myorg/myrepo" },
        startingBranch:      { type: "string",  description: "Branch to start from (e.g. main)" },
        title:               { type: "string",  description: "Optional session title" },
        requirePlanApproval: { type: "boolean", description: "Require plan approval before coding" },
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
        pageSize:  { type: "integer", description: "Results per page (1-100)" },
        pageToken: { type: "string",  description: "Pagination token" },
      },
      required: [],
    },
  },
  {
    name: "jules_get_session",
    description: "Get full details for a Jules session.",
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
        sessionId:  { type: "string", description: "Session identifier" },
        outputType: { type: "string", enum: ["pullRequest", "files", "all"] },
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
        sessionId: { type: "string",  description: "Session identifier" },
        pageSize:  { type: "integer", description: "Results per page (1-100)" },
        pageToken: { type: "string",  description: "Pagination token" },
      },
      required: ["sessionId"],
    },
  },
  {
    name: "jules_send_message",
    description: "Send a follow-up message to an active Jules session.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "Session identifier" },
        prompt:    { type: "string", description: "Follow-up instruction" },
      },
      required: ["sessionId", "prompt"],
    },
  },
  {
    name: "jules_approve_plan",
    description: "Approve a Jules session plan awaiting approval before coding starts.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "Session identifier" },
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
        sessionId: { type: "string", description: "Session identifier" },
      },
      required: ["sessionId"],
    },
  },
];

// ---------------------------------------------------------------------------
// Tool runner
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
      const { pageSize, pageToken, filter } = args;
      const result = await julesRequest(apiKey, { path: "/sources", query: { pageSize, pageToken } });
      let sources = Array.isArray(result.sources) ? result.sources.map(withCanonical) : [];
      if (filter) {
        const q = String(filter).toLowerCase();
        sources = sources.filter(s =>
          [s?.name, s?.id, s?.githubRepo?.owner, s?.githubRepo?.repo]
            .filter(Boolean).some(v => String(v).toLowerCase().includes(q))
        );
      }
      return ok({ ...result, sources });
    }

    case "jules_get_source": {
      const { sourceId } = args;
      if (!sourceId) throw new Error("sourceId is required");
      const raw = String(sourceId).replace(/^sources\//, "");
      for (const path of [`/sources/${raw}`, `/sources/${encodeURIComponent(raw)}`]) {
        try { return ok(withCanonical(await julesRequest(apiKey, { path }))); }
        catch (e) { if (e?.httpStatus !== 404) throw e; }
      }
      throw new Error(`Source not found: ${sourceId}`);
    }

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

    case "jules_list_sessions": {
      const { pageSize, pageToken } = args;
      return ok(await julesRequest(apiKey, { path: "/sessions", query: { pageSize, pageToken } }));
    }

    case "jules_get_session": {
      const { sessionId } = args;
      if (!sessionId) throw new Error("sessionId is required");
      return ok(await julesRequest(apiKey, { path: `/sessions/${encodeURIComponent(sessionId)}` }));
    }

    case "jules_get_session_state": {
      const { sessionId } = args;
      if (!sessionId) throw new Error("sessionId is required");
      const s = await julesRequest(apiKey, { path: `/sessions/${encodeURIComponent(sessionId)}` });
      return ok({ id: s?.id, name: s?.name, state: s?.state, title: s?.title, updateTime: s?.updateTime });
    }

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

    case "jules_list_activities": {
      const { sessionId, pageSize, pageToken } = args;
      if (!sessionId) throw new Error("sessionId is required");
      return ok(await julesRequest(apiKey, {
        path: `/sessions/${encodeURIComponent(sessionId)}/activities`,
        query: { pageSize, pageToken },
      }));
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
      return ok(await julesRequest(apiKey, {
        method: "POST", path: `/sessions/${encodeURIComponent(sessionId)}:approvePlan`, body: {},
      }));
    }

    case "jules_delete_session": {
      const { sessionId } = args;
      if (!sessionId) throw new Error("sessionId is required");
      return ok(await julesRequest(apiKey, {
        method: "DELETE", path: `/sessions/${encodeURIComponent(sessionId)}`,
      }));
    }

    default:
      throw Object.assign(new Error(`Unknown tool: ${name}`), { code: -32601 });
  }
}

// ---------------------------------------------------------------------------
// JSON-RPC dispatcher
// apiKey is extracted per-request and injected here
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
        if (!apiKey) return { jsonrpc: "2.0", id, error: { code: -32001, message: "Jules API key required. Set Authorization: Bearer <key> on the connector." } };
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
// Helpers
// ---------------------------------------------------------------------------
function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...CORS, ...extra },
  });
}

function sseMsg(data) {
  return `event: message\ndata: ${JSON.stringify(data)}\n\n`;
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
// Main handler
// ---------------------------------------------------------------------------
async function handle(req) {
  const url  = new URL(req.url);
  const path = url.pathname;

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  if (path === "/" || path === "/health") {
    return json({
      server: SERVER_NAME, version: SERVER_VERSION, protocol: PROTO_V, status: "ok",
      transports: {
        primary:   "Legacy SSE → GET /sse then POST /messages",
        secondary: "Streamable HTTP → POST /mcp",
      },
      perplexity_connector_url: "/sse",
      tools: TOOLS.map(t => t.name),
    });
  }

  // =========================================================================
  // PRIMARY: LEGACY SSE TRANSPORT
  // =========================================================================

  // 1. Client opens stream
  if (path === "/sse" && req.method === "GET") {
    const clientId    = crypto.randomUUID();
    const apiKey      = extractApiKey(req); // capture key at connect time
    const origin      = url.origin;
    const messagesUrl = `${origin}/messages?clientId=${clientId}`;

    const stream = new ReadableStream({
      start(ctrl) {
        sseClients.set(clientId, { controller: ctrl, apiKey });
        // MCP SSE spec: first event must be "endpoint"
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
      headers: {
        "content-type":  "text/event-stream",
        "cache-control": "no-cache",
        "connection":    "keep-alive",
        ...CORS,
      },
    });
  }

  // 2. Client posts JSON-RPC messages
  if (path === "/messages" && req.method === "POST") {
    const clientId = url.searchParams.get("clientId");
    const client   = sseClients.get(clientId);

    // API key: prefer from current request, fall back to key stored at SSE connect
    const apiKey = extractApiKey(req) || client?.apiKey || "";

    let rpc;
    try { rpc = await req.json(); }
    catch {
      if (clientId && client) {
        pushSSE(clientId, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      }
      return new Response(null, { status: 202, headers: CORS });
    }

    // Handle batch
    const rpcs = Array.isArray(rpc) ? rpc : [rpc];
    for (const r of rpcs) {
      const result = await dispatch(apiKey, r);
      if (result !== null && clientId && client) {
        pushSSE(clientId, result);
      }
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

  return json({ error: "Not found", hint: "Try GET /health" }, 404);
}

Deno.serve(handle);
console.log(`\n🔧 ${SERVER_NAME} v${SERVER_VERSION}`);
console.log(`   ✅ PRIMARY   → GET  /sse  (Perplexity connector URL)`);
console.log(`   ✅ SECONDARY → POST /mcp  (Streamable HTTP)`);
console.log(`   ✅ HEALTH    → GET  /health\n`);
