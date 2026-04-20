#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

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

function requireNonEmpty(value, name) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Missing required string argument: ${name}`);
  }
  return value.trim();
}

function optionalTrimmed(value) {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function textResult(data) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(data, null, 2),
      },
    ],
  };
}

const server = new McpServer({
  name: "jules-mcp-server",
  version: "0.2.0",
});

const paginationSchema = {
  pageSize: z.number().int().min(1).max(100).optional(),
  pageToken: z.string().optional(),
};

server.registerTool(
  "jules_list_sources",
  {
    description: "List repositories (sources) connected to Jules.",
    inputSchema: z.object({
      ...paginationSchema,
      filter: z.string().optional(),
    }),
  },
  async ({ pageSize, pageToken, filter }) => {
    const result = await julesRequest({
      path: "/sources",
      query: {
        pageSize,
        pageToken,
        filter,
      },
    });
    return textResult(result);
  }
);

server.registerTool(
  "jules_get_source",
  {
    description: "Get details for one Jules source by sourceId.",
    inputSchema: z.object({
      sourceId: z.string().min(1),
    }),
  },
  async ({ sourceId }) => {
    const normalizedSourceId = requireNonEmpty(sourceId, "sourceId");
    const result = await julesRequest({
      path: `/sources/${encodeURIComponent(normalizedSourceId)}`,
    });
    return textResult(result);
  }
);

server.registerTool(
  "jules_create_session",
  {
    description: "Create a Jules coding session for a prompt and source.",
    inputSchema: z.object({
      prompt: z.string().min(1),
      source: z.string().min(1),
      startingBranch: z.string().optional(),
      title: z.string().optional(),
      automationMode: z.string().optional(),
      requirePlanApproval: z.boolean().optional(),
    }),
  },
  async ({ prompt, source, startingBranch, title, automationMode, requirePlanApproval }) => {
    const normalizedPrompt = requireNonEmpty(prompt, "prompt");
    const normalizedSource = requireNonEmpty(source, "source");

    const body = {
      prompt: normalizedPrompt,
      sourceContext: {
        source: normalizedSource,
      },
    };

    const normalizedTitle = optionalTrimmed(title);
    const normalizedAutomationMode = optionalTrimmed(automationMode);
    const normalizedStartingBranch = optionalTrimmed(startingBranch);

    if (normalizedTitle) {
      body.title = normalizedTitle;
    }
    if (normalizedAutomationMode) {
      body.automationMode = normalizedAutomationMode;
    }
    if (typeof requirePlanApproval === "boolean") {
      body.requirePlanApproval = requirePlanApproval;
    }
    if (normalizedStartingBranch) {
      body.sourceContext.githubRepoContext = {
        startingBranch: normalizedStartingBranch,
      };
    }

    const result = await julesRequest({
      method: "POST",
      path: "/sessions",
      body,
    });
    return textResult(result);
  }
);

server.registerTool(
  "jules_list_sessions",
  {
    description: "List your Jules sessions.",
    inputSchema: z.object({
      ...paginationSchema,
    }),
  },
  async ({ pageSize, pageToken }) => {
    const result = await julesRequest({
      path: "/sessions",
      query: {
        pageSize,
        pageToken,
      },
    });
    return textResult(result);
  }
);

server.registerTool(
  "jules_get_session",
  {
    description: "Get details for a Jules session.",
    inputSchema: z.object({
      sessionId: z.string().min(1),
    }),
  },
  async ({ sessionId }) => {
    const normalizedSessionId = requireNonEmpty(sessionId, "sessionId");
    const result = await julesRequest({
      path: `/sessions/${encodeURIComponent(normalizedSessionId)}`,
    });
    return textResult(result);
  }
);

server.registerTool(
  "jules_delete_session",
  {
    description: "Delete a Jules session.",
    inputSchema: z.object({
      sessionId: z.string().min(1),
    }),
  },
  async ({ sessionId }) => {
    const normalizedSessionId = requireNonEmpty(sessionId, "sessionId");
    const result = await julesRequest({
      method: "DELETE",
      path: `/sessions/${encodeURIComponent(normalizedSessionId)}`,
    });
    return textResult(result);
  }
);

server.registerTool(
  "jules_list_activities",
  {
    description: "List activities for a Jules session.",
    inputSchema: z.object({
      sessionId: z.string().min(1),
      ...paginationSchema,
    }),
  },
  async ({ sessionId, pageSize, pageToken }) => {
    const normalizedSessionId = requireNonEmpty(sessionId, "sessionId");
    const result = await julesRequest({
      path: `/sessions/${encodeURIComponent(normalizedSessionId)}/activities`,
      query: {
        pageSize,
        pageToken,
      },
    });
    return textResult(result);
  }
);

server.registerTool(
  "jules_send_message",
  {
    description: "Send a follow-up message to an active Jules session.",
    inputSchema: z.object({
      sessionId: z.string().min(1),
      prompt: z.string().min(1),
    }),
  },
  async ({ sessionId, prompt }) => {
    const normalizedSessionId = requireNonEmpty(sessionId, "sessionId");
    const normalizedPrompt = requireNonEmpty(prompt, "prompt");
    const result = await julesRequest({
      method: "POST",
      path: `/sessions/${encodeURIComponent(normalizedSessionId)}:sendMessage`,
      body: { prompt: normalizedPrompt },
    });
    return textResult(result);
  }
);

server.registerTool(
  "jules_approve_plan",
  {
    description: "Approve plan for a session waiting on plan approval.",
    inputSchema: z.object({
      sessionId: z.string().min(1),
    }),
  },
  async ({ sessionId }) => {
    const normalizedSessionId = requireNonEmpty(sessionId, "sessionId");
    const result = await julesRequest({
      method: "POST",
      path: `/sessions/${encodeURIComponent(normalizedSessionId)}:approvePlan`,
      body: {},
    });
    return textResult(result);
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Jules MCP server connected over stdio.");
}

main().catch((error) => {
  console.error("Fatal error starting Jules MCP server:", error);
  process.exit(1);
});
