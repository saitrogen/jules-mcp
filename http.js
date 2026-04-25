/**
 * http.js — Deno Deploy HTTP entrypoint for the Perplexity remote MCP connector.
 *
 * Transport: MCP Streamable HTTP (POST /mcp) — the standard for remote connectors.
 * Auth:      Expects the caller's Jules API key in the Authorization header:
 *              Authorization: Bearer <JULES_API_KEY>
 *            Perplexity injects this automatically when the user configures the
 *            connector with their key.
 *
 * Deploy to Deno Deploy:
 *   1. Push this repo to GitHub.
 *   2. Go to https://dash.deno.com → New Project → link this repo.
 *   3. Set entrypoint to: http.js
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

// CORS headers applied to every response from /mcp so browser-based
// clients (and Perplexity's web frontend) can reach the endpoint.
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Mcp-Session-Id",
};

/**
 * Attach CORS headers to any Response, merging with existing headers.
 */
function withCors(response) {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    headers.set(key, value);
  }
  return new Response(response.body, { status: response.status, headers });
}

/**
 * Extract the Jules API key from the Authorization header.
 * Perplexity sends: Authorization: Bearer <key>
 */
function extractApiKey(request) {
  const auth = request.headers.get("authorization") ?? "";
  if (auth.toLowerCase().startsWith("bearer ")) {
    const key = auth.slice(7).trim();
    if (key) return key;
  }
  return null;
}

/**
 * Health / root endpoint — lets Perplexity (and curl) verify the server is live.
 */
function handleHealth() {
  return new Response(
    JSON.stringify({ status: "ok", server: "jules-mcp", version: "0.3.0" }),
    { status: 200, headers: { "content-type": "application/json", ...CORS_HEADERS } }
  );
}

/**
 * Handle a single MCP Streamable HTTP request.
 *
 * A fresh McpServer is created per request (stateless). Jules holds all
 * session state; nothing is stored between requests on this server.
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
          // RFC 6750 §3 — tell clients which auth scheme is expected
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
    // handleRequest returns a Response; ensure CORS headers are present on it.
    const response = await transport.handleRequest(request);
    return withCors(response);
  } finally {
    // Always clean up to release event listeners and avoid memory leaks.
    await mcpServer.close().catch(() => {});
  }
}

/**
 * Main request router.
 */
async function handleRequest(request) {
  const url = new URL(request.url);

  // Health / root
  if (url.pathname === "/health" || url.pathname === "/") {
    return handleHealth();
  }

  // MCP Streamable HTTP endpoint
  if (url.pathname === "/mcp") {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    if (request.method === "POST") {
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
