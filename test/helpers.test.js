import { assertEquals, assert } from "https://deno.land/std/assert/mod.ts";
import {
  extractOutputs,
  sanitizeSession,
  slimActivity,
  sourceMatchesFilter
} from "../claude.js";

Deno.test("extractOutputs", () => {
  const session = {
    outputs: [
      { pullRequest: { url: "pr1" } },
      { files: ["file1", "file2"] },
      { changeSet: { id: "cs1" } }
    ]
  };
  const result = extractOutputs(session);
  assertEquals(result.pullRequests, [{ url: "pr1" }]);
  assertEquals(result.files, ["file1", "file2"]);
  assertEquals(result.changeSets, [{ id: "cs1" }]);

  const empty = extractOutputs({});
  assertEquals(empty.pullRequests, []);
  assertEquals(empty.files, []);
  assertEquals(empty.changeSets, []);
});

Deno.test("sanitizeSession", () => {
  const session = {
    id: "s1",
    title: "t1",
    state: "QUEUED",
    prompt: "This is a very long prompt that should be truncated when maxPromptChars is used",
    outputs: [{ test: "out" }],
    sourceContext: { source: "my/repo" },
    extraField: "should be kept unless compact"
  };

  const compact = sanitizeSession(session, { compact: true });
  assertEquals(compact.id, "s1");
  assertEquals(compact.title, "t1");
  assertEquals(compact.state, "QUEUED");
  assertEquals(compact.source, "my/repo");
  assertEquals(compact.prompt, undefined);
  assertEquals(compact.outputs, undefined);
  assertEquals(compact.extraField, undefined);

  const truncated = sanitizeSession(session, { maxPromptChars: 15 });
  assertEquals(truncated.prompt, "This is a very  …(truncated 64 chars)");
  assertEquals(truncated.extraField, "should be kept unless compact");
});

Deno.test("slimActivity", () => {
  const a1 = {
    id: "a1",
    planGenerated: { plan: "some plan" }
  };
  const s1 = slimActivity(a1);
  assertEquals(s1.type, "planGenerated");

  const a2 = {
    id: "a2",
    progressUpdated: { agentMessage: { content: "A".repeat(400) } }
  };
  const s2 = slimActivity(a2);
  assertEquals(s2.type, "progressUpdated");
  assertEquals(s2.message?.length, 301); // 300 + 1 for ellipsis
});

Deno.test("sourceMatchesFilter", () => {
  const source = {
    name: "github/owner/repo",
    githubRepo: { owner: "owner", repo: "repo" }
  };
  assert(sourceMatchesFilter(source, "owner/repo"));
  assert(sourceMatchesFilter(source, "repo"));
  assert(sourceMatchesFilter(source, "github"));
  assert(!sourceMatchesFilter(source, "wrong"));
});
