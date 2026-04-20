#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const API_KEY = process.env.JULES_API_KEY;

function getCliOptionValue(optionNames) {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    for (const optionName of optionNames) {
      if (arg === optionName) {
        const next = args[i + 1];
        if (typeof next === "string" && !next.startsWith("-")) {
          return next;
        }
      }
      if (arg.startsWith(`${optionName}=`)) {
        return arg.slice(optionName.length + 1);
      }
    }
  }
  return undefined;
}

function resolveBaseUrl() {
  const cliBaseUrl = getCliOptionValue(["--jules-base-url", "--base-url"]);
  if (typeof cliBaseUrl === "string" && cliBaseUrl.trim()) {
    return cliBaseUrl.trim();
  }
  if (typeof process.env.JULES_BASE_URL === "string" && process.env.JULES_BASE_URL.trim()) {
    return process.env.JULES_BASE_URL.trim();
  }
  return "https://jules.googleapis.com/v1alpha";
}

const BASE_URL = resolveBaseUrl();

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
    const error = new Error(`Jules API error (${response.status}): ${message}`);
    error.httpStatus = response.status;
    error.apiStatus = parsed?.error?.status;
    error.apiMessage = parsed?.error?.message || parsed?.message || undefined;
    throw error;
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

function normalizeSourceForSessionCreation(source) {
  const normalized = requireNonEmpty(source, "source");
  if (normalized.startsWith("sources/")) {
    return normalized;
  }
  if (normalized.startsWith("github/")) {
    return `sources/${normalized}`;
  }
  return normalized;
}

function sourceIdPathCandidates(sourceId) {
  const normalized = requireNonEmpty(sourceId, "sourceId");
  const candidates = [];

  const slashId = normalized.replace(/^sources\//, "");

  candidates.push(`/sources/${encodeURIComponent(normalized)}`);
  candidates.push(`/sources/${slashId}`);
  candidates.push(`/sources/${encodeURIComponent(slashId)}`);

  const seen = new Set();
  return candidates.filter((candidate) => {
    if (seen.has(candidate)) {
      return false;
    }
    seen.add(candidate);
    return true;
  });
}

function withCanonicalSource(source) {
  if (!source || typeof source !== "object") {
    return source;
  }

  const canonicalSource = source?.name || (typeof source?.id === "string" ? `sources/${source.id}` : undefined);
  if (!canonicalSource) {
    return source;
  }

  return {
    ...source,
    canonicalSource,
  };
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

function normalizePositiveInt(value) {
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

function truncateText(text, maxChars) {
  if (typeof text !== "string") {
    return text;
  }

  if (!maxChars || text.length <= maxChars) {
    return text;
  }

  return `${text.slice(0, maxChars)} …(truncated ${text.length - maxChars} chars)`;
}

function sanitizeSession(session, options = {}) {
  const compact = options.compact === true;
  const includePrompt = options.includePrompt ?? !compact;
  const includeOutputs = options.includeOutputs ?? !compact;
  const includeSourceContext = options.includeSourceContext ?? !compact;
  const maxPromptChars = normalizePositiveInt(options.maxPromptChars);

  if (!compact && includePrompt && includeOutputs && includeSourceContext && maxPromptChars === undefined) {
    return session;
  }

  const sanitized = compact
    ? {
      name: session?.name,
      id: session?.id,
      title: session?.title,
      state: session?.state,
      createTime: session?.createTime,
      updateTime: session?.updateTime,
      url: session?.url,
    }
    : { ...session };

  if (compact && session?.sourceContext?.source) {
    sanitized.source = session.sourceContext.source;
  }

  if (includeSourceContext && session?.sourceContext) {
    sanitized.sourceContext = session.sourceContext;
  } else if (!compact) {
    delete sanitized.sourceContext;
  }

  if (includePrompt && typeof session?.prompt === "string") {
    sanitized.prompt = truncateText(session.prompt, maxPromptChars);
  } else if (!compact) {
    delete sanitized.prompt;
  }

  if (includeOutputs && session?.outputs !== undefined) {
    sanitized.outputs = session.outputs;
  } else if (!compact) {
    delete sanitized.outputs;
  }

  if (session?.requirePlanApproval !== undefined) {
    sanitized.requirePlanApproval = session.requirePlanApproval;
  }

  return sanitized;
}

const TOOL_REFERENCE = {
  jules_list_sources: {
    purpose: "List connected Jules sources (repositories).",
    params: [
      {
        name: "pageSize",
        type: "integer",
        required: false,
        description: "Number of results per page (1-100).",
        default: 10,
        example: 10,
      },
      {
        name: "pageToken",
        type: "string",
        required: false,
        description: "Pagination token from previous result.",
        example: "NEXT_PAGE_TOKEN",
      },
      {
        name: "filter",
        type: "string",
        required: false,
        description: "Optional server-side filter expression.",
        example: "name=sources/github-myorg-myrepo",
      },
    ],
  },
  jules_get_source: {
    purpose: "Fetch one source by sourceId.",
    params: [
      {
        name: "sourceId",
        type: "string",
        required: true,
        description: "Source identifier. Accepts `github/org/repo` or full `sources/github/org/repo`.",
        example: "github/myorg/myrepo",
      },
    ],
  },
  jules_create_session: {
    purpose: "Create a new coding session.",
    params: [
      {
        name: "prompt",
        type: "string",
        required: true,
        description: "Task instruction for Jules.",
        example: "Add unit tests for auth middleware",
      },
      {
        name: "source",
        type: "string",
        required: true,
        description: "Source resource. Prefer `sources/github/org/repo` (or `github/org/repo`, auto-normalized).",
        example: "sources/github-myorg-myrepo",
      },
      {
        name: "startingBranch",
        type: "string",
        required: false,
        description: "Branch to start work from. Strongly recommended; some repos reject missing branch.",
        default: "auto-retry fallback: main, then master",
        example: "main",
      },
      {
        name: "title",
        type: "string",
        required: false,
        description: "Optional session title.",
        example: "Auth middleware tests",
      },
      {
        name: "automationMode",
        type: "string",
        required: false,
        description: "Optional Jules automation mode.",
        example: "AUTO_CREATE_PR",
      },
      {
        name: "requirePlanApproval",
        type: "boolean",
        required: false,
        description: "Require explicit plan approval before execution.",
        default: false,
        example: true,
      },
    ],
  },
  jules_list_sessions: {
    purpose: "List sessions with optional compact controls.",
    params: [
      {
        name: "pageSize",
        type: "integer",
        required: false,
        description: "Number of sessions per page (1-100).",
        default: 10,
        example: 5,
      },
      {
        name: "pageToken",
        type: "string",
        required: false,
        description: "Pagination token from previous response.",
        example: "NEXT_PAGE_TOKEN",
      },
      {
        name: "compact",
        type: "boolean",
        required: false,
        description: "Return minimal summary fields only.",
        default: false,
        example: true,
      },
      {
        name: "includePrompt",
        type: "boolean",
        required: false,
        description: "Include prompt text in response.",
        default: "true when compact=false, else false",
        example: false,
      },
      {
        name: "includeOutputs",
        type: "boolean",
        required: false,
        description: "Include outputs payloads (can be large).",
        default: "true when compact=false, else false",
        example: false,
      },
      {
        name: "includeSourceContext",
        type: "boolean",
        required: false,
        description: "Include sourceContext object.",
        default: "true when compact=false, else false",
        example: false,
      },
      {
        name: "maxPromptChars",
        type: "integer",
        required: false,
        description: "Truncate prompt to maximum characters (1-20000).",
        example: 500,
      },
    ],
  },
  jules_get_session: {
    purpose: "Get one session with optional compact controls.",
    params: [
      {
        name: "sessionId",
        type: "string",
        required: true,
        description: "Session identifier.",
        example: "12345678901234567890",
      },
      {
        name: "compact",
        type: "boolean",
        required: false,
        description: "Return minimal summary fields only.",
        default: false,
        example: true,
      },
      {
        name: "includePrompt",
        type: "boolean",
        required: false,
        description: "Include prompt text in response.",
        default: "true when compact=false, else false",
        example: false,
      },
      {
        name: "includeOutputs",
        type: "boolean",
        required: false,
        description: "Include outputs payloads (can be large).",
        default: "true when compact=false, else false",
        example: false,
      },
      {
        name: "includeSourceContext",
        type: "boolean",
        required: false,
        description: "Include sourceContext object.",
        default: "true when compact=false, else false",
        example: false,
      },
      {
        name: "maxPromptChars",
        type: "integer",
        required: false,
        description: "Truncate prompt to maximum characters (1-20000).",
        example: 500,
      },
    ],
  },
  jules_delete_session: {
    purpose: "Delete one session by sessionId.",
    params: [
      {
        name: "sessionId",
        type: "string",
        required: true,
        description: "Session identifier to delete.",
        example: "12345678901234567890",
      },
    ],
  },
  jules_list_activities: {
    purpose: "List activity events for a session.",
    params: [
      {
        name: "sessionId",
        type: "string",
        required: true,
        description: "Session identifier.",
        example: "12345678901234567890",
      },
      {
        name: "pageSize",
        type: "integer",
        required: false,
        description: "Number of activities per page (1-100).",
        default: 30,
        example: 30,
      },
      {
        name: "pageToken",
        type: "string",
        required: false,
        description: "Pagination token from previous response.",
        example: "NEXT_PAGE_TOKEN",
      },
    ],
  },
  jules_send_message: {
    purpose: "Send follow-up instruction to a session.",
    params: [
      {
        name: "sessionId",
        type: "string",
        required: true,
        description: "Session identifier.",
        example: "12345678901234567890",
      },
      {
        name: "prompt",
        type: "string",
        required: true,
        description: "Message to send to Jules in that session.",
        example: "Please include integration tests as well.",
      },
    ],
  },
  jules_approve_plan: {
    purpose: "Approve a waiting plan for a session.",
    params: [
      {
        name: "sessionId",
        type: "string",
        required: true,
        description: "Session identifier waiting for plan approval.",
        example: "12345678901234567890",
      },
    ],
  },
  jules_get_skill: {
    purpose: "Return built-in tool and parameter guidance for agents.",
    params: [
      {
        name: "toolName",
        type: "string",
        required: false,
        description: "Return details for one tool only.",
        example: "jules_create_session",
      },
      {
        name: "compact",
        type: "boolean",
        required: false,
        description: "Return compact summary (tool purpose + required params).",
        default: false,
        example: true,
      },
      {
        name: "includeExamples",
        type: "boolean",
        required: false,
        description: "Include example values in parameter docs.",
        default: true,
        example: true,
      },
    ],
  },
};

function buildSkillPayload({ toolName, compact, includeExamples }) {
  const normalizedToolName = optionalTrimmed(toolName);
  const showExamples = includeExamples !== false;

  const toolEntries = normalizedToolName
    ? Object.fromEntries(Object.entries(TOOL_REFERENCE).filter(([name]) => name === normalizedToolName))
    : TOOL_REFERENCE;

  if (normalizedToolName && !toolEntries[normalizedToolName]) {
    throw new Error(`Unknown toolName: ${normalizedToolName}`);
  }

  const payload = {
    server: {
      name: "jules-mcp-server",
      version: "0.2.0",
    },
    focus: "jules-tooling",
    description: "Tool and parameter guidance for agents interacting with Jules.",
    usageHints: [
      "Use source.canonicalSource from jules_list_sources as the jules_create_session source value.",
      "Pass startingBranch explicitly when possible for deterministic session creation.",
      "Use jules_list_sessions with compact=true for discovery.",
      "Use jules_get_session for one session detail.",
      "Enable includeOutputs only when reviewing final generated artifacts.",
    ],
  };

  payload.tools = compact
    ? Object.fromEntries(
      Object.entries(toolEntries).map(([name, info]) => [name, {
        purpose: info.purpose,
        requiredParams: (info.params || []).filter((param) => param.required).map((param) => param.name),
      }])
    )
    : Object.fromEntries(
      Object.entries(toolEntries).map(([name, info]) => [name, {
        ...info,
        params: showExamples
          ? info.params
          : (info.params || []).map((param) => {
            const { example, ...rest } = param;
            return rest;
          }),
      }])
    );

  if (compact === true) {
    payload.compact = true;
  }

  payload.includeExamples = showExamples;

  return payload;
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
  "jules_get_skill",
  {
    description: "Get built-in tool and parameter guidance for agents.",
    inputSchema: z.object({
      toolName: z.string().optional(),
      compact: z.boolean().optional(),
      includeExamples: z.boolean().optional(),
    }),
  },
  async ({ toolName, compact, includeExamples }) => {
    return textResult(buildSkillPayload({ toolName, compact, includeExamples }));
  }
);

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

    const sources = Array.isArray(result.sources)
      ? result.sources.map((source) => withCanonicalSource(source))
      : result.sources;

    return textResult({
      ...result,
      sources,
    });
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
    const candidates = sourceIdPathCandidates(normalizedSourceId);

    let lastError;
    for (const path of candidates) {
      try {
        const result = await julesRequest({ path });
        return textResult(withCanonicalSource(result));
      } catch (error) {
        lastError = error;
        if (error?.httpStatus !== 404) {
          break;
        }
      }
    }

    if (lastError?.httpStatus === 404) {
      const fallbackHint = normalizedSourceId.startsWith("sources/")
        ? normalizedSourceId.replace(/^sources\//, "")
        : `sources/${normalizedSourceId}`;
      throw new Error(
        `Source not found: ${normalizedSourceId}. Try using the exact value from jules_list_sources.canonicalSource (example: ${fallbackHint}).`
      );
    }

    throw lastError;
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
    const normalizedSource = normalizeSourceForSessionCreation(source);

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
    const tryCreateSession = async (branchName) => {
      const payload = {
        ...body,
        sourceContext: {
          ...body.sourceContext,
        },
      };

      if (branchName) {
        payload.sourceContext.githubRepoContext = {
          startingBranch: branchName,
        };
      }

      return julesRequest({
        method: "POST",
        path: "/sessions",
        body: payload,
      });
    };

    const branchCandidates = normalizedStartingBranch
      ? [normalizedStartingBranch]
      : [undefined, "main", "master"];

    let lastError;
    for (const branchCandidate of branchCandidates) {
      try {
        const result = await tryCreateSession(branchCandidate);
        return textResult(result);
      } catch (error) {
        lastError = error;
        const isInvalidArgument = error?.httpStatus === 400 && error?.apiStatus === "INVALID_ARGUMENT";
        if (!isInvalidArgument) {
          break;
        }
      }
    }

    if (lastError?.httpStatus === 400 && lastError?.apiStatus === "INVALID_ARGUMENT") {
      throw new Error(
        `Session creation failed with INVALID_ARGUMENT for source '${normalizedSource}'. `
        + "This often means the branch is required for that repository. "
        + "Please set startingBranch explicitly (for example: 'main' or 'master')."
      );
    }

    throw lastError;
  }
);

server.registerTool(
  "jules_list_sessions",
  {
    description: "List your Jules sessions (supports compact response controls).",
    inputSchema: z.object({
      ...paginationSchema,
      compact: z.boolean().optional(),
      includePrompt: z.boolean().optional(),
      includeOutputs: z.boolean().optional(),
      includeSourceContext: z.boolean().optional(),
      maxPromptChars: z.number().int().min(1).max(20000).optional(),
    }),
  },
  async ({ pageSize, pageToken, compact, includePrompt, includeOutputs, includeSourceContext, maxPromptChars }) => {
    const result = await julesRequest({
      path: "/sessions",
      query: {
        pageSize,
        pageToken,
      },
    });

    const sessions = Array.isArray(result.sessions)
      ? result.sessions.map((session) =>
        sanitizeSession(session, {
          compact,
          includePrompt,
          includeOutputs,
          includeSourceContext,
          maxPromptChars,
        })
      )
      : result.sessions;

    return textResult({
      ...result,
      sessions,
    });
  }
);

server.registerTool(
  "jules_get_session",
  {
    description: "Get details for a Jules session (supports compact response controls).",
    inputSchema: z.object({
      sessionId: z.string().min(1),
      compact: z.boolean().optional(),
      includePrompt: z.boolean().optional(),
      includeOutputs: z.boolean().optional(),
      includeSourceContext: z.boolean().optional(),
      maxPromptChars: z.number().int().min(1).max(20000).optional(),
    }),
  },
  async ({ sessionId, compact, includePrompt, includeOutputs, includeSourceContext, maxPromptChars }) => {
    const normalizedSessionId = requireNonEmpty(sessionId, "sessionId");
    const result = await julesRequest({
      path: `/sessions/${encodeURIComponent(normalizedSessionId)}`,
    });

    return textResult(
      sanitizeSession(result, {
        compact,
        includePrompt,
        includeOutputs,
        includeSourceContext,
        maxPromptChars,
      })
    );
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
