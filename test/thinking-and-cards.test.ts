// Denser thinking, boxed cards, output preview.

import { test } from "node:test";
import assert from "node:assert/strict";

import type { ChatItem, ChatToolCall, ChatToolStatus } from "../src/model/items.ts";
import { cardKey, OUTPUT_PREVIEW_ROWS, outputAllKey, outputKey, renderChatRows, runKey, thinkingKey } from "../src/view/render.ts";
import { deps, strip } from "./fake-deps.ts";

const W = 40;
const rows = (items: ChatItem[], open: string[] = [], width = W) => {
  const keys = new Set(open);
  return renderChatRows(items, width, deps, { expanded: (k) => keys.has(k) });
};
const plain = (r: { lines: string[] }) => r.lines.map(strip);
const thought = (id: string, text: string): ChatItem => ({ id, kind: "thinking", text });
let n = 0;
const tool = (t: ChatToolCall, status: ChatToolStatus = "done", id = `s${++n}`): ChatItem => ({ id, kind: "tool", tool: t, status });

// --- Thinking preview ---

test("a one-line thought that fits is shown whole, dim italic, with no chevron and no toggle", () => {
  const r = rows([thought("a", "Inspecting installed package")]);
  assert.deepEqual(plain(r), ["· Inspecting installed package"]);
  assert.match(r.lines[0]!, /<i><thinkingText>Inspecting installed package<\/thinkingText><\/i>/);
  assert.deepEqual(r.targets, [undefined]);
  // Asked open (ctrl+t), there is still nothing to open.
  assert.deepEqual(plain(rows([thought("a", "Inspecting installed package")], [thinkingKey("a")])), ["· Inspecting installed package"]);
});

test("a longer thought previews its first line with ' …' and opens without repeating it", () => {
  const text = "\n**Inspecting** the `package`\n\nThen read its *types*.";
  const closed = rows([thought("a", text)]);
  assert.deepEqual(plain(closed), ["✻ Inspecting the package …"]);
  assert.match(closed.lines[0]!, /<i><thinkingText>Inspecting the package<\/thinkingText><\/i>/);
  assert.deepEqual(closed.targets, [thinkingKey("a")]);
  const open = rows([thought("a", text)], [thinkingKey("a")]);
  assert.deepEqual(plain(open), ["✻ Inspecting the package", "  Then read its *types*."]);
  assert.deepEqual(open.targets, [thinkingKey("a"), undefined]);
});

test("a single line too long for the row is cut with '…' and opens to the whole text", () => {
  const text = "word ".repeat(20).trim();
  const closed = plain(rows([thought("a", text)]));
  assert.equal(closed.length, 1);
  assert.match(closed[0]!, /^✻ word( word)* …$/);
  assert.ok(closed[0]!.length <= W);
  // Opened, the whole text starts on the toggle row: nothing is drawn twice.
  const open = plain(rows([thought("a", text)], [thinkingKey("a")]));
  assert.match(open[0]!, /^✻ word( word)*$/);
  assert.equal(open.map((l) => l.replace(/^✻ /, "").trim()).join(" "), text);
});

test("markdown markers are stripped from the preview", () => {
  const first = (t: string) => plain(rows([thought("a", `${t}\nmore`)]))[0];
  assert.equal(first("## Plan"), "✻ Plan …");
  assert.equal(first("- **step** one"), "✻ step one …");
  assert.equal(first("> see [the docs](https://x.dev)"), "✻ see the docs …");
  assert.equal(first("1. _check_ `a.ts`"), "✻ check a.ts …");
});

test("inside a run the preview row is indented with the run; the run summary is unchanged", () => {
  const items = [thought("t", "short one"), tool({ kind: "execute", command: "ls" }, "done", "c1"), tool({ kind: "execute", command: "pwd" }, "done", "c2")];
  const open = rows(items, [runKey("t")]);
  assert.deepEqual(plain(open), ["⌄ 2 commands", "  · short one", "  ✓ $ ls", "  ✓ $ pwd"]);
  assert.deepEqual(open.targets.slice(0, 2), [runKey("t"), undefined]);
  assert.deepEqual(plain(rows(items))[0], "› 2 commands");
});

test("thinking rows fit the width", () => {
  for (const width of [8, 20]) {
    for (const keys of [[], [thinkingKey("a")]]) {
      for (const l of rows([thought("a", "word ".repeat(30))], keys, width).lines) assert.ok(deps.visibleWidth(l) <= width, JSON.stringify(strip(l)));
    }
  }
});

// --- Boxed cards ---

test("an open card is a rounded box spanning the width; the top border is its toggle", () => {
  const r = rows([tool({ kind: "execute", command: "ls" }, "done", "c1")], [cardKey("c1")]);
  assert.deepEqual(plain(r), [
    `╭ ✓ Run ${"─".repeat(31)}╮`,
    `│ ${"$ ls".padEnd(36)} │`,
    `╰${"─".repeat(38)}╯`,
  ]);
  for (const l of r.lines) assert.equal(deps.visibleWidth(l), W);
  assert.match(r.lines[0]!, /^<borderMuted>╭ <\/borderMuted><dim>✓<\/dim> <b>Run<\/b>/);
  assert.deepEqual(r.targets, [cardKey("c1"), undefined, undefined]);
});

test("inside an open run the box starts at the step's indent and ends at the right edge", () => {
  const items = [tool({ kind: "execute", command: "a" }, "done", "c1"), tool({ kind: "execute", command: "b" }, "done", "c2"), tool({ kind: "edit", path: "x" }, "done", "c3")];
  const r = rows(items, [runKey("c1"), cardKey("c2")]);
  assert.deepEqual(plain(r), [
    "⌄ 2 commands, 1 edit",
    "  ✓ $ a",
    `  ╭ ✓ Run ${"─".repeat(29)}╮`,
    `  │ ${"$ b".padEnd(34)} │`,
    `  ╰${"─".repeat(36)}╯`,
    "  ✓ Edited x",
  ]);
  assert.deepEqual(r.targets, [runKey("c1"), cardKey("c1"), cardKey("c2"), undefined, undefined, cardKey("c3")]);
});

test("the separator comes only before an output section", () => {
  const without = plain(rows([tool({ kind: "read", path: "a.ts" }, "done", "r1")], [cardKey("r1")]));
  assert.ok(!without.some((l) => l.startsWith("├")));
  const withOut = rows([tool({ kind: "execute", command: "ls", output: "a\nb" }, "done", "c1")], [cardKey("c1")]);
  assert.deepEqual(plain(withOut), [
    `╭ ✓ Run ${"─".repeat(31)}╮`,
    `│ ${"$ ls".padEnd(36)} │`,
    `├${"─".repeat(38)}┤`,
    `│ ${"› Output · 2 lines".padEnd(36)} │`,
    `╰${"─".repeat(38)}╯`,
  ]);
  assert.deepEqual(withOut.targets, [cardKey("c1"), undefined, undefined, outputKey("c1"), undefined]);
});

test("long commands, diff lines and output wrap inside the box, keeping their colour", () => {
  const r = rows(
    [tool({ kind: "edit", path: "a", diff: [{ op: "+", text: "y".repeat(40) }], output: "z".repeat(40) }, "done", "e1")],
    [cardKey("e1"), outputKey("e1")],
    20,
  );
  for (const l of r.lines) assert.equal(deps.visibleWidth(l), 20, JSON.stringify(strip(l)));
  const body = r.lines.slice(1, -1);
  assert.equal(body.filter((l) => /<toolDiffAdded>/.test(l)).length, 3, "+ and 40 y over 16 columns: 3 rows");
  assert.equal(body.filter((l) => /<dim>z+<\/dim>/.test(l)).length, 3, "40 z over 14 columns: 3 rows");
});

test("a failed call's Output row keeps the error colour inside the box", () => {
  const r = rows([tool({ kind: "edit", path: "a", output: "nope" }, "failed", "e1")], [cardKey("e1")]);
  assert.match(r.lines.at(-2)!, /<error>› Output · 1 line<\/error>/);
});

// --- Output preview ---

const out = (count: number) => Array.from({ length: count }, (_, i) => `o${i}`).join("\n");
const body = (r: { lines: string[] }) => plain(r).slice(1, -1).map((l) => l.slice(2, -2).trimEnd());

test("open output shows the first 10 lines, then '› Show all N lines'", () => {
  assert.equal(OUTPUT_PREVIEW_ROWS, 10);
  const r = rows([tool({ kind: "execute", command: "x", output: out(16) }, "done", "c1")], [cardKey("c1"), outputKey("c1")]);
  // Body rows without the borders; row 1 is the separator.
  assert.deepEqual(body(r).filter((_, i) => i !== 1), ["$ x", "⌄ Output · 16 lines", ...Array.from({ length: 10 }, (_, i) => `  o${i}`), "› Show all 16 lines"]);
  assert.equal(r.targets.at(-2), outputAllKey("c1"));
});

test("'Show all' opens every line up to the cap, then '⌄ Show fewer'", () => {
  const r = rows([tool({ kind: "execute", command: "x", output: out(16) }, "done", "c1")], [cardKey("c1"), outputKey("c1"), outputAllKey("c1")]);
  const b = body(r);
  assert.deepEqual(b.slice(3), [...Array.from({ length: 16 }, (_, i) => `  o${i}`), "⌄ Show fewer"]);
  assert.equal(r.targets.at(-2), outputAllKey("c1"));
  const capped = body(rows([tool({ kind: "execute", command: "x", output: out(250) }, "done", "c2")], [cardKey("c2"), outputKey("c2"), outputAllKey("c2")]));
  assert.deepEqual(capped.slice(-2), ["  … 50 more lines", "⌄ Show fewer"]);
  assert.equal(capped.filter((l) => /^ {2}o\d+$/.test(l)).length, 200);
});

test("10 lines or fewer: no 'Show all' row", () => {
  const b = body(rows([tool({ kind: "execute", command: "x", output: out(10) }, "done", "c1")], [cardKey("c1"), outputKey("c1")]));
  assert.equal(b.at(-1), "  o9");
  assert.ok(!b.some((l) => /Show/.test(l)));
});

test("boxed cards fit any width", () => {
  const t = tool({ kind: "execute", command: "word ".repeat(40), description: "d ".repeat(40), output: "z".repeat(300) }, "failed", "w1");
  for (const width of [10, 25]) {
    for (const l of rows([t], [cardKey("w1"), outputKey("w1"), outputAllKey("w1")], width).lines) {
      assert.ok(deps.visibleWidth(l) <= width, JSON.stringify(strip(l)));
    }
  }
});
