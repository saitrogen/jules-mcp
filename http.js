/**
 * http.js — Deno Deploy HTTP entrypoint for the Perplexity remote MCP connector.
 *
 * The MCP SDK's StreamableHTTPServerTransport returns text/event-stream for all
 * responses. Perplexity's connector validator expects application/json for RPC
 * calls. This file bridges both: single-shot SSE responses (one event) are
 * converted to plain JSON; streaming responses are passed through as SSE.
 *
 * Deploy: https://dash.deno.com → link repo, entrypoint = http.js
 *         Install command: deno install
 *         No env vars needed — Jules API key comes from Authorization header.
 *
 * Perplexity connector config:
 *   URL:  https://<project>.deno.dev/mcp
 *   Auth: Bearer <Jules API key>
 *   Transport: Streamable HTTP
 */

import { StreamableHTTPServerTransport } from "npm:@modelcontextprotocol/sdk@1.12.1/server/streamableHttp.js";
import { createServer } from "./lib/server.js";
import { EventEmitter } from "node:events";

const PORT = parseInt(Deno.env.get("PORT") ?? "8000", 10);

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Mcp-Session-Id, Accept, Last-Event-Id",
};

function extractApiKey(request) {
  const auth = request.headers.get("authorization") ?? "";
  if (auth.toLowerCase().startsWith("bearer ")) {
    const key = auth.slice(7).trim();
    if (key) return key;
  }
  const xKey = request.headers.get("x-api-key") ?? "";
  if (xKey.trim()) return xKey.trim();
  return null;
}

function buildNodeReq(request, url) {
  const headers = {};
  for (const [k, v] of request.headers.entries()) {
    headers[k.toLowerCase()] = v;
  }
  // Force Accept to include both so the SDK doesn't reject the request
  headers["accept"] = "application/json, text/event-stream";
  return {
    method: request.method,
    url: url.pathname + url.search,
    headers,
  };
}

/**
 * Build a fake Node.js ServerResponse.
 * Buffers all output and resolves a Promise<Response> when end() is called.
 * For SSE (flushHeaders + write + end), collects all SSE chunks.
 */
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

    // flushHeaders: SDK uses this for SSE streams.
    // We mark headersSent but keep buffering — we'll decide stream vs JSON at end().
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
      const contentType = responseHeaders["content-type"] ?? "";

      // If the response is SSE and contains exactly ONE complete event,
      // convert it to plain application/json so Perplexity can parse it.
      if (contentType.includes("text/event-stream")) {
        const jsonBody = extractSingleSseJson(body);
        if (jsonBody !== null) {
          responseHeaders["content-type"] = "application/json";
          delete responseHeaders["cache-control"];
          resolveResponse(new Response(jsonBody, { status: statusCode, headers: responseHeaders }));
          return;
        }
        // Multi-event SSE — stream it as-is
        resolveResponse(new Response(body, { status: statusCode, headers: responseHeaders }));
        return;
      }

      resolveResponse(new Response(body || null, { status: statusCode, headers: responseHeaders }));
    },

    on(event, listener) { emitter.on(event, listener); return res; },
  };

  return { res, promise, emitter };
}

/**
 * Parse a buffered SSE body and extract the JSON payload if there is exactly
 * one complete 'data:' line. Returns the JSON string or null.
 *
 * SSE format: "event: message\ndata: {...}\n\n"
 */
function extractSingleSseJson(body) {
  const dataLines = [];
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("data:")) {
      dataLines.push(trimmed.slice(5).trim());
    }
  }
  if (dataLines.length === 1) {
    try {
      JSON.parse(dataLines[0]); // validate it's real JSON
      return dataLines[0];
    } catch {
      return null;
    }
  }
  return null; // 0 or multiple data lines — keep as SSE
}

async function handleMcp(request, url) {
  const apiKey = extractApiKey(request);
  if (!apiKey) {
    return new Response(
      JSON.stringify({ error: "Missing API key. Add Authorization: Bearer <Jules key> in connector settings." }),
      {
        status: 401,
        headers: {
          "content-type": "application/json",
          "WWW-Authenticate": 'Bearer realm="jules-mcp", charset="UTF-8"',
          ...CORS_HEADERS,
        },
      }
    );
  }

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

  const mcpServer = createServer(apiKey);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  const nodeReq = buildNodeReq(request, url);
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

async function handleRequest(request) {
  const url = new URL(request.url);

  if (url.pathname === "/health" || url.pathname === "/") {
    return new Response(
      JSON.stringify({ status: "ok", server: "jules-mcp", version: "0.3.0" }),
      { status: 200, headers: { "content-type": "application/json", ...CORS_HEADERS } }
    );
  }

  if (url.pathname === "/mcp") {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    if (["GET", "POST", "DELETE"].includes(request.method)) {
      return await handleMcp(request, url);
    }
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "content-type": "application/json", ...CORS_HEADERS },
    });
  }

  return new Response(JSON.stringify({ error: "Not found" }), {
    status: 404,
    headers: { "content-type": "application/json" },
  });
}

Deno.serve({ port: PORT }, handleRequest);
console.log(`jules-mcp HTTP server running on port ${PORT}`);
