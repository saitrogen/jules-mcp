/**
 * chatgpt.js — Jules MCP Server for ChatGPT custom connectors
 *
 * ChatGPT remote MCP connectors are easiest to run as a public HTTPS MCP
 * endpoint. This entrypoint follows the same auth pattern as claude.js:
 *
 *   - Jules API key is stored server-side in Deno Deploy env vars.
 *   - The connector URL contains a long secret path segment.
 *   - ChatGPT connector auth can be set to "None" because the secret path is
 *     the access-control boundary.
 *
 * Unlike claude.js, this file reuses lib/server.js so the ChatGPT connector gets
 * the same tools and schemas as the normal SDK-based server.
 *
 * Deploy (Deno Deploy):
 *   Entrypoint:      chatgpt.js
 *   Install command: (leave blank)
 *   Build command:   (leave blank)
 *   Env vars:
 *     JULES_API_KEY        = your Google Jules API key
 *     CHATGPT_MCP_SECRET   = a long random string, e.g. openssl rand -hex 32
 *     JULES_BASE_URL       = optional, defaults inside lib/server.js
 *
 * ChatGPT connector config:
 *   URL:  https://<project>.deno.dev/mcp/<CHATGPT_MCP_SECRET>
 *   Auth: None
 *   Transport: Remote MCP / Streamable HTTP
 */

import { StreamableHTTPServerTransport } from "npm:@modelcontextprotocol/sdk@1.12.1/server/streamableHttp.js";
import { createServer } from "./lib/server.js";
import { EventEmitter } from "node:events";

const SERVER_NAME = "jules-mcp-chatgpt";
const SERVER_VERSION = "0.3.0-chatgpt";

const PORT = parseInt(Deno.env.get("PORT") ?? "8000", 10);
const JULES_API_KEY = Deno.env.get("JULES_API_KEY") ?? "";
const CHATGPT_MCP_SECRET = Deno.env.get("CHATGPT_MCP_SECRET") ?? "";
const JULES_BASE_URL = Deno.env.get("JULES_BASE_URL") || undefined;

const MCP_PATH = CHATGPT_MCP_SECRET ? `/mcp/${CHATGPT_MCP_SECRET}` : "/mcp";

if (!JULES_API_KEY) {
  console.error("WARNING: JULES_API_KEY env var is not set. Tool calls will fail.");
}
if (!CHATGPT_MCP_SECRET) {
  console.error("WARNING: CHATGPT_MCP_SECRET is not set. Falling back to public /mcp endpoint.");
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Accept, Mcp-Session-Id, Last-Event-Id, X-Api-Key",
  "Access-Control-Expose-Headers": "Mcp-Session-Id",
};

function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

function isAuthorizedMcpPath(pathname) {
  return constantTimeEqual(pathname, MCP_PATH);
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...CORS_HEADERS, ...headers },
  });
}

function buildNodeReq(request, url) {
  const headers = {};
  for (const [key, value] of request.headers.entries()) {
    headers[key.toLowerCase()] = value;
  }

  // The TypeScript MCP SDK requires clients to accept both JSON and SSE for
  // Streamable HTTP. Some clients omit one; make the bridge permissive.
  headers.accept = "application/json, text/event-stream";

  return {
    method: request.method,
    url: url.pathname + url.search,
    headers,
  };
}

function extractSingleSseJson(body) {
  const dataLines = [];
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("data:")) {
      dataLines.push(trimmed.slice(5).trim());
    }
  }
  if (dataLines.length !== 1) return null;
  try {
    JSON.parse(dataLines[0]);
    return dataLines[0];
  } catch {
    return null;
  }
}

function buildNodeRes() {
  let statusCode = 200;
  const responseHeaders = { ...CORS_HEADERS };
  const chunks = [];
  let ended = false;
  let resolveResponse;

  const promise = new Promise((resolve) => {
    resolveResponse = resolve;
  });
  const emitter = new EventEmitter();

  const res = {
    statusCode,
    headersSent: false,

    writeHead(code, headers) {
      statusCode = code;
      res.statusCode = code;
      if (headers) {
        for (const [key, value] of Object.entries(headers)) {
          responseHeaders[key.toLowerCase()] = value;
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

      // ChatGPT supports remote MCP over Streamable HTTP. Returning JSON for
      // single-message responses is also accepted by many validators and makes
      // diagnostics much easier. Multi-event streams are preserved as SSE.
      if (contentType.includes("text/event-stream")) {
        const jsonBody = extractSingleSseJson(body);
        if (jsonBody !== null) {
          responseHeaders["content-type"] = "application/json";
          delete responseHeaders["cache-control"];
          resolveResponse(new Response(jsonBody, { status: statusCode, headers: responseHeaders }));
          return;
        }
      }

      resolveResponse(new Response(body || null, { status: statusCode, headers: responseHeaders }));
    },

    on(event, listener) {
      emitter.on(event, listener);
      return res;
    },
  };

  return { res, promise };
}

async function handleMcp(request, url) {
  if (!JULES_API_KEY) {
    return json({
      jsonrpc: "2.0",
      id: null,
      error: {
        code: -32001,
        message: "JULES_API_KEY is not configured on the server.",
      },
    }, 500);
  }

  let parsedBody = undefined;
  if (request.method === "POST") {
    try {
      parsedBody = await request.json();
    } catch {
      return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400);
    }
  }

  const mcpServer = createServer(JULES_API_KEY, JULES_BASE_URL);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  const nodeReq = buildNodeReq(request, url);
  const { res: nodeRes, promise } = buildNodeRes();

  try {
    await mcpServer.connect(transport);
    transport.handleRequest(nodeReq, nodeRes, parsedBody).catch((error) => {
      console.error("transport error:", error);
    });
    return await promise;
  } catch (error) {
    console.error("handleMcp error:", error);
    return json({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32603, message: String(error?.message ?? error) },
    }, 500);
  } finally {
    await mcpServer.close().catch(() => {});
  }
}

async function handleRequest(request) {
  const url = new URL(request.url);
  const path = url.pathname;

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (path === "/" || path === "/health") {
    return json({
      status: "ok",
      server: SERVER_NAME,
      version: SERVER_VERSION,
      transport: `Streamable HTTP at ${MCP_PATH}`,
      apiKeyConfigured: Boolean(JULES_API_KEY),
      secretConfigured: Boolean(CHATGPT_MCP_SECRET),
    });
  }

  if (isAuthorizedMcpPath(path)) {
    if (["GET", "POST", "DELETE"].includes(request.method)) {
      return await handleMcp(request, url);
    }
    return json({ error: "Method not allowed" }, 405);
  }

  // Do not reveal whether a secret endpoint exists.
  return json({ error: "Not found" }, 404);
}

Deno.serve({ port: PORT }, handleRequest);
console.log(`${SERVER_NAME} running on port ${PORT}; MCP endpoint: ${MCP_PATH}`);
