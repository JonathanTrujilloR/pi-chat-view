// Images drawn inside the chat.

import { test } from "node:test";
import assert from "node:assert/strict";

import type { ChatItem } from "../src/model/items.ts";
import { ChatView } from "../src/view/chat-view.ts";
import { cardKey, renderChatRows, type ChatRows, type RenderDeps } from "../src/view/render.ts";
import { deps, strip } from "./fake-deps.ts";

const W = 40;
const ESC = "\x1b";
/** A Kitty-like sequence: zero width, and it names the image so a test can find it. */
const seq = (data: string) => `${ESC}_Ga=T,i=${data};${ESC}\\`;
const hasImage = (l: string) => l.includes(`${ESC}_G`);

function withImages(rows = 3, fail?: (data: string) => "undefined" | "throw" | "empty") {
  const calls: [string, string, number, number][] = [];
  const d: RenderDeps = {
    ...deps,
    image: (data, mime, max, width) => {
      calls.push([data, mime, max, width]);
      const how = fail?.(data);
      if (how === "throw") throw new Error("boom");
      if (how === "undefined") return undefined;
      if (how === "empty") return [];
      return [seq(data), ...Array.from({ length: rows - 1 }, () => "")];
    },
  };
  return { d, calls };
}
const png = (data: string) => ({ data, mimeType: "image/png" });
const userImg = (text: string, ...data: string[]): ChatItem =>
  ({ id: "u", kind: "user", text, images: data.length, imageData: data.map(png) }) as ChatItem;
const readImg = (id: string, ...data: string[]): ChatItem =>
  ({ id, kind: "tool", status: "done", tool: { kind: "read", path: "shot.png", images: data.length, imageData: data.map(png) } }) as ChatItem;

test("user box: the image is drawn small after the text, on the box background, full width", () => {
  const { d, calls } = withImages(3);
  const r = renderChatRows([userImg("look", "A")], W, d);
  assert.deepEqual(r.lines.map(strip).map((l) => l.trimEnd()), ["▎ You", "▎ look", "▎", "▎", "▎"]);
  assert.ok(r.lines[2]!.startsWith("<userMessageBg><warning>▎</warning> "), "the bar inside the box");
  assert.ok(hasImage(r.lines[2]!));
  for (const l of r.lines) {
    assert.match(l, /^<userMessageBg>.*<\/userMessageBg>$/);
    assert.equal(deps.visibleWidth(l), W);
  }
  assert.ok(!r.lines.some((l) => strip(l).includes("attached")), "drawn: no marker");
  assert.deepEqual(calls, [["A", "image/png", 30, W - 4]]);
  assert.equal(withImages().calls.length, 0);
  const narrow = withImages(2);
  renderChatRows([userImg("x", "A")], 20, narrow.d);
  assert.equal(narrow.calls[0]![2], 16, "min(30, inner width)");
});

test("user box: each image reports its span with the marker as fallback", () => {
  const { d } = withImages(3);
  const r = renderChatRows([userImg("look", "A")], W, d);
  const span = r.images!.get(2)!;
  assert.equal(span.rows, 3);
  assert.equal(span.fallback.length, 3);
  assert.equal(strip(span.fallback[0]!).trimEnd(), "▎ 🖼️ image attached");
  for (const l of span.fallback) {
    assert.match(l, /^<userMessageBg>/);
    assert.equal(deps.visibleWidth(l), W);
    assert.ok(!hasImage(l));
  }
});

test("an image that cannot be drawn falls back to the image marker", () => {
  const plain = renderChatRows([userImg("look", "A", "B")], W, deps).lines.map(strip).map((l) => l.trimEnd());
  assert.deepEqual(plain, ["▎ You", "▎ look", "▎ 🖼️ 2 images attached"], "no image dep");
  for (const how of ["undefined", "throw", "empty"] as const) {
    const { d } = withImages(2, (data) => (data === "B" ? how : undefined));
    const r = renderChatRows([userImg("look", "A", "B")], W, d);
    const text = r.lines.map(strip).map((l) => l.trimEnd());
    assert.deepEqual(text, ["▎ You", "▎ look", "▎", "▎", "▎ 🖼️ image attached"], how);
    assert.deepEqual([...r.images!.keys()], [2]);
  }
});

test("open card: image rows sit inside the box borders and replace the note; closed row unchanged", () => {
  const { d, calls } = withImages(3);
  const item = readImg("r1", "A");
  const r = renderChatRows([item], W, d, { expanded: (k) => k === cardKey("r1") });
  const text = r.lines.map(strip);
  assert.deepEqual(text, [
    `╭ ✓ Read ${"─".repeat(30)}╮`,
    `│ ${"shot.png".padEnd(36)} │`,
    `│ ${"".padEnd(36)} │`,
    `│ ${"".padEnd(36)} │`,
    `│ ${"".padEnd(36)} │`,
    `╰${"─".repeat(38)}╯`,
  ]);
  assert.ok(hasImage(r.lines[2]!) && r.lines[2]!.startsWith("<borderMuted>│ </borderMuted>"));
  assert.ok(!text.some((l) => l.includes("alt+c")));
  assert.deepEqual(calls, [["A", "image/png", 36, 36]]);
  const span = r.images!.get(2)!;
  assert.equal(span.rows, 3);
  // The note wraps in the box; the fallback is its rows, then box rows up to the image's height.
  assert.deepEqual(span.fallback.map((l) => strip(l).slice(2, -2).trimEnd()), ["🖼️ image — alt+c shows it in", "Terminal", ""]);
  for (const l of r.lines) assert.equal(deps.visibleWidth(l), W);
  // Closed: one line, the image marker, and the renderer is not even asked.
  const closed = withImages(3);
  assert.deepEqual(renderChatRows([item], W, closed.d).lines.map(strip), ["✓ Read shot.png · 🖼️ image"]);
  assert.equal(closed.calls.length, 0);
  // Wide card: min(60, content width).
  const wide = withImages(1);
  renderChatRows([item], 100, wide.d, { expanded: () => true });
  assert.equal(wide.calls[0]![2], 60);
});

test("a card whose image cannot be drawn keeps the image note", () => {
  const { d } = withImages(3, () => "throw");
  const r = renderChatRows([readImg("r1", "A")], W, d, { expanded: () => true });
  const inside = r.lines.map(strip).map((l) => l.slice(2, -2).trim()).join(" ");
  assert.match(inside, /🖼️ image — alt\+c shows it in Terminal/);
  assert.equal(r.images!.size, 0);
});

test("every line fits the width, image sequences counted as zero width", () => {
  const { d } = withImages(4);
  for (const width of [8, 20, 40]) {
    const items = [userImg("look at this one please", "A", "B"), readImg("r1", "C")];
    for (const l of renderChatRows(items, width, d, { expanded: () => true }).lines) assert.ok(deps.visibleWidth(l) <= width, JSON.stringify(strip(l)));
  }
});

// --- Never spill out of the window ---

/** Ten numbered lines, an image on lines 4-6 with fallback FB / f1 / f2. */
const spanned = (extra: Partial<ChatRows> = {}): ChatRows => {
  const lines = Array.from({ length: 10 }, (_, i) => `L${i}`);
  lines[4] = seq("IMG");
  lines[5] = "";
  lines[6] = "";
  return { lines, targets: [], images: new Map([[4, { rows: 3, fallback: ["FB", "f1", "f2"] }]]), ...extra };
};
const viewOf = (rows: ChatRows, height = 6) => {
  const v = new ChatView({ ...deps, renderLines: () => rows });
  v.targetHeight = height;
  v.render(30);
  return v;
};
const body = (v: ChatView) => v.render(30).slice(1);
const shown = (v: ChatView) => body(v).map((l) => (hasImage(l) ? "IMG" : strip(l).trim()));

test("an image fully inside the window is drawn as it is", () => {
  const v = viewOf(spanned());
  v.scrollBy(-2); // window L3..L7
  assert.deepEqual(shown(v), ["L3", "IMG", "", "", "L7"]);
  v.scrollBy(-1); // window L2..L6: last row of the image on the last row
  assert.deepEqual(shown(v), ["L2", "L3", "IMG", "", ""]);
});

test("cut at the bottom: the fallback replaces the image's rows", () => {
  const v = viewOf(spanned());
  v.scrollBy(-4); // window L1..L5
  assert.deepEqual(shown(v), ["L1", "L2", "L3", "FB", "f1"]);
  for (const l of body(v)) assert.equal(deps.visibleWidth(l), 30);
});

test("cut at the top: the image's visible rows are blanked, no image sequence", () => {
  const v = viewOf(spanned()); // following the bottom: window L5..L9
  assert.deepEqual(shown(v), ["f1", "f2", "L7", "L8", "L9"]);
  assert.ok(!body(v).some(hasImage));
});

test("under the pinned user row the image counts as cut at the top", () => {
  // 0-1 a user box, 2 blank, 3 image (3 rows), 6.. b lines; turns after the box point at it.
  const lines = ["You", "q", "", seq("IMG"), "", "", "b0", "b1", "b2", "b3", "b4", "b5", "b6"];
  const turns = lines.map((_, i) => (i < 2 ? undefined : 0));
  const rows: ChatRows = {
    lines,
    targets: [],
    turns,
    sticky: new Map([[0, () => ["PIN", "RULE"]]]),
    images: new Map([[3, { rows: 3, fallback: ["FB", "x1", "x2"] }]]),
  };
  const v = viewOf(rows);
  v.scrollBy(-5); // raw start 3: pin and rule cover the image's first two rows
  assert.deepEqual(shown(v), ["PIN", "RULE", "x2", "b0", "b1"]);
  assert.ok(!body(v).some(hasImage));
});
