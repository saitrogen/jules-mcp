#!/usr/bin/env node
/**
 * index.js — stdio entrypoint (local MCP clients: Claude Desktop, Cursor, etc.)
 *
 * Unchanged behaviour from the original. The full Jules tool implementation
 * now lives in lib/server.js so it can be shared with the HTTP entrypoint.
 *
 * Usage (same as before):
 *   JULES_API_KEY=your_key npx jules-mcp
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./lib/server.js";

// In stdio mode the API key comes from the environment (set by the user locally).
// The createServer factory reads process.env.JULES_API_KEY as its fallback
// when no explicit key is passed, which is exactly what we want here.
const server = createServer();

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`jules-mcp fatal error: ${err?.message || err}\n`);
  process.exit(1);
});
