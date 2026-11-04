import { test } from "node:test";
import assert from "node:assert/strict";

import { itemsFromEntries, MAX_OUTPUT_CHARS, type ChatItem, type SessionEntryLike } from "../src/model/items.ts";

const TS = "2026-10-27T10:00:00.000Z";
let n = 0;
function msg(message: Record<string, unknown>, id = `e${++n}`): SessionEntryLike {
  return { type: "message", id, parentId: null, timestamp: TS, message };
}
function call(id: string, name: string, args: Record<string, unknown>) {
  return { type: "toolCall", id, name, arguments: args };
}
function result(toolCallId: string, text: string, isError = false) {
  return msg({ role: "toolResult", toolCallId, toolName: "x", content: [{ type: "text", text }], isError, timestamp: 1 });
}
function tools(items: ChatItem[]) {
  return items.filter((i): i is Extract<ChatItem, { kind: "tool" }> => i.kind === "tool");
}

test("user, reply and thinking map one block to one item, blanks dropped", () => {
  const items = itemsFromEntries([
    msg({ role: "user", content: "hello", timestamp: 1 }, "u1"),
    msg({ role: "user", content: [{ type: "text", text: "a" }, { type: "image", data: "x", mimeType: "image/png" }, { type: "text", text: "  " }], timestamp: 1 }, "u2"),
    msg({ role: "assistant", content: [{ type: "thinking", thinking: "hmm" }, { type: "thinking", thinking: "", redacted: true }, { type: "text", text: "Hi **there**" }], stopReason: "stop", timestamp: 1 }, "a1"),
  ]);
  assert.deepEqual(items, [
    { id: "u1:0", ts: TS, kind: "user", text: "hello" },
    { id: "u2:0", ts: TS, kind: "user", text: "a", images: 1, imageData: [{ type: "image", data: "x", mimeType: "image/png" }] },
    { id: "a1:0", ts: TS, kind: "thinking", text: "hmm" },
    { id: "a1:2", ts: TS, kind: "reply", text: "Hi **there**" },
  ]);
});

test("toolResult attaches by toolCallId: done, isError → failed, blocked → denied, none → running", () => {
  const items = itemsFromEntries([
    msg({ role: "assistant", content: [
      call("c1", "bash", { command: "ls" }),
      call("c2", "bash", { command: "false" }),
      call("c3", "edit", { path: "a.ts" }),
      call("c4", "read", { path: "b.ts" }),
    ], stopReason: "toolUse", timestamp: 1 }),
    result("c1", "a\nb"),
    result("c2", "Command exited with code 1", true),
    result("c3", "Tool execution was blocked: not allowed", true),
  ]);
  const got = tools(items).map((i) => [i.id, i.status]);
  assert.deepEqual(got, [["c1", "done"], ["c2", "failed"], ["c3", "denied"], ["c4", "running"]]);
  assert.deepEqual(tools(items)[0]!.tool, { kind: "execute", command: "ls", exitCode: 0, output: "a\nb" });
  assert.deepEqual(tools(items)[1]!.tool, { kind: "execute", command: "false", exitCode: 1, output: "Command exited with code 1" });
  // edit and read carry no output.
  assert.deepEqual(tools(items)[2]!.tool, { kind: "edit", path: "a.ts" });
});

test("an extension's own block reason is a plain failure, not denied (Collie rule)", () => {
  const items = itemsFromEntries([
    msg({ role: "assistant", content: [call("c1", "bash", { command: "rm -rf /" })], stopReason: "toolUse", timestamp: 1 }),
    result("c1", "Blocked by policy", true),
  ]);
  assert.equal(tools(items)[0]!.status, "failed");
});

test("tool output is capped and ANSI-stripped", () => {
  const items = itemsFromEntries([
    msg({ role: "assistant", content: [call("c1", "bash", { command: "yes" })], stopReason: "toolUse", timestamp: 1 }),
    result("c1", `\x1b[31m${"y\n".repeat(10000)}`),
  ]);
  const tool = tools(items)[0]!.tool;
  assert.equal(MAX_OUTPUT_CHARS, 16000);
  assert.equal(tool.kind === "execute" && tool.output?.length, MAX_OUTPUT_CHARS);
  // Capped: the total line count rides along, so the view can say how many lines were cut.
  assert.equal(tool.outputLines, 10000);
  assert.equal(tool.kind === "execute" && tool.output?.startsWith("y\ny\n"), true);
});

test("an orphan result with text becomes an `other` tool carrying its output", () => {
  const items = itemsFromEntries([result("gone", "late output")]);
  assert.deepEqual(tools(items).map((i) => [i.tool, i.status]), [[{ kind: "other", name: "x", summary: "", output: "late output" }, "done"]]);
});

test("bashExecution → notice; custom_message display gates; compaction / branch_summary → compacted", () => {
  const items = itemsFromEntries([
    msg({ role: "bashExecution", command: "git status", output: "clean", exitCode: 0, cancelled: false, truncated: false, timestamp: 1 }, "b1"),
    msg({ role: "bashExecution", command: "make", output: "", exitCode: 2, cancelled: false, truncated: false, timestamp: 1 }, "b2"),
    msg({ role: "bashExecution", command: "sleep 9", output: "", exitCode: undefined, cancelled: true, truncated: false, timestamp: 1 }, "b3"),
    { type: "custom_message", id: "cm1", parentId: null, timestamp: TS, customType: "x", content: "hidden", display: false },
    { type: "custom_message", id: "cm2", parentId: null, timestamp: TS, customType: "x", content: [{ type: "text", text: "shown" }], display: true },
    { type: "compaction", id: "k1", parentId: null, timestamp: TS, summary: "recap" },
    { type: "branch_summary", id: "k2", parentId: null, timestamp: TS, summary: "" },
  ]);
  assert.deepEqual(items, [
    { id: "b1", ts: TS, kind: "notice", text: "$ git status" },
    { id: "b2", ts: TS, kind: "notice", text: "$ make · exit 2" },
    { id: "b3", ts: TS, kind: "notice", text: "$ sleep 9 · cancelled" },
    { id: "cm2", ts: TS, kind: "notice", text: "shown" },
    { id: "k1", ts: TS, kind: "compacted", text: "recap" },
    { id: "k2", ts: TS, kind: "compacted" },
  ]);
});

test("system, model_change, usage, label, custom, session_info and thinking_level_change draw nothing", () => {
  const items = itemsFromEntries([
    msg({ role: "system", content: "You are…", timestamp: 1 }),
    { type: "model_change", id: "m", parentId: null, timestamp: TS },
    { type: "thinking_level_change", id: "t", parentId: null, timestamp: TS },
    { type: "usage", id: "u", parentId: null, timestamp: TS },
    { type: "label", id: "l", parentId: null, timestamp: TS },
    { type: "custom", id: "c", parentId: null, timestamp: TS, customType: "x" },
    { type: "session_info", id: "s", parentId: null, timestamp: TS },
    { type: "context_edit", id: "ce", parentId: null, timestamp: TS },
  ]);
  assert.deepEqual(items, []);
});

test("assistant stopReason error/aborted adds a notice with errorMessage after the turn", () => {
  const items = itemsFromEntries([
    msg({ role: "assistant", content: [{ type: "text", text: "partial" }], stopReason: "aborted", errorMessage: "Operation aborted", timestamp: 1 }, "a1"),
    msg({ role: "assistant", content: [], stopReason: "error", errorMessage: "\x1b[1m429 rate limited", timestamp: 1 }, "a2"),
    msg({ role: "assistant", content: [], stopReason: "error", timestamp: 1 }, "a3"),
    msg({ role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop", errorMessage: "ignored", timestamp: 1 }, "a4"),
  ]);
  assert.deepEqual(items, [
    { id: "a1:0", ts: TS, kind: "reply", text: "partial" },
    { id: "a1:stop", ts: TS, kind: "notice", text: "Operation aborted" },
    { id: "a2:stop", ts: TS, kind: "notice", text: "429 rate limited" },
    { id: "a4:0", ts: TS, kind: "reply", text: "ok" },
  ]);
});

test("a streaming partial is appended with the partial flag on reply and thinking", () => {
  const items = itemsFromEntries([msg({ role: "user", content: "go", timestamp: 1 }, "u1")], {
    streaming: {
      role: "assistant",
      content: [{ type: "thinking", thinking: "plan" }, { type: "text", text: "Work" }, call("s1", "bash", { command: "ls" })],
      timestamp: Date.parse(TS),
    },
  });
  assert.deepEqual(items, [
    { id: "u1:0", ts: TS, kind: "user", text: "go" },
    { id: "streaming:0", ts: TS, kind: "thinking", text: "plan", partial: true },
    { id: "streaming:1", ts: TS, kind: "reply", text: "Work", partial: true },
    { id: "s1", ts: TS, kind: "tool", tool: { kind: "execute", command: "ls" }, status: "running" },
  ]);
});

test("runningToolCallIds: a stale unresolved call from an earlier turn is failed; live and queued stay running", () => {
  const entries = [
    msg({ role: "assistant", content: [call("old", "bash", { command: "a" })], stopReason: "toolUse", timestamp: 1 }),
    msg({ role: "user", content: "next", timestamp: 1 }),
    msg({ role: "assistant", content: [call("live", "bash", { command: "b" }), call("queued", "bash", { command: "c" })], stopReason: "toolUse", timestamp: 1 }),
  ];
  const status = (opts?: Parameters<typeof itemsFromEntries>[1]) => tools(itemsFromEntries(entries, opts)).map((i) => [i.id, i.status]);
  // Without the set every unresolved call is running (Collie's rule).
  assert.deepEqual(status(), [["old", "running"], ["live", "running"], ["queued", "running"]]);
  assert.deepEqual(status({ runningToolCallIds: new Set(["live"]) }), [["old", "failed"], ["live", "running"], ["queued", "running"]]);
});

test("a question's answer rides on `output`: details.answers first, else the result text", () => {
  const ask = (id: string) =>
    call(id, "ask_user_question", {
      questions: [
        { question: "Which DB?", options: ["Postgres", "SQLite"] },
        { question: "Extras?", multiple: true, options: ["cache", "queue"] },
      ],
    });
  const withDetails = (toolCallId: string, details: unknown, text = "ignored", isError = false) =>
    msg({ role: "toolResult", toolCallId, toolName: "ask_user_question", content: [{ type: "text", text }], details, isError, timestamp: 1 });
  const items = itemsFromEntries([
    msg({ role: "assistant", content: [ask("q1"), ask("q2"), ask("q3"), ask("q4"), ask("q5")], stopReason: "toolUse", timestamp: 1 }),
    withDetails("q1", { answers: [["Postgres"], ["cache", "queue"]] }),
    withDetails("q2", { answers: { "Which DB?": "SQLite", "Extras?": { answers: ["queue"] } } }),
    withDetails("q3", undefined, "User chose: Postgres"),
    withDetails("q4", { answers: {} }, "", false),
    withDetails("q5", undefined, "User dismissed the question", true),
  ]);
  const outputs = tools(items).map((i) => (i.tool.kind === "question" ? i.tool.output : "not a question"));
  assert.deepEqual(outputs, ["Postgres · cache, queue", "SQLite · queue", "User chose: Postgres", undefined, undefined]);
  assert.deepEqual(tools(items).map((i) => i.status), ["done", "done", "done", "done", "failed"]);
});

test("edit diff: from details.patch, else details.diff, else the call's own arguments", () => {
  const edit = (id: string, args: Record<string, unknown>, name = "edit") => call(id, name, args);
  const res = (toolCallId: string, details: unknown) =>
    msg({ role: "toolResult", toolCallId, toolName: "edit", content: [{ type: "text", text: "ok" }], details, isError: false, timestamp: 1 });
  const items = itemsFromEntries([
    msg({ role: "assistant", content: [
      edit("e1", { path: "a.ts", edits: [{ oldText: "x", newText: "y" }] }),
      edit("e2", { path: "a.ts", edits: [{ oldText: "x", newText: "y" }] }),
      edit("e3", { path: "a.ts", edits: [{ oldText: "a\nb", newText: "c" }, { oldText: "d", newText: "e" }] }),
      edit("e4", { file_path: "b.ts", old_string: "1", new_string: "2" }),
      edit("e5", { path: "new.md", content: "# hi\nthere" }, "write"),
    ], stopReason: "toolUse", timestamp: 1 }),
    res("e1", { patch: "--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,2 @@\n keep\n-x\n+y\n\\ No newline at end of file", diff: "ignored" }),
    res("e2", { diff: " 1 keep\n-2 x\n+2 y" }),
    res("e3", undefined),
    res("e4", {}),
    res("e5", undefined),
  ]);
  const diffs = tools(items).map((i) => (i.tool.kind === "edit" ? [i.tool.diff, i.tool.write ?? false] : "not an edit"));
  assert.deepEqual(diffs, [
    [[{ op: "@", text: "@@ -1,2 +1,2 @@" }, { op: " ", text: "keep" }, { op: "-", text: "x" }, { op: "+", text: "y" }], false],
    [[{ op: " ", text: "1 keep" }, { op: "-", text: "2 x" }, { op: "+", text: "2 y" }], false],
    [[{ op: "-", text: "a" }, { op: "-", text: "b" }, { op: "+", text: "c" }, { op: "@", text: "" }, { op: "-", text: "d" }, { op: "+", text: "e" }], false],
    [[{ op: "-", text: "1" }, { op: "+", text: "2" }], false],
    [[{ op: "+", text: "# hi" }, { op: "+", text: "there" }], true],
  ]);
});

test("a failed call keeps its error text as output, whatever its kind; a denied one does not", () => {
  const items = itemsFromEntries([
    msg({ role: "assistant", content: [call("e1", "edit", { path: "a.ts" }), call("r1", "read", { path: "b.ts" })], stopReason: "toolUse", timestamp: 1 }),
    result("e1", "Could not find oldText in a.ts", true),
    result("r1", "file body"),
  ]);
  const [e, r] = tools(items);
  assert.equal(e!.status, "failed");
  assert.equal(e!.tool.output, "Could not find oldText in a.ts");
  assert.equal(r!.tool.output, undefined, "a read's file body is not output");
});

test("images: counted on the user turn and on the tool result, text kept as before", () => {
  const img = { type: "image", data: "x", mimeType: "image/png" };
  const items = itemsFromEntries([
    msg({ role: "user", content: [img, img], timestamp: 1 }, "u1"),
    msg({ role: "assistant", content: [call("r1", "read", { path: "a.png" }), call("b1", "bash", { command: "shot" })], stopReason: "toolUse", timestamp: 1 }),
    msg({ role: "toolResult", toolCallId: "r1", toolName: "read", content: [{ type: "text", text: "Read image" }, img], isError: false, timestamp: 1 }),
    msg({ role: "toolResult", toolCallId: "b1", toolName: "bash", content: [{ type: "text", text: "ok" }, img, img, img], isError: false, timestamp: 1 }),
    msg({ role: "toolResult", toolCallId: "gone", toolName: "shot", content: [img], isError: false, timestamp: 1 }, "o1"),
  ]);
  assert.deepEqual(items[0], { id: "u1:images", ts: TS, kind: "user", text: "", images: 2, imageData: [img, img] });
  const [read, bash, orphan] = tools(items);
  assert.deepEqual(read!.tool, { kind: "read", path: "a.png", images: 1, imageData: [img] });
  assert.deepEqual(bash!.tool, { kind: "execute", command: "shot", exitCode: 0, output: "ok", images: 3, imageData: [img, img, img] });
  assert.deepEqual(orphan!.tool, { kind: "other", name: "shot", summary: "", images: 1, imageData: [img] });
});

test("image data is kept by reference, not copied, and only well-formed blocks count as drawable", () => {
  const data = "A".repeat(1000);
  const img = { type: "image", data, mimeType: "image/png" };
  const broken = { type: "image", data: 42, mimeType: "image/png" };
  const items = itemsFromEntries([
    msg({ role: "user", content: [{ type: "text", text: "see" }, img, broken], timestamp: 1 }, "u1"),
    msg({ role: "assistant", content: [call("r1", "read", { path: "a.png" })], stopReason: "toolUse", timestamp: 1 }),
    msg({ role: "toolResult", toolCallId: "r1", toolName: "read", content: [img], isError: false, timestamp: 1 }),
  ]);
  const u = items[0] as Extract<ChatItem, { kind: "user" }>;
  assert.equal(u.images, 2, "the count is every image block");
  assert.equal(u.imageData!.length, 1);
  assert.equal(u.imageData![0], img, "same object");
  assert.equal(tools(items)[0]!.tool.imageData![0], img);
});

test("a system-generated user turn (Gentle Agents wake) is not drawn: Terminal hides it too", () => {
  const wake =
    "[System-generated Gentle Agents notification, not written by the user] Subagent output was delivered to this session above. Review it and continue. [gentle-agents wake: 02296254-7ee2-493a-90eb-1cd7212440c1]";
  const items = itemsFromEntries([
    msg({ role: "user", content: "hola", timestamp: 1 }, "u1"),
    msg({ role: "user", content: wake, timestamp: 2 }, "u2"),
    msg({ role: "user", content: [{ type: "text", text: wake }], timestamp: 3 }, "u3"),
  ]);
  assert.deepEqual(items.map((i) => [i.kind, "text" in i ? i.text : undefined]), [["user", "hola"]]);
});

test("a user turn that merely mentions the marker later stays the user's message", () => {
  const items = itemsFromEntries([msg({ role: "user", content: "why does it say [System-generated X, not written by the user]?", timestamp: 1 }, "u1")]);
  assert.equal(items[0]!.kind, "user");
});

test("Gentle's ask_user_question answers ({questionIndex, question, kind, answer}[]) show in question order", () => {
  const ask = { type: "toolCall", id: "q1", name: "ask_user_question", arguments: { questions: [
    { question: "Side?", options: [{ label: "Left" }, { label: "Right" }] },
    { question: "Size?", options: [{ label: "S" }, { label: "M" }] },
  ] } };
  const items = itemsFromEntries([
    msg({ role: "assistant", content: [ask], stopReason: "toolUse", timestamp: 1 }),
    msg({ role: "toolResult", toolCallId: "q1", toolName: "ask_user_question", isError: false, timestamp: 2,
      content: [{ type: "text", text: "1. Side? — Right\n2. Size? — M" }],
      details: { answers: [
        { questionIndex: 1, question: "Size?", kind: "option", answer: "M" },
        { questionIndex: 0, question: "Side?", kind: "option", answer: "Right" },
      ] } }),
  ]);
  const q = tools(items)[0]!;
  assert.equal(q.status, "done");
  assert.equal((q.tool as { output?: string }).output, "Right · M");
});

test("Gentle AI's review preflight message is a notice labelled like Gentle's card", () => {
  const items = itemsFromEntries([
    { type: "custom_message", id: "p1", parentId: null, timestamp: TS, customType: "gentle-pi.review-preflight", display: true, content: "Receipt-driven development is enabled." } as SessionEntryLike,
  ]);
  assert.deepEqual(items.map((i) => [i.kind, "text" in i ? i.text : ""]), [["notice", "✿ Gentle AI · review preflight · Receipt-driven development is enabled."]]);
});

test("Gentle's multi-select answers ({kind: 'multi', answer: null, selected: [...]}) show with the single ones", () => {
  const ask = { type: "toolCall", id: "q2", name: "ask_user_question", arguments: { questions: [
    { question: "Areas?", multiSelect: true, options: [{ label: "Caja" }, { label: "Inventario" }, { label: "Reportes" }] },
    { question: "Origin?", options: [{ label: "Quejas" }, { label: "Revisa" }] },
  ] } };
  const items = itemsFromEntries([
    msg({ role: "assistant", content: [ask], stopReason: "toolUse", timestamp: 1 }),
    msg({ role: "toolResult", toolCallId: "q2", toolName: "ask_user_question", isError: false, timestamp: 2,
      content: [{ type: "text", text: "1. Areas? — selected: Inventario, Reportes\n2. Origin? — Quejas" }],
      details: { answers: [
        { questionIndex: 0, question: "Areas?", kind: "multi", answer: null, selected: ["Inventario", "Reportes"] },
        { questionIndex: 1, question: "Origin?", kind: "option", answer: "Quejas" },
      ] } }),
  ]);
  assert.equal((tools(items)[0]!.tool as { output?: string }).output, "Inventario, Reportes · Quejas");
  assert.deepEqual((tools(items)[0]!.tool as { chosen?: string[][] }).chosen, [["Inventario", "Reportes"], ["Quejas"]]);
});

test("a failed question keeps the first line of why it failed, and no answer", () => {
  const ask = { type: "toolCall", id: "q9", name: "ask_user_question", arguments: { questions: [{ question: "X?", options: [{ label: "a" }] }] } };
  const items = itemsFromEntries([
    msg({ role: "assistant", content: [ask], stopReason: "toolUse", timestamp: 1 }),
    msg({ role: "toolResult", toolCallId: "q9", toolName: "ask_user_question", isError: true, timestamp: 2,
      content: [{ type: "text", text: "Validation failed for tool \"ask_user_question\":\n  - questions.1.header: too long" }] }),
  ]);
  const q = tools(items)[0]!;
  assert.equal(q.status, "failed");
  assert.equal((q.tool as { failure?: string }).failure, 'Validation failed for tool "ask_user_question":');
  assert.equal((q.tool as { output?: string }).output, undefined);
});

test("ask_user_choice's result text ('User selected: 1. Label (value: x)') shows as just the label", () => {
  const ask = { type: "toolCall", id: "c7", name: "ask_user_choice", arguments: { question: "Tipo?", options: [{ label: "Porcentaje", value: "porcentaje" }, { label: "Monto fijo", value: "fijo" }] } };
  const items = itemsFromEntries([
    msg({ role: "assistant", content: [ask], stopReason: "toolUse", timestamp: 1 }),
    msg({ role: "toolResult", toolCallId: "c7", toolName: "ask_user_choice", isError: false, timestamp: 2, content: [{ type: "text", text: "User selected: 1. Porcentaje (value: porcentaje)" }] }),
  ]);
  const q = tools(items)[0]!.tool as { output?: string; chosen?: string[][] };
  assert.equal(q.output, "Porcentaje");
  assert.deepEqual(q.chosen, [["Porcentaje"]]);
});
