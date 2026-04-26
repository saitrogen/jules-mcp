/**
 * http.js — Deno Deploy HTTP entrypoint for the Perplexity remote MCP connector.
 *
 * The MCP SDK's StreamableHTTPServerTransport expects Node.js-style
 * req/res objects (IncomingMessage / ServerResponse). This file bridges
 * Deno's Web-standard Request/Response to that interface.
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

/**
 * Build a fake Node.js IncomingMessage-compatible object from a Web Request.
 * The SDK only reads: req.method, req.headers (plain object), req.url
 */
function buildNodeReq(request, url, body) {
  const headers = {};
  for (const [k, v] of request.headers.entries()) {
    headers[k.toLowerCase()] = v;
  }
  return {
    method: request.method,
    url: url.pathname + url.search,
    headers,
  };
}

/**
 * Build a fake Node.js ServerResponse-compatible object.
 * Captures status + headers + body chunks and resolves to a Web Response.
 */
function buildNodeRes() {
  let statusCode = 200;
  const responseHeaders = { ...CORS_HEADERS };
  const chunks = [];
  let ended = false;
  let resolveResponse;
  let rejectResponse;
  // SSE stream support
  const emitter = new EventEmitter();
  let sseController = null;
  let sseStream = null;

  const promise = new Promise((resolve, reject) => {
    resolveResponse = resolve;
    rejectResponse = reject;
  });

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

    setHeader(name, value) {
      responseHeaders[name.toLowerCase()] = value;
    },

    getHeader(name) {
      return responseHeaders[name.toLowerCase()];
    },

    // SSE: flushHeaders signals we're starting a streaming response
    flushHeaders() {
      res.headersSent = true;
      const stream = new ReadableStream({
        start(controller) {
          sseController = controller;
        },
        cancel() {
          emitter.emit("close");
        },
      });
      sseStream = stream;
      resolveResponse(
        new Response(stream, {
          status: statusCode,
          headers: responseHeaders,
        })
      );
    },

    // write() is used for SSE data chunks
    write(chunk) {
      if (sseController) {
        const data = typeof chunk === "string"
          ? new TextEncoder().encode(chunk)
          : chunk;
        sseController.enqueue(data);
        return true;
      }
      // Non-SSE buffered write
      chunks.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
      return true;
    },

    end(data) {
      if (ended) return;
      ended = true;
      if (sseController) {
        sseController.close();
        return;
      }
      if (data) chunks.push(typeof data === "string" ? data : new TextDecoder().decode(data));
      const body = chunks.join("");
      resolveResponse(
        new Response(body || null, {
          status: statusCode,
          headers: responseHeaders,
        })
      );
    },

    on(event, listener) {
      emitter.on(event, listener);
      return res;
    },
  };

  return { res, promise };
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

  // Parse body for POST
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
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless mode
  });

  const nodeReq = buildNodeReq(request, url, parsedBody);
  const { res: nodeRes, promise } = buildNodeRes();

  try {
    await mcpServer.connect(transport);
    // Fire-and-forget: handleRequest writes to nodeRes asynchronously
    transport.handleRequest(nodeReq, nodeRes, parsedBody).catch((err) => {
      console.error("transport.handleRequest error:", err);
    });
    // Wait for the response to be resolved (end() or flushHeaders() called)
    const response = await promise;
    return response;
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
