// Gentle's own tools and agent notices look like Gentle.

import { test } from "node:test";
import assert from "node:assert/strict";

import { itemsFromEntries, type ChatItem, type ChatToolCall, type SessionEntryLike } from "../src/model/items.ts";
import { classifyToolCall } from "../src/model/tool-call.ts";
import { cardKey, renderChatRows } from "../src/view/render.ts";
import { deps, strip } from "./fake-deps.ts";

const badge = (name: string, args: Record<string, unknown>) => (classifyToolCall(name, args) as { badge?: unknown }).badge;

test("badges: Engram and RDD keep their look through the one badge field", () => {
  assert.deepEqual(badge("mcp__engram__mem_save", { title: "T" }), { glyph: "🧠", action: "saved", subject: "T", label: "Engram" });
  assert.deepEqual(badge("gentle_review", { operation: "inspect" }), { glyph: "🌹", action: "rdd inspect", subject: "", label: "RDD" });
});

test("codemode: λ code and the script's first non-empty line", () => {
  assert.deepEqual(badge("codemode", { code: "\n\n  const a = await mcp.x();\nreturn a;" }), { glyph: "λ", action: "code", subject: "const a = await mcp.x();", label: "Code", body: "  const a = await mcp.x();\nreturn a;" });
  assert.deepEqual(badge("codemode", {}), { glyph: "λ", action: "code", subject: "", label: "Code" });
});

test("todo: ❀  todo <action> and the title when there is one", () => {
  assert.deepEqual(badge("todo", { action: "add", title: "Write tests" }), { glyph: "❀", action: "todo add", subject: "Write tests", label: "Todos" });
  assert.deepEqual(badge("todo", { action: "list" }), { glyph: "❀", action: "todo list", subject: "", label: "Todos" });
  assert.deepEqual(badge("todo", {}), { glyph: "❀", action: "todo", subject: "", label: "Todos" });
});

test("subagent tools: ❀  agent <action> and the task id, label or agent; subagent_run stays a task", () => {
  const cases: [string, Record<string, unknown>, string, string][] = [
    ["subagent_result", { task_id: "t7" }, "agent result", "t7"],
    ["subagent_status", {}, "agent status", ""],
    ["subagent_continue", { task_id: "t2", message: "go" }, "agent continue", "t2"],
    ["subagent_cancel", { label: "scan" }, "agent cancel", "scan"],
    ["subagent_send_message", { agent: "explore" }, "agent send message", "explore"],
    ["subagent_reply", { task_id: "t1" }, "agent reply", "t1"],
    ["subagent_list_tasks", {}, "agent list tasks", ""],
    ["subagent_list_agents", {}, "agent list agents", ""],
  ];
  for (const [name, args, action, subject] of cases) {
    assert.deepEqual(badge(name, args), { glyph: "❀", action, subject, label: "Agents" }, name);
  }
  assert.equal(classifyToolCall("subagent_run", { agent: "x", task: "y" }).kind, "task");
  assert.equal(badge("subagent_frobnicate", {}), undefined);
  assert.equal(badge("bash", { command: "todo" }), undefined);
});

test("rows and cards: glyph + action, muted; card title is the label; width-safe", () => {
  const item = (tool: ChatToolCall, id: string): ChatItem => ({ id, kind: "tool", status: "done", tool });
  const code = item(classifyToolCall("codemode", { code: "return 1" }), "c1");
  const todo = item(classifyToolCall("todo", { action: "add", title: "Ship" }), "c2");
  const agent = item(classifyToolCall("subagent_result", { task_id: "t7" }), "c3");
  const line = (i: ChatItem) => strip(renderChatRows([i], 40, deps).lines[0]!);
  assert.equal(line(code), "✓ λ code return 1");
  assert.equal(line(todo), "✓ ❀  todo add Ship");
  assert.equal(line(agent), "✓ ❀  agent result t7");
  assert.equal(renderChatRows([code], 40, deps).lines[0], "<dim>✓</dim> <muted>λ code return 1</muted>");
  const title = (i: ChatItem) => strip(renderChatRows([i], 40, deps, { expanded: (k) => k === cardKey(i.id) }).lines[0]!);
  // Titled like the closed row.
  assert.match(title(code), /^╭ ✓ λ code ─+╮$/);
  assert.match(title(todo), /^╭ ✓ ❀ {2}todo add ─+╮$/);
  assert.match(title(agent), /^╭ ✓ ❀ {2}agent result ─+╮$/);
  for (const width of [5, 12]) {
    for (const i of [code, todo, agent]) for (const l of renderChatRows([i], width, deps).lines) assert.ok(deps.visibleWidth(l) <= width);
  }
});

// --- Agent notices ---

const custom = (customType: string, content: string, details?: unknown): SessionEntryLike =>
  ({ type: "custom_message", id: customType, customType, content, display: true, details }) as SessionEntryLike;
const notices = (entries: SessionEntryLike[]) => itemsFromEntries(entries).map((i) => (i.kind === "notice" ? i.text : `<${i.kind}>`));

test("agent notices carry Gentle's labels, agent from details when present", () => {
  const ga = (agent?: string, taskId?: string) => ({ gentleAgents: { ...(agent ? { agent } : {}), ...(taskId ? { taskId } : {}) } });
  assert.deepEqual(notices([custom("gentle-agents.result", "  Found 3 bugs.\n", ga("explore", "t1"))]), ["❀  Agent result · explore · Found 3 bugs."]);
  assert.deepEqual(notices([custom("gentle-agents.result", "Done.")]), ["❀  Agent result · Done."]);
  assert.deepEqual(notices([custom("gentle-agents.message", "Need a decision", ga("review", "t2"))]), ["❀  review message · Need a decision"]);
  assert.deepEqual(notices([custom("gentle-agents.message", "hi")]), ["❀  Subagent message · hi"]);
  assert.deepEqual(notices([custom("gentle-agents.orchestrator-message", "From the other session")]), ["❀  Session message · From the other session"]);
  assert.deepEqual(notices([custom("gentle-agents.stale-result", "Subagent x went stale")]), ["❀  Stale agent result · Subagent x went stale"]);
  assert.deepEqual(notices([custom("gentle-jobs.notice", "job done")]), ["job done"], "others unchanged");
  assert.deepEqual(notices([custom("gentle-agents.result", "   ")]), [], "nothing to say: no notice");
});

test("the custom role path labels agent notices the same way", () => {
  const entry: SessionEntryLike = {
    type: "message",
    id: "m1",
    message: { role: "custom", customType: "gentle-agents.result", content: "ok", display: true, details: { gentleAgents: { agent: "explore" } } },
  };
  assert.deepEqual(notices([entry]), ["❀  Agent result · explore · ok"]);
});

test("a long agent notice still folds like any long notice", () => {
  const r = renderChatRows(itemsFromEntries([custom("gentle-agents.result", "word ".repeat(40), { gentleAgents: { agent: "explore" } })]), 50, deps);
  assert.equal(r.lines.length, 1);
  assert.match(strip(r.lines[0]!), /^› ❀  Agent result · explore · word/);
});

test("the ❀ glyph is followed by two spaces: terminal fonts draw it wider than its one column", async () => {
  const { classifyToolCall } = await import("../src/model/tool-call.ts");
  const { stepLine } = await import("../src/model/group.ts");
  const { itemsFromEntries } = await import("../src/model/items.ts");
  assert.equal(stepLine(classifyToolCall("todo", { action: "write" })).verb, "❀  todo write");
  assert.equal(stepLine(classifyToolCall("codemode", { code: "x" })).verb, "λ code");
  const [n] = itemsFromEntries([{ type: "custom_message", id: "c", parentId: null, timestamp: "2026-10-27T10:00:00.000Z", customType: "gentle-agents.orchestrator-message", display: true, content: "hi" }]);
  assert.equal((n as { text: string }).text, "❀  Session message · hi");
});
