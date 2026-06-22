/**
 * claude.js — Deno Deploy entrypoint for the Claude.ai remote MCP connector.
 *
 * Claude.ai custom connectors don't support static bearer tokens, so this
 * entrypoint uses a secret URL path segment for access control instead.
 * The Jules API key is read from a Deno Deploy environment variable.
 *
 * Deploy: https://dash.deno.com → link repo, entrypoint = claude.js
 *         Env vars:
 *           JULES_API_KEY    = your Google Jules API key
 *           MCP_PATH_SECRET  = a long random string (e.g. UUID)
 *
 * Claude.ai connector config:
 *   URL:  https://<project>.deno.dev/mcp/<MCP_PATH_SECRET>
 *   Auth: (none — the secret path IS the auth)
 *   Transport: Streamable HTTP
 */

import { StreamableHTTPServerTransport } from "npm:@modelcontextprotocol/sdk@1.12.1/server/streamableHttp.js";
import { createServer } from "./lib/server.js";
import { EventEmitter } from "node:events";

const PORT = parseInt(Deno.env.get("PORT") ?? "8000", 10);
const JULES_API_KEY = Deno.env.get("JULES_API_KEY") ?? "";
const MCP_PATH_SECRET = Deno.env.get("MCP_PATH_SECRET") ?? "";

if (!JULES_API_KEY) {
  console.error("FATAL: JULES_API_KEY environment variable is not set.");
}
if (!MCP_PATH_SECRET) {
  console.error("FATAL: MCP_PATH_SECRET environment variable is not set.");
}

const MCP_PATH = `/mcp/${MCP_PATH_SECRET}`;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Mcp-Session-Id, Accept, Last-Event-Id",
  "Access-Control-Expose-Headers": "Mcp-Session-Id",
};

// ---------------------------------------------------------------------------
// Node.js req/res adapters for the MCP SDK transport
// ---------------------------------------------------------------------------

function buildNodeReq(request, url) {
  const headers = {};
  for (const [k, v] of request.headers.entries()) {
    headers[k.toLowerCase()] = v;
  }
  headers["accept"] = "application/json, text/event-stream";
  return {
    method: request.method,
    url: url.pathname + url.search,
    headers,
  };
}

function buildNodeRes() {
  let statusCode = 200;
  const responseHeaders = { ...CORS_HEADERS };
  const chunks = [];
  let ended = false;
  let resolveResponse;

  const promise = new Promise((resolve) => { resolveResponse = resolve; });
  const emitter = new EventEmitter();

  const res = {
    statusCode,
    headersSent: false,

    writeHead(code, hdrs) {
      statusCode = code;
      res.statusCode = code;
      if (hdrs) {
        for (const [k, v] of Object.entries(hdrs)) {
          responseHeaders[k.toLowerCase()] = v;
        }
      }
      return res;
    },

    setHeader(name, value) { responseHeaders[name.toLowerCase()] = value; },
    getHeader(name) { return responseHeaders[name.toLowerCase()]; },

    flushHeaders() {
      res.headersSent = true;
      return res;
    },

    write(chunk) {
      chunks.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
      return true;
    },

    end(data) {
      if (ended) return;
      ended = true;
      if (data) chunks.push(typeof data === "string" ? data : new TextDecoder().decode(data));
      const body = chunks.join("");
      resolveResponse(new Response(body || null, { status: statusCode, headers: responseHeaders }));
    },

    on(event, listener) { emitter.on(event, listener); return res; },
  };

  return { res, promise, emitter };
}

// ---------------------------------------------------------------------------
// Path validation (constant-time comparison to prevent timing attacks)
// ---------------------------------------------------------------------------

function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

function isAuthorizedPath(pathname) {
  if (!MCP_PATH_SECRET) return false;
  return constantTimeEqual(pathname, MCP_PATH);
}

// ---------------------------------------------------------------------------
// MCP handler
// ---------------------------------------------------------------------------

async function handleMcp(request, url) {
  let parsedBody = undefined;
  if (request.method === "POST") {
    try {
      parsedBody = await request.json();
    } catch {
      return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
        status: 400,
        headers: { "content-type": "application/json", ...CORS_HEADERS },
      });
    }
  }

  const mcpServer = createServer(JULES_API_KEY);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

  // The SDK transport expects requests at /mcp, so we rewrite the path
  const nodeReq = buildNodeReq(request, url);
  nodeReq.url = "/mcp";

  const { res: nodeRes, promise } = buildNodeRes();

  try {
    await mcpServer.connect(transport);
    transport.handleRequest(nodeReq, nodeRes, parsedBody).catch((err) => {
      console.error("transport error:", err);
    });
    return await promise;
  } catch (err) {
    console.error("handleMcp error:", err);
    return new Response(
      JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: String(err?.message ?? err) }, id: null }),
      { status: 500, headers: { "content-type": "application/json", ...CORS_HEADERS } }
    );
  } finally {
    await mcpServer.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Request router
// ---------------------------------------------------------------------------

async function handleRequest(request) {
  const url = new URL(request.url);

  if (url.pathname === "/health" || url.pathname === "/") {
    return new Response(
      JSON.stringify({ status: "ok", server: "jules-mcp-claude", version: "0.3.0" }),
      { status: 200, headers: { "content-type": "application/json", ...CORS_HEADERS } }
    );
  }

  // CORS preflight — must work for the secret path
  if (request.method === "OPTIONS" && url.pathname.startsWith("/mcp/")) {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  // MCP endpoint — validate secret path
  if (isAuthorizedPath(url.pathname)) {
    if (["GET", "POST", "DELETE"].includes(request.method)) {
      return await handleMcp(request, url);
    }
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "content-type": "application/json", ...CORS_HEADERS },
    });
  }

  // Everything else — generic 404 (don't reveal that /mcp/<something> exists)
  return new Response(JSON.stringify({ error: "Not found" }), {
    status: 404,
    headers: { "content-type": "application/json" },
  });
}

Deno.serve({ port: PORT }, handleRequest);
console.log(`jules-mcp Claude connector running on port ${PORT}`);
console.log(`  MCP endpoint: /mcp/<secret>`);
