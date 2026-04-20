#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const API_KEY = process.env.JULES_API_KEY;
const BASE_URL = process.env.JULES_BASE_URL || "https://jules.googleapis.com/v1alpha";

function buildUrl(path, query) {
  const url = new URL(path.replace(/^\//, ""), `${BASE_URL.replace(/\/$/, "")}/`);
  if (query && typeof query === "object") {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, String(value));
      }
    }
  }
  return url;
}

async function julesRequest({ method = "GET", path, query, body }) {
  if (!API_KEY) {
    throw new Error("Missing JULES_API_KEY. Set it in your environment before starting this MCP server.");
  }

  const url = buildUrl(path, query);
  const headers = {
    "x-goog-api-key": API_KEY,
  };

  if (body !== undefined) {
    headers["content-type"] = "application/json";
  }

  const response = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const raw = await response.text();
  let parsed;
  try {
    parsed = raw ? JSON.parse(raw) : {};
  } catch {
    parsed = { raw };
  }

  if (!response.ok) {
    const message = parsed?.error?.message || parsed?.message || raw || `HTTP ${response.status}`;
    throw new Error(`Jules API error (${response.status}): ${message}`);
  }

  return parsed;
}

function requireString(args, key) {
  if (!args || typeof args[key] !== "string" || !args[key].trim()) {
    throw new Error(`Missing required string argument: ${key}`);
  }
  return args[key].trim();
}

const tools = [
  {
    name: "jules_list_sources",
    description: "List repositories (sources) connected to Jules.",
    inputSchema: {
      type: "object",
      properties: {
        pageSize: { type: "integer", minimum: 1, maximum: 100 },
        pageToken: { type: "string" },
        filter: { type: "string" },
      },
    },
  },
  {
    name: "jules_get_source",
    description: "Get details for one Jules source by sourceId.",
    inputSchema: {
      type: "object",
      properties: {
        sourceId: { type: "string", description: "Example: github-myorg-myrepo" },
      },
      required: ["sourceId"],
    },
  },
  {
    name: "jules_create_session",
    description: "Create a Jules coding session for a prompt and source.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string" },
        source: { type: "string", description: "Resource name, e.g. sources/github-myorg-myrepo" },
        startingBranch: { type: "string" },
        title: { type: "string" },
        automationMode: { type: "string", description: "Optional, e.g. AUTO_CREATE_PR" },
        requirePlanApproval: { type: "boolean" },
      },
      required: ["prompt", "source"],
    },
  },
  {
    name: "jules_list_sessions",
    description: "List your Jules sessions.",
    inputSchema: {
      type: "object",
      properties: {
        pageSize: { type: "integer", minimum: 1, maximum: 100 },
        pageToken: { type: "string" },
      },
    },
  },
  {
    name: "jules_get_session",
    description: "Get details for a Jules session.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
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
        sessionId: { type: "string" },
      },
      required: ["sessionId"],
    },
  },
  {
    name: "jules_list_activities",
    description: "List activities for a Jules session.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        pageSize: { type: "integer", minimum: 1, maximum: 100 },
        pageToken: { type: "string" },
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
        sessionId: { type: "string" },
        prompt: { type: "string" },
      },
      required: ["sessionId", "prompt"],
    },
  },
  {
    name: "jules_approve_plan",
    description: "Approve plan for a session waiting on plan approval.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
      },
      required: ["sessionId"],
    },
  },
];

const server = new Server(
  {
    name: "jules-mcp-server",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const tool = request.params.name;
  const args = request.params.arguments || {};

  try {
    let result;

    switch (tool) {
      case "jules_list_sources": {
        result = await julesRequest({
          path: "/sources",
          query: {
            pageSize: args.pageSize,
            pageToken: args.pageToken,
            filter: args.filter,
          },
        });
        break;
      }

      case "jules_get_source": {
        const sourceId = requireString(args, "sourceId");
        result = await julesRequest({ path: `/sources/${encodeURIComponent(sourceId)}` });
        break;
      }

      case "jules_create_session": {
        const prompt = requireString(args, "prompt");
        const source = requireString(args, "source");

        const body = {
          prompt,
          sourceContext: {
            source,
          },
        };

        if (typeof args.title === "string" && args.title.trim()) {
          body.title = args.title.trim();
        }
        if (typeof args.automationMode === "string" && args.automationMode.trim()) {
          body.automationMode = args.automationMode.trim();
        }
        if (typeof args.requirePlanApproval === "boolean") {
          body.requirePlanApproval = args.requirePlanApproval;
        }
        if (typeof args.startingBranch === "string" && args.startingBranch.trim()) {
          body.sourceContext.githubRepoContext = {
            startingBranch: args.startingBranch.trim(),
          };
        }

        result = await julesRequest({
          method: "POST",
          path: "/sessions",
          body,
        });
        break;
      }

      case "jules_list_sessions": {
        result = await julesRequest({
          path: "/sessions",
          query: {
            pageSize: args.pageSize,
            pageToken: args.pageToken,
          },
        });
        break;
      }

      case "jules_get_session": {
        const sessionId = requireString(args, "sessionId");
        result = await julesRequest({ path: `/sessions/${encodeURIComponent(sessionId)}` });
        break;
      }

      case "jules_delete_session": {
        const sessionId = requireString(args, "sessionId");
        result = await julesRequest({
          method: "DELETE",
          path: `/sessions/${encodeURIComponent(sessionId)}`,
        });
        break;
      }

      case "jules_list_activities": {
        const sessionId = requireString(args, "sessionId");
        result = await julesRequest({
          path: `/sessions/${encodeURIComponent(sessionId)}/activities`,
          query: {
            pageSize: args.pageSize,
            pageToken: args.pageToken,
          },
        });
        break;
      }

      case "jules_send_message": {
        const sessionId = requireString(args, "sessionId");
        const prompt = requireString(args, "prompt");
        result = await julesRequest({
          method: "POST",
          path: `/sessions/${encodeURIComponent(sessionId)}:sendMessage`,
          body: { prompt },
        });
        break;
      }

      case "jules_approve_plan": {
        const sessionId = requireString(args, "sessionId");
        result = await julesRequest({
          method: "POST",
          path: `/sessions/${encodeURIComponent(sessionId)}:approvePlan`,
          body: {},
        });
        break;
      }

      default:
        throw new Error(`Unknown tool: ${tool}`);
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  } catch (error) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: error instanceof Error ? error.message : String(error),
        },
      ],
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Jules MCP server connected over stdio.");
}

main().catch((error) => {
  console.error("Fatal error starting Jules MCP server:", error);
  process.exit(1);
});
