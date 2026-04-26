/**
 * perplexity.js — Minimal Weather MCP
 * Supports BOTH transport types Perplexity might use:
 *
 *  1. LEGACY SSE TRANSPORT (old spec, pre-2025-03-26)
 *     GET  /sse          → opens SSE stream, sends endpoint event
 *     POST /messages     → client posts JSON-RPC here
 *
 *  2. STREAMABLE HTTP TRANSPORT (new spec, 2025-03-26)
 *     POST /mcp          → all JSON-RPC goes here, reply is JSON or SSE
 *     GET  /mcp          → optional server-push stream
 *     DELETE /mcp        → session teardown
 *
 * Tools exposed:
 *   - get_weather(city: string) → fake static weather data
 *   - ping() → just returns pong
 *
 * Auth: Optional bearer token (accepts anything if no AUTH_KEY env set)
 *
 * Connector config in Perplexity:
 *   Try 1: URL = https://jules-mcp.saitrogen.deno.net/sse   (legacy SSE)
 *   Try 2: URL = https://jules-mcp.saitrogen.deno.net/mcp   (streamable HTTP)
 */

const SERVER_NAME    = "weather-mcp";
const SERVER_VERSION = "1.0.0";
const PROTO_V        = "2025-03-26";
const AUTH_KEY       = Deno.env.get("AUTH_KEY") ?? ""; // leave blank = no auth

// ---------------------------------------------------------------------------
// CORS headers (Perplexity calls from browser context)
// ---------------------------------------------------------------------------
const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, Accept, Mcp-Session-Id, Last-Event-Id, X-Api-Key",
  "Access-Control-Expose-Headers": "Mcp-Session-Id",
};

// ---------------------------------------------------------------------------
// Session store (Streamable HTTP only)
// ---------------------------------------------------------------------------
const sessions = new Map(); // id → { created, key }

function mkSession() {
  const id = crypto.randomUUID();
  sessions.set(id, { created: Date.now() });
  return id;
}

// ---------------------------------------------------------------------------
// Auth check
// ---------------------------------------------------------------------------
function authorized(req) {
  if (!AUTH_KEY) return true; // no auth configured → allow all
  const auth  = req.headers.get("authorization") ?? "";
  const xkey  = req.headers.get("x-api-key") ?? "";
  const token = auth.toLowerCase().startsWith("bearer ")
    ? auth.slice(7).trim()
    : xkey.trim();
  return token === AUTH_KEY;
}

// ---------------------------------------------------------------------------
// Tool registry
// ---------------------------------------------------------------------------
const TOOLS = [
  {
    name: "get_weather",
    description: "Get current weather for a city. Returns fake static data for testing.",
    inputSchema: {
      type: "object",
      properties: {
        city: { type: "string", description: "City name, e.g. London" },
      },
      required: ["city"],
    },
  },
  {
    name: "ping",
    description: "Health check — returns pong.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
];

const FAKE_WEATHER = {
  london: { temp_c: 12, condition: "Cloudy",  humidity: 78, wind_kph: 20 },
  paris:  { temp_c: 15, condition: "Sunny",   humidity: 60, wind_kph: 10 },
  tokyo:  { temp_c: 22, condition: "Rainy",   humidity: 85, wind_kph: 15 },
  mumbai: { temp_c: 33, condition: "Hot",     humidity: 90, wind_kph: 12 },
  dubai:  { temp_c: 38, condition: "Clear",   humidity: 40, wind_kph: 18 },
};

function runTool(name, args) {
  if (name === "ping") {
    return { content: [{ type: "text", text: JSON.stringify({ pong: true, ts: new Date().toISOString() }) }] };
  }
  if (name === "get_weather") {
    const city = String(args?.city ?? "").toLowerCase().trim();
    const data = FAKE_WEATHER[city] ?? {
      temp_c: 20, condition: "Unknown", humidity: 65, wind_kph: 14,
      note: `No data for "${args?.city}" — using defaults`,
    };
    return { content: [{ type: "text", text: JSON.stringify({ city: args?.city, ...data }, null, 2) }] };
  }
  throw Object.assign(new Error(`Unknown tool: ${name}`), { code: -32601 });
}

// ---------------------------------------------------------------------------
// JSON-RPC dispatcher (shared by both transports)
// ---------------------------------------------------------------------------
function dispatch(rpc) {
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
        return null; // no response needed

      case "tools/list":
        return { jsonrpc: "2.0", id, result: { tools: TOOLS } };

      case "tools/call": {
        const { name, arguments: toolArgs } = rpc?.params ?? {};
        if (!name) return { jsonrpc: "2.0", id, error: { code: -32602, message: "params.name required" } };
        const result = runTool(name, toolArgs ?? {});
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

function sseMsg(data) {
  return data === null ? "" : `event: message\ndata: ${JSON.stringify(data)}\n\n`;
}

function sseResp(data, extra = {}) {
  return new Response(sseMsg(data), {
    status: 200,
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache", ...CORS, ...extra },
  });
}

function wantsSSE(req) {
  return (req.headers.get("accept") ?? "").includes("text/event-stream");
}

// ---------------------------------------------------------------------------
// SSE client registry (legacy transport — server-push streams)
// ---------------------------------------------------------------------------
const sseClients = new Map(); // clientId → ReadableStreamController

function pushToSSEClient(clientId, data) {
  const ctrl = sseClients.get(clientId);
  if (!ctrl) return;
  try { ctrl.enqueue(new TextEncoder().encode(sseMsg(data))); } catch { sseClients.delete(clientId); }
}

// ---------------------------------------------------------------------------
// MAIN HANDLER
// ---------------------------------------------------------------------------
async function handle(req) {
  const url = new URL(req.url);
  const path = url.pathname;

  // CORS preflight
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  // Health / root
  if (path === "/" || path === "/health") {
    return json({
      server: SERVER_NAME, version: SERVER_VERSION,
      protocol: PROTO_V, status: "ok",
      endpoints: {
        legacy_sse:       "GET  /sse  (old SSE transport)",
        legacy_messages:  "POST /messages  (old SSE transport)",
        streamable_http:  "POST /mcp  (new Streamable HTTP transport)",
      },
      tools: TOOLS.map(t => t.name),
    });
  }

  // Auth gate (for non-health endpoints)
  if (!authorized(req)) {
    return json({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "Unauthorized" } }, 401);
  }

  // =========================================================================
  // TRANSPORT 1: LEGACY SSE  (GET /sse + POST /messages)
  // Perplexity UI hint: URL = https://your-server.com/sse
  // =========================================================================

  if (path === "/sse" && req.method === "GET") {
    const clientId = crypto.randomUUID();
    // Build the messages endpoint URL for this client
    const origin = url.origin;
    const messagesUrl = `${origin}/messages?clientId=${clientId}`;

    const stream = new ReadableStream({
      start(ctrl) {
        sseClients.set(clientId, ctrl);
        // MCP SSE spec: first event must be "endpoint" with the POST URL
        const endpointEvent = `event: endpoint\ndata: ${messagesUrl}\n\n`;
        ctrl.enqueue(new TextEncoder().encode(endpointEvent));
        console.log(`[SSE] client ${clientId} connected`);
      },
      cancel() {
        sseClients.delete(clientId);
        console.log(`[SSE] client ${clientId} disconnected`);
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
        ...CORS,
      },
    });
  }

  if (path === "/messages" && req.method === "POST") {
    const clientId = url.searchParams.get("clientId");
    let rpc;
    try { rpc = await req.json(); } catch {
      return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400);
    }

    const result = dispatch(rpc);
    if (result !== null && clientId && sseClients.has(clientId)) {
      pushToSSEClient(clientId, result);
    }
    return new Response(null, { status: 202, headers: CORS });
  }

  // =========================================================================
  // TRANSPORT 2: STREAMABLE HTTP  (POST/GET/DELETE /mcp)
  // Perplexity UI hint: URL = https://your-server.com/mcp
  // =========================================================================

  if (path === "/mcp" && req.method === "DELETE") {
    const sid = req.headers.get("mcp-session-id");
    if (sid && sessions.has(sid)) {
      sessions.delete(sid);
      return new Response(null, { status: 200, headers: CORS });
    }
    return json({ error: "Session not found" }, 404);
  }

  if (path === "/mcp" && req.method === "GET") {
    const sid = req.headers.get("mcp-session-id");
    if (!sid || !sessions.has(sid)) {
      return json({ error: "Missing or invalid Mcp-Session-Id" }, 400);
    }
    return new Response("", {
      status: 200,
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache", "mcp-session-id": sid, ...CORS },
    });
  }

  if (path === "/mcp" && req.method === "POST") {
    let rpc;
    try { rpc = await req.json(); } catch {
      return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400);
    }

    const isInit = Array.isArray(rpc)
      ? rpc.some(r => r?.method === "initialize")
      : rpc?.method === "initialize";

    const incomingSid = req.headers.get("mcp-session-id");
    let sessionId;

    if (isInit) {
      sessionId = mkSession();
    } else {
      if (!incomingSid || !sessions.has(incomingSid)) {
        return json(
          { jsonrpc: "2.0", id: null, error: { code: -32600, message: incomingSid ? `Unknown session: ${incomingSid}` : "Mcp-Session-Id header required" } },
          400
        );
      }
      sessionId = incomingSid;
    }

    const sessionHeader = { "mcp-session-id": sessionId };

    if (Array.isArray(rpc)) {
      const results = (await Promise.all(rpc.map(r => dispatch(r)))).filter(Boolean);
      const payload = results.length === 1 ? results[0] : results;
      return wantsSSE(req) ? sseResp(payload, sessionHeader) : json(payload, 200, sessionHeader);
    }

    const result = dispatch(rpc);
    if (result === null) return new Response(null, { status: 204, headers: { ...CORS, ...sessionHeader } });
    return wantsSSE(req) ? sseResp(result, sessionHeader) : json(result, 200, sessionHeader);
  }

  return json({ error: "Not found", hint: "Try GET /health" }, 404);
}

Deno.serve(handle);
console.log(`\n🌤  ${SERVER_NAME} v${SERVER_VERSION} running`);
console.log(`   Legacy SSE:      GET  /sse   (point Perplexity here first)`);
console.log(`   Streamable HTTP: POST /mcp   (point Perplexity here second)`);
console.log(`   Health:          GET  /health\n`);
