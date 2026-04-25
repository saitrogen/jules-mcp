#!/usr/bin/env node
/**
 * index.js — stdio entrypoint (local MCP clients: Claude Desktop, Cursor, etc.)
 *
 * Behaviour is identical to the original. CLI arg parsing for --jules-base-url
 * is preserved here and passed into createServer().
 *
 * Usage (same as before):
 *   JULES_API_KEY=your_key npx jules-mcp
 *   JULES_API_KEY=your_key npx jules-mcp --jules-base-url=https://jules.googleapis.com/v1
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./lib/server.js";

// ---------------------------------------------------------------------------
// CLI arg parsing — preserved from original index.js
// ---------------------------------------------------------------------------

function getCliOptionValue(optionNames) {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    for (const optionName of optionNames) {
      if (arg === optionName) {
        const next = args[i + 1];
        if (typeof next === "string" && !next.startsWith("-")) return next;
      }
      if (arg.startsWith(`${optionName}=`)) return arg.slice(optionName.length + 1);
    }
  }
  return undefined;
}

function resolveBaseUrl() {
  const cliBaseUrl = getCliOptionValue(["--jules-base-url", "--base-url"]);
  if (typeof cliBaseUrl === "string" && cliBaseUrl.trim()) return cliBaseUrl.trim();
  if (typeof process.env.JULES_BASE_URL === "string" && process.env.JULES_BASE_URL.trim())
    return process.env.JULES_BASE_URL.trim();
  return undefined; // let createServer use its own default
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const server = createServer(undefined, resolveBaseUrl());

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`jules-mcp fatal error: ${err?.message || err}\n`);
  process.exit(1);
});
