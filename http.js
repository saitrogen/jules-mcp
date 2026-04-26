/**
 * http.js — Deno Deploy HTTP entrypoint for the Perplexity remote MCP connector.
 *
 * Transport: MCP Streamable HTTP (POST /mcp + GET /mcp) — the standard for
 * remote connectors. Perplexity probes with GET before sending POST.
 * Auth:      Expects the caller's Jules API key in the Authorization header:
 *              Authorization: Bearer <JULES_API_KEY>
 *            Perplexity injects this automatically when the user configures the
 *            connector with their key.
 *
 * Deploy to Deno Deploy:
 *   1. Push this repo to GitHub.
 *   2. Go to https://dash.deno.com → New Project → link this repo.
 *   3. Install command: deno install
 *      Entrypoint: http.js
 *   4. No env vars needed — the Jules API key comes per-request from the
 *      Authorization header.
 *
 * Then in Perplexity → Settings → Connectors → Add Custom MCP:
 *   URL:  https://<your-project>.deno.dev/mcp
 *   Auth: Bearer <your Jules API key>
 */

import { StreamableHTTPServerTransport } from "npm:@modelcontextprotocol/sdk@1.12.1/server/streamableHttp.js";
import { createServer } from "./lib/server.js";

const PORT = parseInt(Deno.env.get("PORT") ?? "8000", 10);

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Mcp-Session-Id",
};

function withCors(response) {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    headers.set(key, value);
  }
  return new Response(response.body, { status: response.status, headers });
}

function extractApiKey(request) {
  const auth = request.headers.get("authorization") ?? "";
  if (auth.toLowerCase().startsWith("bearer ")) {
    const key = auth.slice(7).trim();
    if (key) return key;
  }
  // Also check x-api-key header as fallback
  const xApiKey = request.headers.get("x-api-key") ?? "";
  if (xApiKey.trim()) return xApiKey.trim();
  return null;
}

function handleHealth() {
  return new Response(
    JSON.stringify({ status: "ok", server: "jules-mcp", version: "0.3.0" }),
    { status: 200, headers: { "content-type": "application/json", ...CORS_HEADERS } }
  );
}

/**
 * Handle MCP requests — both POST (RPC calls) and GET (SSE stream / probe).
 * Perplexity sends a GET first to verify the endpoint exists, then POSTs.
 * DELETE is used by some clients to terminate sessions.
 * All methods are forwarded to the StreamableHTTPServerTransport.
 */
async function handleMcp(request) {
  const apiKey = extractApiKey(request);
  if (!apiKey) {
    return new Response(
      JSON.stringify({
        error: "Missing API key. Set Authorization: Bearer <your Jules API key> in the connector settings.",
      }),
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

  const mcpServer = createServer(apiKey);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
  });

  try {
    await mcpServer.connect(transport);
    const response = await transport.handleRequest(request);
    return withCors(response);
  } finally {
    await mcpServer.close().catch(() => {});
  }
}

async function handleRequest(request) {
  const url = new URL(request.url);

  if (url.pathname === "/health" || url.pathname === "/") {
    return handleHealth();
  }

  if (url.pathname === "/mcp") {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    // Forward GET, POST, DELETE all to the MCP transport
    if (["GET", "POST", "DELETE"].includes(request.method)) {
      return await handleMcp(request);
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
