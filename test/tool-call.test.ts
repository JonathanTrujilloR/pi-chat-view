import { test } from "node:test";
import assert from "node:assert/strict";

import { classifyToolCall, summarizeInput } from "../src/model/tool-call.ts";

test("classifyToolCall: Pi built-ins and the Collie NAMES table", () => {
  const cases: [string, Record<string, unknown>, unknown][] = [
    ["bash", { command: "ls -la" }, { kind: "execute", command: "ls -la" }],
    ["bash", { command: "npm test", description: "Run tests" }, { kind: "execute", command: "npm test", description: "Run tests" }],
    ["read", { path: "src/a.ts" }, { kind: "read", path: "src/a.ts" }],
    ["read", { path: "src/a.ts", offset: 10, limit: 5 }, { kind: "read", path: "src/a.ts", range: [10, 15] }],
    ["edit", { path: "src/a.ts", edits: [] }, { kind: "edit", path: "src/a.ts" }],
    ["write", { path: "b.md", content: "x" }, { kind: "edit", path: "b.md" }],
    ["grep", { pattern: "TODO", path: "src" }, { kind: "search", query: "TODO", where: "src" }],
    ["find", { pattern: "*.ts", path: "src" }, { kind: "search", query: "*.ts", where: "src" }],
    ["ls", { path: "src" }, { kind: "search", query: "src" }],
    ["web_fetch", { url: "https://x.dev" }, { kind: "fetch", url: "https://x.dev" }],
    ["web_search", { query: "pi tui" }, { kind: "search", query: "pi tui", where: "web" }],
    ["rm", { path: "a.txt" }, { kind: "delete", path: "a.txt" }],
    ["move", { from: "a", to: "b" }, { kind: "move", path: "a", to: "b" }],
    ["subagent_run", { agent: "sdd-apply", task: "Do the thing", label: "Apply T1" }, { kind: "task", agent: "sdd-apply", summary: "Apply T1" }],
    ["task", { description: "Explore repo" }, { kind: "task", summary: "Explore repo" }],
    ["Task", { subagent_type: "explore", task: "Find x" }, { kind: "task", agent: "explore", summary: "Find x" }],
    ["mcp__context7__query", { query: "react" }, { kind: "other", name: "mcp__context7__query", summary: "react" }],
    ["frobnicate", { level: 3 }, { kind: "other", name: "frobnicate", summary: "" }],
  ];
  for (const [name, input, want] of cases) {
    assert.deepEqual(classifyToolCall(name, input), want, name);
  }
});

test("classifyToolCall: a question is recognised by questions[] shape, beating the name", () => {
  const input = {
    questions: [
      { header: "Mode", question: "Which mode?", multiSelect: false, options: [{ label: "A", description: "first" }, "B"] },
      { question: "  ", options: ["skip me"] },
    ],
  };
  // `bash` would be execute by name, but the shape wins.
  assert.deepEqual(classifyToolCall("bash", input), {
    kind: "question",
    name: "bash",
    summary: "Which mode?",
    questions: [{ header: "Mode", question: "Which mode?", multiple: false, options: [{ label: "A", description: "first" }, { label: "B" }] }],
  });
  assert.equal(classifyToolCall("ask_user_question", { questions: [{ question: "Q?", options: ["x"], multiple: true }] }).kind, "question");
});

test("classifyToolCall: ask_user_choice (single question + options) wraps into one question", () => {
  assert.deepEqual(classifyToolCall("ask_user_choice", { question: "Pick one", options: ["red", { label: "blue" }] }), {
    kind: "question",
    name: "ask_user_choice",
    summary: "Pick one",
    questions: [{ question: "Pick one", multiple: false, options: [{ label: "red" }, { label: "blue" }] }],
  });
});

test("classifyToolCall: an empty or malformed questions[] is not a question", () => {
  const cases: Record<string, unknown>[] = [
    { questions: [] },
    { questions: [{ question: "no options" }] },
    { questions: "nope" },
    { question: "no options here" },
  ];
  for (const input of cases) assert.equal(classifyToolCall("ask", input).kind, "other", JSON.stringify(input));
});

test("summarizeInput: picks the defining argument, else the first string", () => {
  const cases: [unknown, string][] = [
    [{ pattern: "x", path: "src" }, "x"],
    [{ command: "echo a\n  echo b" }, "echo a echo b"],
    [{ unknown: 1, note: "hello" }, "hello"],
    [{ questions: [{ question: "Why?" }] }, "Why?"],
    [undefined, ""],
    [{ q: "a".repeat(300) }, `${"a".repeat(200)}…`],
  ];
  for (const [input, want] of cases) assert.equal(summarizeInput(input), want);
});

test("classifyToolCall: Gentle's own tools read as their kind, not as 'other'", () => {
  assert.deepEqual(classifyToolCall("bash_background", { command: "docker build ." }), { kind: "execute", command: "docker build ." });
  assert.deepEqual(classifyToolCall("fetch_content", { url: "https://pi.dev" }), { kind: "fetch", url: "https://pi.dev" });
  assert.deepEqual(classifyToolCall("fetch_content", { urls: ["https://a.dev", "https://b.dev"] }), { kind: "fetch", url: "https://a.dev https://b.dev" });
  assert.deepEqual(classifyToolCall("read_symbol", { path: "src/a.ts", symbol: "run" }), { kind: "read", path: "src/a.ts" });
  assert.deepEqual(classifyToolCall("read_enclosing", { path: "src/a.ts", line: 4 }), { kind: "read", path: "src/a.ts" });
});

test("Engram's mem_* tools, plain or namespaced, are read as Engram actions", () => {
  const cases: [string, Record<string, unknown>, { action: string; subject: string }][] = [
    ["mem_save", { title: "Fixed the bug", content: "x" }, { action: "saved", subject: "Fixed the bug" }],
    ["mcp__engram__mem_save", { title: "T", content: "x" }, { action: "saved", subject: "T" }],
    ["mem_update", { id: 6333, title: "New title" }, { action: "updated", subject: "New title" }],
    ["mem_update", { id: 6333, content: "c" }, { action: "updated", subject: "#6333" }],
    ["mem_search", { query: "chat view" }, { action: "searched", subject: "chat view" }],
    ["mem_context", {}, { action: "context", subject: "" }],
    ["mem_get_observation", { id: "42" }, { action: "read", subject: "#42" }],
    ["mem_session_summary", { content: "long" }, { action: "session summary", subject: "" }],
    ["mem_delete", { id: 7 }, { action: "delete", subject: "#7" }],
  ];
  for (const [name, args, engram] of cases) {
    const call = classifyToolCall(name, args);
    assert.equal(call.kind, "other", name);
    assert.deepEqual(call.kind === "other" && call.badge, { glyph: "🧠", ...engram, label: "Engram" }, name);
  }
  assert.equal((classifyToolCall("memo_save", {}) as { badge?: unknown }).badge, undefined);
  assert.equal((classifyToolCall("bash", { command: "mem_save" }) as { badge?: unknown }).badge, undefined);
});

test("classifyToolCall: Gentle's RDD review tools read as '🌹 rdd <operation>'", () => {
  const rdd = (name: string, args: Record<string, unknown>) => {
    const b = (classifyToolCall(name, args) as { badge?: { glyph: string; action: string; subject: string; label: string } }).badge;
    return b === undefined ? undefined : { action: b.action, subject: b.subject };
  };
  assert.deepEqual(rdd("gentle_review", { operation: "inspect" }), { action: "rdd inspect", subject: "" });
  assert.deepEqual(rdd("gentle_review", { operation: "start", input: { mode: "ordinary" } }), { action: "rdd start", subject: "" });
  assert.deepEqual(rdd("gentle_review", {}), { action: "rdd", subject: "" });
  assert.deepEqual(rdd("gentle_review_capture", { lineageId: "x" }), { action: "rdd capture", subject: "" });
  assert.deepEqual(rdd("gentle_review_capture_group", {}), { action: "rdd capture group", subject: "" }); // Gentle's own title
  assert.deepEqual(rdd("gentle_review_scope", {}), { action: "rdd scope", subject: "" });
  assert.equal(rdd("bash", { command: "ls" }), undefined);
});
