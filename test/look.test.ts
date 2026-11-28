// Clearer look: a pinned row that is not a box, grey steps, a bar on the user box.

import { test } from "node:test";
import assert from "node:assert/strict";

import type { ChatItem, ChatToolStatus } from "../src/model/items.ts";
import { ChatView, MARGIN } from "../src/view/chat-view.ts";
import { renderChatRows } from "../src/view/render.ts";
import { deps, strip } from "./fake-deps.ts";

const W = 30;
const rows = (items: ChatItem[], width = W) => renderChatRows(items, width, deps, {});
const user = (id: string, text: string, extra: Partial<Extract<ChatItem, { kind: "user" }>> = {}): ChatItem => ({ id, kind: "user", text, ...extra });
const say = (id: string, n: number): ChatItem => ({ id, kind: "reply", text: Array.from({ length: n }, (_, i) => `${id}${i}`).join("\n") });
const view = (items: ChatItem[], height: number) => {
  const v = new ChatView({ ...deps, renderLines: (its, width, expanded) => renderChatRows(its, width, deps, { expanded }) });
  v.setItems(items);
  v.targetHeight = height;
  v.render(W);
  return v;
};
// Content columns: the margin taken off.
const shown = (v: ChatView) => v.render(W).slice(1).map((l) => strip(l).slice(MARGIN).trimEnd());
const press = (y: number) => ({ type: "press", button: "left", x: 3, y });

// --- Pinned row ---

test("pinned row: '↑ You: text' in dim, no user background, then a rule row", () => {
  const make = rows([user("u", "first  question\nhere")]).sticky!.get(0)!;
  const two = make(3);
  assert.deepEqual(two.map(strip).map((l) => l.trimEnd()), ["↑ You: first question here", "─".repeat(W)]);
  assert.match(two[0]!, /^<dim>↑ You: first question here<\/dim>/);
  assert.doesNotMatch(two.join(""), /userMessageBg|warning/);
  assert.match(two[1]!, /^<borderMuted>─+<\/borderMuted>$/);
  for (const l of two) assert.equal(deps.visibleWidth(l), W);
});

test("pinned row: two text rows at most, cut with '…'; asked for two rows, one text row and the rule", () => {
  const make = rows([user("u", "word ".repeat(30))]).sticky!.get(0)!;
  const three = make(3).map(strip);
  assert.equal(three.length, 3);
  assert.match(three[1]!, /^ {7}word.*…\s*$/);
  assert.match(three[2]!, /^─+$/);
  const two = make(2).map(strip);
  assert.equal(two.length, 2);
  assert.match(two[0]!, /^↑ You: word.*…\s*$/);
  assert.match(two[1]!, /^─+$/);
});

test("pinned row in the window: text and rule replace chat rows; height unchanged", () => {
  // 0-1 box, 2 blank, 3.. a0..a19; body 5.
  const v = view([user("u1", "first question"), say("a", 20)], 6);
  assert.equal(v.render(W).length, 6);
  assert.deepEqual(shown(v), ["↑ You: first question", "─".repeat(W - 2 * MARGIN), "a17", "a18", "a19"]);
});

test("pinned row: needs two chat rows left besides text and rule", () => {
  // body 3: text + rule leave 1 row → no pin.
  assert.deepEqual(shown(view([user("u1", "q"), say("a", 20)], 4)), ["a17", "a18", "a19"]);
  // body 4: text + rule + 2 rows.
  assert.deepEqual(shown(view([user("u1", "q"), say("a", 20)], 5)), ["↑ You: q", "─".repeat(W - 2 * MARGIN), "a18", "a19"]);
});

test("pinned row: a click on the text scrolls to the box; the rule is not a target", () => {
  const v = view([say("p", 5), user("u1", "first question"), say("a", 20)], 6);
  // The rule scrolls nowhere and selects nothing, but is taken so Pi starts no screen selection.
  assert.deepEqual(v.handleMouse(press(2)), { handled: true }, "rule row");
  assert.equal(v.hasSelection(), false);
  assert.equal(shown(v)[0], "↑ You: first question");
  assert.deepEqual(v.handleMouse(press(1)), { handled: true });
  assert.deepEqual(shown(v).slice(0, 2), ["▎ You", "▎ first question"]);
});

// --- Grey steps ---

test("closed step rows are muted; only the status glyph keeps its colour", () => {
  const tool = (status: ChatToolStatus): ChatItem => ({ id: `t-${status}`, kind: "tool", status, tool: { kind: "edit", path: "a.ts", images: 1 } });
  const glyphs: Record<ChatToolStatus, string> = { running: "<accent>●</accent>", done: "<dim>✓</dim>", failed: "<error>✗</error>", denied: "<warning>⊘</warning>" };
  for (const status of Object.keys(glyphs) as ChatToolStatus[]) {
    const [line] = rows([tool(status)]).lines;
    assert.equal(line, `${glyphs[status]} <muted>Edited a.ts</muted><dim> · 🖼️ image</dim>`, status);
  }
  const exit: ChatItem = { id: "x", kind: "tool", status: "failed", tool: { kind: "execute", command: "false", exitCode: 1 } };
  assert.equal(rows([exit]).lines[0], "<error>✗</error> <muted>$ false</muted><dim> · exit 1</dim>");
});

test("steps inside a run are muted too; the summary row stays grey", () => {
  const cmd = (id: string, status: ChatToolStatus = "done"): ChatItem => ({ id, kind: "tool", status, tool: { kind: "execute", command: id } });
  const r = rows([cmd("a"), cmd("b"), cmd("c", "running")]);
  assert.deepEqual(r.lines, ["  <dim>✓</dim> <muted>$ a</muted>", "  <dim>✓</dim> <muted>$ b</muted>", "  <accent>●</accent> <muted>$ c</muted>"]);
  const folded = rows([cmd("a"), cmd("b"), cmd("c")]).lines;
  assert.equal(folded[0], "<dim>›</dim> <muted>3 commands</muted>");
  assert.equal(folded[1], "  <dim>✓</dim> <muted>$ c</muted>");
});

// --- User box bar ---

test("user box: every row starts with '▎ ' in the user colour, on the user background", () => {
  const r = rows([user("u", "hello there, a message that wraps over the line", { images: 1 })]);
  assert.ok(r.lines.length >= 4);
  for (const l of r.lines) {
    assert.match(l, /^<userMessageBg><warning>▎<\/warning> /);
    assert.equal(deps.visibleWidth(l), W);
  }
  const text = r.lines.map(strip).map((l) => l.trimEnd());
  assert.equal(text[0], "▎ You");
  assert.equal(text.at(-1), "▎ 🖼️ image attached");
  // Text wraps at width − 4: two columns for the bar, as many kept clear on the right.
  for (const l of text.slice(1, -1)) assert.ok(l.length <= W - 2, JSON.stringify(l));
});

test("user box: image rows carry the bar before the image; its width is the reduced one", () => {
  const calls: number[][] = [];
  const d = { ...deps, image: (_d: string, _m: string, max: number, width: number) => {
      calls.push([max, width]);
      return ["\x1b_Gi=1;\x1b\\", ""];
    },
  };
  const r = renderChatRows([user("u", "x", { images: 1, imageData: [{ data: "A", mimeType: "image/png" }] })], 20, d, {});
  const img = r.lines.filter((l) => l.includes("\x1b_G"));
  assert.equal(img.length, 1);
  assert.match(img[0]!, /^<userMessageBg><warning>▎<\/warning> \x1b_G/);
  assert.match(r.lines.at(-1)!, /^<userMessageBg><warning>▎<\/warning> /, "the image's empty row too");
  assert.deepEqual(calls, [[16, 16]]);
  for (const l of r.lines) assert.equal(deps.visibleWidth(l), 20);
  assert.match(r.images!.get(2)!.fallback[0]!, /<warning>▎<\/warning> <muted>🖼️ image attached/);
});

test("every line fits the width", () => {
  const items = [user("u", "word ".repeat(20), { images: 2 }), say("r", 3), { id: "t", kind: "tool", status: "failed", tool: { kind: "execute", command: "x ".repeat(40), exitCode: 2, images: 3 } } as ChatItem];
  for (const width of [6, 12, 30]) for (const l of rows(items, width).lines) assert.ok(deps.visibleWidth(l) <= width, JSON.stringify(strip(l)));
});
