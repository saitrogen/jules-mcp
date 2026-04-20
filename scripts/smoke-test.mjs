import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

const expectedTools = new Set([
    "jules_list_sources",
    "jules_get_source",
    "jules_create_session",
    "jules_list_sessions",
    "jules_get_session",
    "jules_delete_session",
    "jules_list_activities",
    "jules_send_message",
    "jules_approve_plan",
]);

function parseToolTextResult(toolResult) {
    const first = toolResult?.content?.find((item) => item?.type === "text");
    if (!first?.text) {
        return null;
    }

    try {
        return JSON.parse(first.text);
    } catch {
        return null;
    }
}

async function main() {
    const stderrChunks = [];

    const transport = new StdioClientTransport({
        command: process.execPath,
        args: [path.join(projectRoot, "index.js")],
        cwd: projectRoot,
        env: {
            ...process.env,
            JULES_API_KEY: process.env.JULES_API_KEY,
            JULES_BASE_URL: process.env.JULES_BASE_URL,
        },
        stderr: "pipe",
    });

    if (transport.stderr) {
        transport.stderr.on("data", (chunk) => {
            stderrChunks.push(chunk.toString("utf8"));
        });
    }

    const client = new Client({
        name: "jules-mcp-smoke-test",
        version: "0.1.0",
    });

    try {
        await client.connect(transport);
        console.log("✅ Connected to MCP server");

        const toolsResult = await client.listTools();
        const toolNames = new Set((toolsResult.tools || []).map((t) => t.name));

        for (const tool of expectedTools) {
            if (!toolNames.has(tool)) {
                throw new Error(`Missing expected tool: ${tool}`);
            }
        }

        console.log(`✅ Tool discovery passed (${toolNames.size} tools reported)`);

        if (!process.env.JULES_API_KEY) {
            console.log("⚠️  JULES_API_KEY is not set; skipping live API check.");
            console.log("✅ Smoke test passed (protocol/tooling checks)");
            return;
        }

        const listSourcesResult = await client.callTool({
            name: "jules_list_sources",
            arguments: { pageSize: 1 },
        });

        if (listSourcesResult.isError) {
            const errText = listSourcesResult.content?.[0]?.text || "Unknown tool error";
            throw new Error(`Live API check failed: ${errText}`);
        }

        const parsed = parseToolTextResult(listSourcesResult);
        const sourceCount = Array.isArray(parsed?.sources) ? parsed.sources.length : 0;

        console.log(`✅ Live Jules API call passed (received ${sourceCount} source item(s) on first page)`);
        console.log("✅ Smoke test passed");
    } finally {
        await client.close();

        if (stderrChunks.length) {
            const stderrText = stderrChunks.join("").trim();
            if (stderrText) {
                console.log("ℹ️  Server stderr:");
                console.log(stderrText);
            }
        }
    }
}

main().catch((error) => {
    console.error("❌ Smoke test failed:", error instanceof Error ? error.message : String(error));
    process.exit(1);
});
