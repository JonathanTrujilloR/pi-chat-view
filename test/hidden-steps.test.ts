// Gentle's internal steps are hidden; stale agent results show as a folded notice.

import { test } from "node:test";
import assert from "node:assert/strict";

import { createItemsBuilder, isHiddenTool, HIDDEN_TOOLS, itemsFromEntries, type ChatItem, type SessionEntryLike } from "../src/model/items.ts";
import { noticeKey, renderChatRows } from "../src/view/render.ts";
import { deps, strip } from "./fake-deps.ts";

const msg = (id: string, message: Record<string, unknown>): SessionEntryLike => ({ type: "message", id, message });
const call = (id: string, name: string, args: Record<string, unknown> = {}) => ({ type: "toolCall", id, name, arguments: args });
const result = (toolCallId: string, text = "lots of internal output") => msg(`r-${toolCallId}`, { role: "toolResult", toolCallId, toolName: "x", content: [{ type: "text", text }], isError: false });

test("the hidden set: Gentle's internal tools, one predicate", () => {
  for (const name of ["gentle_odd_phase", "orchestrator_session_id", "orchestrator_list", "orchestrator_consult", "orchestrator_send_message", "job_list", "job_stop", "subagent_list_tasks", "subagent_list_agents", "subagent_status"]) {
    assert.equal(isHiddenTool(name), true, name);
  }
  for (const name of ["subagent_run", "subagent_result", "bash", "bash_background", "todo"]) assert.equal(isHiddenTool(name), false, name);
  assert.ok(HIDDEN_TOOLS.has("job_stop"));
});

const session: SessionEntryLike[] = [
  msg("u", { role: "user", content: "go" }),
  msg("a1", { role: "assistant", content: [call("h1", "gentle_odd_phase"), call("c1", "bash", { command: "ls" }), call("h2", "orchestrator_list"), call("c2", "bash", { command: "pwd" }), call("h3", "subagent_status")] }),
  result("h1"), result("c1", "a"), result("h2"), result("c2", "b"), result("h3"),
  msg("a2", { role: "assistant", content: [call("h4", "job_list"), call("h5", "job_stop"), call("h6", "orchestrator_consult")] }),
  result("h4"), result("h5"), result("h6"),
  msg("a3", { role: "assistant", content: [{ type: "text", text: "done" }] }),
];

test("hidden steps make no item, their results no orphan, and they do not count", () => {
  const items = itemsFromEntries(session);
  assert.deepEqual(items.map((i) => (i.kind === "tool" ? i.tool.kind === "execute" && i.tool.command : i.kind)), ["user", "ls", "pwd", "reply"]);
  const text = renderChatRows(items, 60, deps).lines.map(strip).map((l) => l.trimEnd());
  assert.deepEqual(text, ["▎ You", "▎ go", "", "✓ $ ls", "", "✓ $ pwd", "", "done"]);
  // A run of hidden steps only: no empty run row.
  assert.ok(!text.some((l) => /^› ?$|other step/.test(l)));
});

test("hidden steps while streaming and still running draw nothing either", () => {
  const streaming = { role: "assistant", content: [call("s1", "gentle_odd_phase"), call("s2", "bash", { command: "x" })], timestamp: 9 };
  const items = itemsFromEntries(session.slice(0, 2), { streaming, runningToolCallIds: new Set(["h1"]) });
  assert.ok(!items.some((i) => i.kind === "tool" && i.tool.kind === "other"), JSON.stringify(items.map((i) => i.id)));
});

test("the incremental builder equals a full build with hidden steps", () => {
  const b = createItemsBuilder();
  for (let n = 1; n <= session.length; n++) {
    const opts = { streaming: { role: "assistant", content: [call(`s${n}`, "job_list")], timestamp: 100 + n }, runningToolCallIds: new Set<string>() };
    assert.deepEqual(b.build(session.slice(0, n), opts), itemsFromEntries(session.slice(0, n), opts), `n=${n}`);
  }
});

// --- Stale agent results ---

const stale = (data: Record<string, unknown>): SessionEntryLike => ({ type: "custom", id: "st", customType: "gentle-agents.stale-result", data } as SessionEntryLike);

test("a stale agent result is a folded notice that opens to Gentle's two sentences", () => {
  const items = itemsFromEntries([stale({ taskId: "t3", agent: "explore", label: "map repo", status: "timed_out", ageSeconds: 75 })]);
  assert.equal(items.length, 1);
  const n = items[0] as Extract<ChatItem, { kind: "notice" }>;
  assert.equal(n.title, "❀  Stale agent result · explore · task t3");
  assert.equal(
    n.text,
    'Subagent explore (task t3, "map repo") timed out about 75s ago, while the orchestrator was still busy.\n' +
      "Marked stale: the result was not replayed into the conversation. It stays available through subagent_status and subagent_result.",
  );
  const r = renderChatRows(items, 70, deps);
  assert.deepEqual(r.lines.map(strip), ["› ❀  Stale agent result · explore · task t3"]);
  assert.equal(r.targets[0], noticeKey("st"));
  const open = renderChatRows(items, 70, deps, { expanded: () => true }).lines.map(strip);
  assert.ok(open.length > 2 && open[1]!.startsWith("  Subagent explore"));
});

test("stale ages and defaults follow Gentle's renderer; other custom entries stay dropped", () => {
  const text = (data: Record<string, unknown>) => (itemsFromEntries([stale(data)])[0] as Extract<ChatItem, { kind: "notice" }>).text.split("\n")[0];
  assert.match(text({ ageSeconds: 89 })!, /about 89s ago/);
  assert.match(text({ ageSeconds: 90 })!, /about 2m ago/);
  assert.match(text({ ageSeconds: 3599 })!, /about 60m ago/);
  assert.match(text({ ageSeconds: 7300 })!, /about 2h ago/);
  assert.equal(text({}), 'Subagent Subagent (task unknown, "") unknown about 0s ago, while the orchestrator was still busy.');
  assert.equal((itemsFromEntries([stale({})])[0] as { title?: string }).title, "❀  Stale agent result · Subagent · task unknown");
  assert.deepEqual(itemsFromEntries([{ type: "custom", id: "c", customType: "other", data: {} } as SessionEntryLike]), []);
  for (const width of [6, 20]) for (const l of renderChatRows(itemsFromEntries([stale({ agent: "x".repeat(40) })]), width, deps).lines) assert.ok(deps.visibleWidth(l) <= width);
});
