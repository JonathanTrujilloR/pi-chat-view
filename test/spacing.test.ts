// Breathing room: a 2-column margin, a rule between turns, "✻" on thinking rows.

import { test } from "node:test";
import assert from "node:assert/strict";

import type { ChatItem } from "../src/model/items.ts";
import { ChatView, MARGIN } from "../src/view/chat-view.ts";
import { renderChatRows, runKey, thinkingKey, TURN_RULE } from "../src/view/render.ts";
import { strip, viewDeps } from "./fake-deps.ts";

const W = 30;
const user = (id: string, text: string): ChatItem => ({ id, kind: "user", text });
const say = (id: string, n: number): ChatItem => ({ id, kind: "reply", text: Array.from({ length: n }, (_, i) => `${id}${i}`).join("\n") });
const plain = (lines: string[]) => lines.map(strip).map((l) => l.trimEnd());
function make(items: ChatItem[], height = 8) {
  const copies: string[] = [];
  const widths: number[] = [];
  const v = new ChatView({
    ...viewDeps,
    renderLines: (its, width, expanded) => {
      widths.push(width);
      return renderChatRows(its, width, viewDeps, { expanded });
    },
  });
  v.setItems(items);
  v.targetHeight = height;
  v.onCopy = (t) => void copies.push(t);
  v.render(W);
  return { v, copies, widths };
}

test("constants: a 2-column margin and the turn rule, both revertable", () => {
  assert.equal(MARGIN, 2);
  assert.equal(TURN_RULE, true);
});

test("margin: content is drawn 4 columns narrower and every row, header included, starts with 2 spaces", () => {
  const { v, widths } = make([say("a", 3)]);
  assert.deepEqual(widths, [W - 4]);
  const lines = v.render(W);
  for (const l of lines) {
    assert.equal(viewDeps.visibleWidth(l), W);
    assert.ok(strip(l).startsWith("  "), JSON.stringify(strip(l)));
  }
  assert.match(strip(lines[0]!), /^ {2} Chat · alt\+c/);
  assert.deepEqual(plain(lines).slice(1, 4), ["  a0", "  a1", "  a2"]);
});

test("margin: the user tint spans the inner width only; the pinned row sits inside the margin too", () => {
  const { v } = make([user("u", "question"), say("a", 20)], 8);
  const lines = v.render(W);
  assert.match(lines[1]!, /^ {2}<dim>↑ You: question/);
  assert.match(lines[2]!, /^ {2}<borderMuted>─{26}<\/borderMuted> {2}$/);
  v.top();
  assert.match(v.render(W)[1]!, /^ {2}<userMessageBg>.*<\/userMessageBg> {2}$/);
});

test("margin: clicks and selection subtract the left margin; a press in a margin selects nothing but is taken", () => {
  const { v, copies } = make([say("a", 20)], 6); // rows 1-5: a15..a19
  assert.deepEqual(v.handleMouse({ type: "press", button: "left", x: 0, y: 1 }), { handled: true });
  assert.equal(v.hasSelection(), false);
  assert.deepEqual(v.handleMouse({ type: "press", button: "left", x: W - 1, y: 1 }), { handled: true });
  assert.equal(v.hasSelection(), false);
  assert.deepEqual(v.handleMouse({ type: "press", button: "left", x: 3, y: 1 }), { handled: true, capture: true });
  assert.deepEqual(v.selection()!.start, { line: 15, col: 1 });
  v.handleMouse({ type: "drag", button: "left", x: 3, y: 2 });
  v.handleMouse({ type: "release", button: "left", x: 3, y: 2 });
  assert.deepEqual(copies, ["15\na1"]);
  assert.match(v.render(W)[1]!, /^ {2}a<selectedBg>15<\/selectedBg>/);
});

test("margin: an image sequence is drawn after the margin", () => {
  const d = { ...viewDeps, image: () => ["\x1b_Gi=1;\x1b\\", ""] };
  const v = new ChatView({ ...viewDeps, renderLines: (its, width, expanded) => renderChatRows(its, width, d, { expanded }) });
  v.setItems([{ id: "u", kind: "user", text: "x", images: 1, imageData: [{ data: "A", mimeType: "image/png" }] } as ChatItem]);
  v.targetHeight = 8;
  const img = v.render(W).find((l) => l.includes("\x1b_G"))!;
  assert.match(img, /^ {2}<userMessageBg>/);
  assert.equal(viewDeps.visibleWidth(img), W);
});

test("turns: every user box after the first block gets a blank row, a rule and a blank row before it", () => {
  const r = renderChatRows([user("u1", "one"), say("a", 1), user("u2", "two"), say("b", 1)], 20, viewDeps);
  assert.deepEqual(plain(r.lines), ["▎ You", "▎ one", "", "a0", "", "─".repeat(20), "", "▎ You", "▎ two", "", "b0"]);
  assert.match(r.lines[5]!, /^<borderMuted>─+<\/borderMuted>$/);
  // Separator rows belong to the turn before; the second box starts its own.
  assert.deepEqual(r.turns, [undefined, undefined, 0, 0, 0, 0, 0, undefined, undefined, 7, 7]);
  assert.deepEqual([...r.sticky!.keys()], [0, 7]);
  // A first block that is not a user box: the first user box still gets the rule.
  const n = renderChatRows([say("p", 1), user("u", "q")], 20, viewDeps);
  assert.deepEqual(plain(n.lines), ["p0", "", "─".repeat(20), "", "▎ You", "▎ q"]);
});

test("thinking rows use ✻; one-line thoughts keep ·; runs keep › and ⌄", () => {
  const thought: ChatItem = { id: "th", kind: "thinking", text: "first\nsecond" };
  assert.deepEqual(plain(renderChatRows([thought], W, viewDeps).lines), ["✻ first …"]);
  const open = renderChatRows([thought], W, viewDeps, { expanded: (k) => k === thinkingKey("th") });
  assert.deepEqual(plain(open.lines), ["✻ first", "  second"]);
  assert.equal(open.targets[0], thinkingKey("th"));
  assert.deepEqual(plain(renderChatRows([{ id: "t", kind: "thinking", text: "short" }], W, viewDeps).lines), ["· short"]);
  const cmd = (id: string): ChatItem => ({ id, kind: "tool", status: "done", tool: { kind: "execute", command: id } });
  const run = [thought, cmd("a"), cmd("b")];
  assert.equal(plain(renderChatRows(run, W, viewDeps).lines)[0], "› 2 commands");
  assert.equal(plain(renderChatRows(run, W, viewDeps, { expanded: (k) => k === runKey("th") }).lines)[0], "⌄ 2 commands");
});
