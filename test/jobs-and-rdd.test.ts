// Closer to Gentle's own cards.

import { test } from "node:test";
import assert from "node:assert/strict";

import { itemsFromEntries, type ChatItem, type SessionEntryLike } from "../src/model/items.ts";
import { runSummary } from "../src/model/group.ts";
import { classifyToolCall } from "../src/model/tool-call.ts";
import { noticeKey, renderChatRows } from "../src/view/render.ts";
import { deps, strip } from "./fake-deps.ts";

const action = (name: string, args: Record<string, unknown>) => (classifyToolCall(name, args) as { badge?: { action: string } }).badge?.action;
const binding = (lens: string) => JSON.stringify({ artifactSubject: { lens } });

test("RDD actions are spelled as Gentle titles them", () => {
  assert.equal(action("gentle_review", { operation: "acknowledge-approved" }), "rdd acknowledge approved");
  assert.equal(action("gentle_review", { operation: "inspect" }), "rdd inspect");
  assert.equal(action("gentle_review", {}), "rdd");
  assert.equal(action("gentle_review_scope", {}), "rdd scope");
  assert.equal(action("gentle_review_capture", { collectBinding: binding("review-risk") }), "rdd capture · risk");
  assert.equal(action("gentle_review_capture", {}), "rdd capture");
  assert.equal(action("gentle_review_capture_group", { collectBindings: [binding("review-risk"), binding("reliability"), "not json"] }), "rdd capture group · risk · reliability");
  assert.equal(action("gentle_review_capture_group", {}), "rdd capture group");
});

const call = (id: string, name: string, args: Record<string, unknown>) => ({ type: "toolCall", id, name, arguments: args });
const msg = (id: string, message: Record<string, unknown>): SessionEntryLike => ({ type: "message", id, message });
const result = (toolCallId: string, text: string, isError = false) => msg(`r-${toolCallId}`, { role: "toolResult", toolCallId, content: [{ type: "text", text }], isError });

test("an RDD step carries the first segment of Gentle's result summary, dim", () => {
  const items = itemsFromEntries([
    msg("a", { role: "assistant", content: [
      call("g1", "gentle_review", { operation: "start" }),
      call("g2", "gentle_review", { operation: "inspect" }),
      call("g3", "gentle_review", { operation: "inspect" }),
      call("g4", "gentle_review_scope", {}),
    ] }),
    result("g1", JSON.stringify({ status: "ready", action: "start", next_transition: { reason_code: "fresh_target_ready" } })),
    result("g2", JSON.stringify({ result: { state: "closed", outcome: "native-approved" } })),
    result("g3", "plain text, not an envelope"),
    result("g4", JSON.stringify({ hash: "a".repeat(64) })),
  ]);
  const rows = renderChatRows(items.slice(0, 1), 60, deps).lines;
  assert.equal(strip(rows[0]!), "✓ 🌹 rdd start · ready");
  assert.equal(rows[0], "<dim>✓</dim> <muted>🌹 rdd start</muted><dim> · ready</dim>");
  assert.equal(strip(renderChatRows(items.slice(1, 2), 60, deps).lines[0]!), "✓ 🌹 rdd inspect · closed");
  assert.equal(strip(renderChatRows(items.slice(2, 3), 60, deps).lines[0]!), "✓ 🌹 rdd inspect", "not derivable: today's row");
  // An envelope with nothing to summarize: Gentle says "1 field", which is no outcome; nothing appended.
  assert.equal(strip(renderChatRows(items.slice(3, 4), 60, deps).lines[0]!), "✓ 🌹 rdd scope");
  for (const width of [8, 20]) for (const l of renderChatRows(items, width, deps).lines) assert.ok(deps.visibleWidth(l) <= width);
});

test("runs count RDD steps by name", () => {
  const tool = (id: string, name: string, args: Record<string, unknown> = {}): ChatItem => ({ id, kind: "tool", status: "done", tool: classifyToolCall(name, args) });
  assert.equal(runSummary([tool("a", "gentle_review"), tool("b", "gentle_review_scope"), tool("c", "gentle_review"), tool("d", "gentle_review")]).summary, "4 rdd steps");
  assert.equal(runSummary([tool("a", "bash", { command: "ls" }), tool("b", "bash", { command: "ls" }), tool("c", "gentle_review")]).summary, "2 commands, 1 rdd step");
  assert.equal(runSummary([tool("a", "mem_save"), tool("b", "gentle_review")]).summary, "1 rdd step, 1 other step");
});

// --- Background job notices ---

const job = (content: string, gentleJobs?: Record<string, unknown>): SessionEntryLike =>
  ({ type: "custom_message", id: "j1", customType: "gentle-jobs.notice", content, display: true, ...(gentleJobs ? { details: { gentleJobs } } : {}) }) as SessionEntryLike;
const TEXT = 'Background job job-3 ("tests") exited with code 1 after 2m 5s.\nCommand: npm test\nLast output:\nFAIL a.test.ts\nFull output: /tmp/x.log (read it with the read tool if you need more).';

test("a job notice folds to '› ⧗ Background job · <label> · exited <code> after <dur>', red when it failed", () => {
  const items = itemsFromEntries([job(TEXT, { label: "tests", kind: "job", status: "exited", exitCode: 1 })]);
  const r = renderChatRows(items, 70, deps);
  assert.deepEqual(r.lines.map(strip), ["› ⧗ Background job · tests · exited 1 after 2m 5s"]);
  assert.match(r.lines[0]!, /^<error>/);
  assert.equal(r.targets[0], noticeKey("j1"));
  const open = renderChatRows(items, 70, deps, { expanded: (k) => k === noticeKey("j1") });
  const text = open.lines.map(strip);
  assert.equal(text[0], "⌄ ⧗ Background job · tests · exited 1 after 2m 5s");
  assert.ok(text.includes("  Command: npm test"), JSON.stringify(text));
  assert.ok(text.includes("  FAIL a.test.ts"));
});

test("a clean exit is dim; without details the text is parsed; a monitor says Monitor", () => {
  const ok = renderChatRows(itemsFromEntries([job(TEXT.replace("code 1", "code 0"))]), 70, deps).lines;
  assert.deepEqual(ok.map(strip), ["› ⧗ Background job · tests · exited 0 after 2m 5s"]);
  assert.match(ok[0]!, /^<dim>/);
  const mon = 'Monitor job-9 ("watch logs") exited with code 0 after 12s, 4 events.\nCommand: tail -f x';
  assert.deepEqual(renderChatRows(itemsFromEntries([job(mon, { kind: "monitor", label: "watch logs", status: "exited", exitCode: 0 })]), 70, deps).lines.map(strip), ["› ⧗ Monitor · watch logs · exited 0 after 12s"]);
  const stopped = 'Background job job-2 ("build") was stopped by the user after 3s.\nCommand: make';
  assert.deepEqual(renderChatRows(itemsFromEntries([job(stopped, { label: "build", status: "stopped", exitCode: null })]), 70, deps).lines.map(strip), ["› ⧗ Background job · build · stopped after 3s"]);
  const odd = renderChatRows(itemsFromEntries([job("something else entirely")]), 70, deps).lines.map(strip);
  assert.deepEqual(odd, ["› ⧗ Background job · something else entirely"]);
});

test("job rows fit the width; other notices are unchanged", () => {
  const items = itemsFromEntries([job(TEXT, { label: "a very long job label indeed", exitCode: 1, status: "exited" })]);
  for (const width of [6, 20, 40]) for (const l of renderChatRows(items, width, deps).lines) assert.ok(deps.visibleWidth(l) <= width, JSON.stringify(strip(l)));
  const other = itemsFromEntries([{ type: "custom_message", id: "o", customType: "x", content: "short note", display: true } as SessionEntryLike]);
  assert.equal(strip(renderChatRows(other, 40, deps).lines[0]!).trim(), "short note");
});

test("a job notice whose command shares the first line still reads its outcome", () => {
  const [n] = itemsFromEntries([{ type: "custom_message", id: "j", parentId: null, timestamp: "2026-10-27T10:00:00.000Z", customType: "gentle-jobs.notice", display: true,
    content: 'Background job job-2 ("deploy") exited with code 2 after 5s. Command: ./deploy.sh', details: { gentleJobs: { label: "deploy", exitCode: 2 } } } as SessionEntryLike]);
  assert.equal((n as { title?: string }).title, "⧗ Background job · deploy · exited 2 after 5s");
  assert.equal((n as { error?: boolean }).error, true);
});

test("a monitor's progress notice ('reported N new lines:') reads like Gentle's Monitor card", () => {
  const [n] = itemsFromEntries([{ type: "custom_message", id: "m", parentId: null, timestamp: "2026-10-27T10:00:00.000Z", customType: "gentle-jobs.notice", display: true,
    content: 'Monitor job-4 ("watch task 46 pushes") reported 1 new line:\npush 2026-11-01 03:02:00 accepted' } as SessionEntryLike]);
  assert.equal((n as { title?: string }).title, "⧗ Monitor · watch task 46 pushes · 1 new line");
});
