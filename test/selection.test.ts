// Text selection stays in the chat.

import { test } from "node:test";
import assert from "node:assert/strict";

import type { ChatItem } from "../src/model/items.ts";
import { ChatView, MARGIN } from "../src/view/chat-view.ts";
import { copyToClipboard } from "../src/view/clipboard.ts";
import { cardKey, renderChatRows, thinkingKey } from "../src/view/render.ts";
import { strip, viewDeps } from "./fake-deps.ts";

const W = 30;
const say = (id: string, n: number): ChatItem => ({ id, kind: "reply", text: Array.from({ length: n }, (_, i) => `${id}${i}`).join("\n") });
function make(items: ChatItem[], height = 6) {
  const copies: string[] = [];
  const v = new ChatView({ ...viewDeps, renderLines: (its, width, expanded) => renderChatRows(its, width, viewDeps, { expanded }) });
  v.setItems(items);
  v.targetHeight = height;
  v.onCopy = (text) => void copies.push(text);
  v.render(W);
  return { v, copies };
}
// `x` is a content column; the screen column adds the margin.
const ev = (type: string, x: number, y: number, button = "left") => ({ type, button, x: x + MARGIN, y });
const shown = (v: ChatView) => v.render(W).slice(1).map((l) => strip(l).slice(MARGIN).trimEnd());

test("a press on chat text starts a chat selection and captures the mouse", () => {
  const { v } = make([say("a", 20)]);
  assert.deepEqual(v.handleMouse(ev("press", 1, 1)), { handled: true, capture: true });
  assert.equal(v.hasSelection(), true);
});

test("a drag across rows selects in chat-line coordinates; release copies the text", () => {
  const { v, copies } = make([say("a", 20)]); // rows 1-5: a15..a19
  v.handleMouse(ev("press", 1, 1));
  assert.deepEqual(v.handleMouse(ev("drag", 1, 3)), { handled: true });
  assert.deepEqual(v.selection(), { start: { line: 15, col: 1 }, end: { line: 17, col: 1 } });
  assert.deepEqual(v.handleMouse(ev("release", 1, 3)), { handled: true });
  assert.deepEqual(copies, ["15\na16\na1"]);
  // Backwards gives the same range.
  const back = make([say("a", 20)]);
  back.v.handleMouse(ev("press", 1, 3));
  back.v.handleMouse(ev("drag", 1, 1));
  back.v.handleMouse(ev("release", 1, 1));
  assert.deepEqual(back.copies, ["15\na16\na1"]);
});

test("the highlight covers only the selected cells of visible chat rows, within the width", () => {
  const { v } = make([say("a", 20)]);
  v.handleMouse(ev("press", 1, 1));
  v.handleMouse(ev("drag", 1, 3));
  const lines = v.render(W);
  assert.doesNotMatch(lines[0]!, /selectedBg/, "header");
  assert.equal(lines[1], `  a<selectedBg>15</selectedBg>${" ".repeat(25)}`);
  assert.match(lines[2]!, /^ {2}<selectedBg>a16<\/selectedBg> +$/);
  assert.match(lines[3]!, /^ {2}<selectedBg>a1<\/selectedBg>7 +$/);
  assert.doesNotMatch(lines[4]!, /selectedBg/);
  for (const l of lines) assert.equal(viewDeps.visibleWidth(l), W);
});

test("copied text drops styles, the user bar and box borders, and trims trailing spaces", () => {
  const user: ChatItem = { id: "u", kind: "user", text: "hello" };
  const tool: ChatItem = { id: "c1", kind: "tool", status: "done", tool: { kind: "execute", command: "ls -la" } };
  const { v, copies } = make([user, tool], 12);
  v.toggle(cardKey("c1"));
  // Rows: 1 ▎ You, 2 ▎ hello, 3 blank, 4 ╭ ✓ Run ─╮, 5 │ $ ls -la │, 6 ╰─╯
  assert.deepEqual(shown(v).slice(0, 2), ["▎ You", "▎ hello"]);
  v.handleMouse(ev("press", 0, 1));
  v.handleMouse(ev("drag", W - 1, 2));
  v.handleMouse(ev("release", W - 1, 2));
  v.handleMouse(ev("press", 0, 5));
  v.handleMouse(ev("drag", W - 1, 5));
  v.handleMouse(ev("release", W - 1, 5));
  assert.deepEqual(copies, ["You\nhello", "$ ls -la"]);
});

test("press and release without moving: a toggle toggles once and copies nothing; plain text clears", () => {
  const thought: ChatItem = { id: "th", kind: "thinking", text: "t0\nt1" };
  const { v, copies } = make([say("a", 1), thought], 6); // 1 a0, 2 blank, 3 › t0 …
  assert.deepEqual(v.handleMouse(ev("press", 2, 3)), { handled: true });
  assert.deepEqual(v.handleMouse(ev("release", 2, 3)), { handled: true });
  assert.deepEqual(v.handleMouse(ev("click", 2, 3)), { handled: true });
  assert.equal(v.isExpanded(thinkingKey("th")), true);
  assert.equal(v.hasSelection(), false);
  // A selection, then a still click on plain text: cleared, nothing copied.
  v.handleMouse(ev("press", 0, 1));
  v.handleMouse(ev("drag", 1, 1));
  v.handleMouse(ev("release", 1, 1));
  assert.equal(copies.length, 1);
  v.handleMouse(ev("press", 0, 1));
  v.handleMouse(ev("release", 0, 1));
  v.handleMouse(ev("click", 0, 1));
  assert.equal(v.hasSelection(), false);
  assert.equal(copies.length, 1);
});

test("header, pinned rows and the rule start no selection, and Pi gets no press to select the screen with", () => {
  const { v } = make([say("a", 20)]);
  assert.deepEqual(v.handleMouse(ev("press", 3, 0)), { handled: true });
  assert.equal(v.hasSelection(), false);
  assert.equal(v.handleMouse(ev("press", 3, 1, "right")), undefined);
  assert.equal(v.handleMouse(ev("move", 3, 1, "none")), undefined);
  assert.equal(v.handleMouse(ev("drag", 3, 1)), undefined, "no selection in progress");
});

test("a selection survives a scroll", () => {
  const { v } = make([say("a", 20)]);
  v.handleMouse(ev("press", 0, 1));
  v.handleMouse(ev("drag", 2, 2));
  v.handleMouse(ev("release", 2, 2));
  v.scrollBy(-2); // window a13..a17: a15 on row 3
  const lines = v.render(W);
  assert.match(lines[3]!, /^ {2}<selectedBg>a15<\/selectedBg>/);
  assert.match(lines[4]!, /^ {2}<selectedBg>a16<\/selectedBg>/);
  assert.doesNotMatch(lines[1]! + lines[2]! + lines[5]!, /selectedBg/);
});

test("dragging past the top or bottom edge scrolls one line per event", () => {
  const { v, copies } = make([say("a", 20)]);
  v.scrollBy(-5); // window a10..a14
  v.handleMouse(ev("press", 0, 3)); // a12
  v.handleMouse(ev("drag", 0, 0)); // header: up one
  assert.deepEqual(shown(v)[0], "a9");
  v.handleMouse(ev("drag", 0, -4)); // above the overlay: up one more
  assert.deepEqual(shown(v)[0], "a8");
  assert.deepEqual(v.selection()!.start, { line: 8, col: 0 });
  v.handleMouse(ev("drag", 2, 9)); // below: down one
  assert.deepEqual(shown(v)[0], "a9");
  assert.deepEqual(v.selection()!.end, { line: 13, col: 2 });
  v.handleMouse(ev("release", 2, 9));
  assert.equal(copies[0], "a12\na13");
});

test("Escape clears through clearSelection; a press starts afresh", () => {
  const { v } = make([say("a", 20)]);
  v.handleMouse(ev("press", 0, 1));
  v.handleMouse(ev("drag", 2, 2));
  v.handleMouse(ev("release", 2, 2));
  assert.equal(v.clearSelection(), true);
  assert.equal(v.clearSelection(), false);
  assert.doesNotMatch(v.render(W).join(""), /selectedBg/);
});

// --- Clipboard order ---

test("clipboard: Pi's copyTextToClipboard first, then the native clipboard, then OSC 52", async () => {
  const log: string[] = [];
  const write = (s: string) => void log.push(`osc:${s}`);
  const pi = { copyTextToClipboard: async (t: string) => (log.push(`pi:${t}`), true), terminal: { write } };
  const native = { setText: async (t: string) => void log.push(`native:${t}`) };
  assert.equal(await copyToClipboard("a", pi, native), "pi");
  const failing = { copyTextToClipboard: async () => false, terminal: { write } };
  assert.equal(await copyToClipboard("b", failing, native), "native");
  const throwing = { copyTextToClipboard: async () => { throw new Error("x"); }, terminal: { write } };
  const noNative = { setText: async () => { throw new Error("no"); } };
  assert.equal(await copyToClipboard("c", throwing, noNative), "osc52");
  assert.equal(await copyToClipboard("d", { terminal: { write } }, undefined), "osc52");
  assert.equal(await copyToClipboard("e", {}, undefined), undefined);
  assert.deepEqual(log, ["pi:a", "native:b", `osc:\x1b]52;c;${Buffer.from("c").toString("base64")}\x07`, `osc:\x1b]52;c;${Buffer.from("d").toString("base64")}\x07`]);
});

test("a table in a reply is copied with its borders; only cards and the user box lose theirs", () => {
  const table: ChatItem = { id: "r", kind: "reply", text: "│ a │ b │\n│ c │ d │" };
  const { v, copies } = make([table], 6);
  assert.deepEqual(shown(v).slice(0, 2), ["│ a │ b │", "│ c │ d │"]);
  v.handleMouse(ev("press", 0, 1));
  v.handleMouse(ev("drag", W - 1, 2));
  v.handleMouse(ev("release", W - 1, 2));
  assert.deepEqual(copies, ["│ a │ b │\n│ c │ d │"]);
});
