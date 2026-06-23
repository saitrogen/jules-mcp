import { assertEquals, assert } from "https://deno.land/std/assert/mod.ts";

function extractOutputs(session) {
  const prs = [], files = [], changeSets = [];
  for (const out of session?.outputs ?? []) {
    if (out?.pullRequest) prs.push(out.pullRequest);
    if (Array.isArray(out?.files)) files.push(...out.files);
    if (out?.changeSet) changeSets.push(out.changeSet);
  }
  return { pullRequests: prs, files, changeSets };
}

function sanitizeSession(session, { compact, includePrompt, includeOutputs, includeSourceContext, maxPromptChars } = {}) {
  if (!compact && includePrompt === undefined && includeOutputs === undefined && includeSourceContext === undefined && !maxPromptChars) return session;
  const s = compact
    ? { name: session?.name, id: session?.id, title: session?.title, state: session?.state, archived: session?.archived, createTime: session?.createTime, updateTime: session?.updateTime, url: session?.url }
    : { ...session };
  const wantPrompt  = compact ? false : (includePrompt  !== false);
  const wantOutputs = compact ? false : (includeOutputs !== false);
  const wantSource  = compact ? false : (includeSourceContext !== false);
  if (compact && session?.sourceContext?.source) s.source = session.sourceContext.source;
  if (!wantPrompt)  delete s.prompt;
  else if (maxPromptChars && typeof s.prompt === "string" && s.prompt.length > maxPromptChars)
    s.prompt = s.prompt.slice(0, maxPromptChars) + ` …(truncated ${s.prompt.length - maxPromptChars} chars)`;
  if (!wantOutputs) delete s.outputs;
  if (!wantSource)  delete s.sourceContext;
  return s;
}

function slimActivity(a) {
  if (!a || typeof a !== "object") return a;
  const slim = { id: a.id, createTime: a.createTime, originator: a.originator };
  if (a.planGenerated) slim.type = "planGenerated";
  else if (a.planApproved) slim.type = "planApproved";
  else if (a.sessionCompleted) slim.type = "sessionCompleted";
  else if (a.progressUpdated) {
    slim.type = "progressUpdated";
    const msg = a.progressUpdated?.agentMessage?.content;
    if (msg) slim.message = msg.length > 300 ? msg.slice(0, 300) + "…" : msg;
  }
  else if (a.userMessage) slim.type = "userMessage";
  else slim.type = Object.keys(a).find(k => !["name","createTime","originator","id"].includes(k)) ?? "unknown";
  if (a.artifacts) slim.artifactCount = Array.isArray(a.artifacts) ? a.artifacts.length : 1;
  return slim;
}

function sourceMatchesFilter(source, query) {
  if (!query) return true;
  const q = query.toLowerCase();
  return [source?.name, source?.id, source?.githubRepo?.owner, source?.githubRepo?.repo,
    source?.githubRepo?.owner && source?.githubRepo?.repo ? `${source.githubRepo.owner}/${source.githubRepo.repo}` : undefined]
    .filter(Boolean).some(v => String(v).toLowerCase().includes(q));
}

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
