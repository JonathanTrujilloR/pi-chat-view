// Readable badge cards.

import { test } from "node:test";
import assert from "node:assert/strict";

import { itemsFromEntries, type ChatItem, type SessionEntryLike } from "../src/model/items.ts";
import { classifyToolCall, rddSummary } from "../src/model/tool-call.ts";
import { cardKey, outputKey, renderChatRows } from "../src/view/render.ts";
import { deps, strip } from "./fake-deps.ts";

const W = 50;
const ENVELOPE = JSON.stringify({ status: "ready", action: "start", next_transition: { reason_code: "fresh_target_ready" }, binding: "b".repeat(300) });
const msg = (id: string, message: Record<string, unknown>): SessionEntryLike => ({ type: "message", id, message });
function rdd(text: string): ChatItem {
  return itemsFromEntries([
    msg("a", { role: "assistant", content: [{ type: "toolCall", id: "g1", name: "gentle_review", arguments: { operation: "inspect" } }] }),
    msg("r", { role: "toolResult", toolCallId: "g1", content: [{ type: "text", text }], isError: false }),
  ])[0]!;
}
const openCard = (item: ChatItem, extra: string[] = [], width = W) => {
  const keys = new Set([cardKey(item.id), ...extra]);
  return renderChatRows([item], width, deps, { expanded: (k) => keys.has(k) });
};
/** Title, then body rows, borders dropped; "├" marks the rule. */
const boxed = (r: { lines: string[] }) =>
  r.lines.map(strip).flatMap((l) => {
    if (l.startsWith("╭ ")) return [l.slice(2).replace(/ ─*╮$/, "")];
    if (l.startsWith("├")) return ["├"];
    if (l.startsWith("╰")) return [];
    return [l.slice(2, -2).trimEnd()];
  });

test("rddSummary: every segment of Gentle's summary, in its order, without repeats", () => {
  assert.deepEqual(rddSummary(ENVELOPE), ["ready", "start", "fresh_target_ready"]);
  assert.deepEqual(rddSummary(JSON.stringify({ status: "x", state: "x", result: { outcome: "x" } })), ["x"]);
  assert.equal(rddSummary("not json"), undefined);
  assert.equal(rddSummary(JSON.stringify({ hash: "a".repeat(64) })), undefined);
});

test("an RDD card: titled like its row, the summary as its body, the JSON behind '› Raw output'", () => {
  const item = rdd(ENVELOPE);
  const tool = (item as Extract<ChatItem, { kind: "tool" }>).tool;
  assert.equal(tool.kind === "other" && tool.badge?.result, "ready");
  assert.equal(tool.kind === "other" && tool.badge?.summary, "ready · start · fresh_target_ready");
  const r = openCard(item);
  assert.deepEqual(boxed(r), ["✓ 🌹 rdd inspect", "ready · start · fresh_target_ready", "├", "› Raw output · 1 line"]);
  assert.equal(r.targets[3], outputKey("g1"));
  const raw = boxed(openCard(item, [outputKey("g1")]));
  assert.equal(raw[3], "⌄ Raw output · 1 line");
  assert.ok(raw.length > 6, "the raw JSON, wrapped");
  for (const width of [8, 20, 50]) for (const l of openCard(item, [outputKey("g1")], width).lines) assert.ok(deps.visibleWidth(l) <= width);
});

test("an RDD card without a derivable summary keeps today's output row", () => {
  const r = boxed(openCard(rdd("plain text answer")));
  assert.equal(r[0], "✓ 🌹 rdd inspect");
  assert.ok(!r.includes("inspect"), "the action is not repeated as a body row");
  assert.equal(r.at(-1), "› Output · 1 line");
});

test("other badge cards: title follows the closed row; body keeps the useful part only", () => {
  const item = (name: string, args: Record<string, unknown>, id: string): ChatItem => ({ id, kind: "tool", status: "done", tool: classifyToolCall(name, args) });
  assert.deepEqual(boxed(openCard(item("mem_save", { title: "Fixed it", content: "long" }, "e1"))), ["✓ 🧠 saved", "Fixed it"]);
  assert.deepEqual(boxed(openCard(item("mem_context", {}, "e2"))), ["✓ 🧠 context"]);
  assert.deepEqual(boxed(openCard(item("codemode", { code: "const a = 1;\n  return a;" }, "e3"))), ["✓ λ code", "const a = 1;", "  return a;"]);
  assert.deepEqual(boxed(openCard(item("todo", { action: "write", title: "Ship" }, "e4"))), ["✓ ❀  todo write", "Ship"]);
  assert.deepEqual(boxed(openCard(item("subagent_result", { task_id: "t7" }, "e5"))), ["✓ ❀  agent result", "t7"]);
  for (const width of [6, 14]) for (const l of openCard(item("mem_save", { title: "x ".repeat(30) }, "e6"), [], width).lines) assert.ok(deps.visibleWidth(l) <= width);
});
