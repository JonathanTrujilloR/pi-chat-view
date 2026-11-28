import { test } from "node:test";
import assert from "node:assert/strict";

import type { ChatItem } from "../src/model/items.ts";
import { ChatView, MARGIN, HEADER } from "../src/view/chat-view.ts";
import { deps, strip } from "./fake-deps.ts";

// One numbered reply per line, so a window is easy to read back.
const items = (count: number): ChatItem[] => [{ id: "r", kind: "reply", text: Array.from({ length: count }, (_, i) => `L${i}`).join("\n") }];
const view = (count: number, height: number) => {
  const v = new ChatView({ ...deps, renderLines: (its, width) => its.flatMap((i) => (i.kind === "reply" ? i.text.split("\n") : [])).map((l) => l.slice(0, width)) });
  v.setItems(items(count));
  v.targetHeight = height;
  return v;
};
const body = (lines: string[]) => lines.slice(1).map((l) => strip(l).trim());

test("renders exactly targetHeight full-width lines, header first", () => {
  for (const [count, height] of [[3, 10], [50, 10], [0, 5], [5, 1]] as const) {
    const lines = view(count, height).render(60);
    assert.equal(lines.length, height, `${count}/${height}`);
    for (const l of lines) assert.equal(deps.visibleWidth(l), 60);
    assert.equal(strip(lines[0]!).slice(MARGIN).trimEnd(), HEADER);
    assert.match(lines[0]!, /^ {2}<dim>/, "the margin, then the dim header");
  }
  assert.deepEqual(view(5, 0).render(30), []);
});

test("short chat sits at the top, blank padding below hides the transcript", () => {
  assert.deepEqual(body(view(3, 6).render(30)), ["L0", "L1", "L2", "", ""]);
});

test("follows the bottom by default", () => {
  assert.deepEqual(body(view(20, 5).render(30)), ["L16", "L17", "L18", "L19"]);
});

test("scrolled up: older window and '↓ N more' in the header", () => {
  const v = view(20, 5);
  v.render(30);
  v.scrollBy(-3);
  const lines = v.render(30);
  assert.deepEqual(body(lines), ["L13", "L14", "L15", "L16"]);
  // Narrow: the hint gives way, the count stays.
  assert.match(strip(lines[0]!).slice(0, -MARGIN), /↓ 3 more $/);
  assert.equal(deps.visibleWidth(lines[0]!), 30);
  v.bottom();
  assert.deepEqual(body(v.render(30)), ["L16", "L17", "L18", "L19"]);
  assert.doesNotMatch(strip(v.render(30)[0]!), /more/);
});

test("pageUp / pageDown / top clamp to the transcript", () => {
  const v = view(20, 5);
  v.render(30);
  v.pageUp();
  assert.deepEqual(body(v.render(30)), ["L13", "L14", "L15", "L16"]);
  v.top();
  assert.deepEqual(body(v.render(30)), ["L0", "L1", "L2", "L3"]);
  v.scrollBy(-100);
  assert.deepEqual(body(v.render(30)), ["L0", "L1", "L2", "L3"]);
  v.pageDown();
  assert.deepEqual(body(v.render(30)), ["L3", "L4", "L5", "L6"]);
  v.scrollBy(100);
  assert.deepEqual(body(v.render(30)), ["L16", "L17", "L18", "L19"]);
});

test("wheel scrolls and is handled; other mouse events are not", () => {
  const v = view(20, 5);
  v.render(30);
  const ev = (type: string, wheelDelta?: number) =>
    ({ type, button: "none", x: 0, y: 0, screenX: 0, screenY: 0, width: 30, height: 5, shift: false, alt: false, ctrl: false, wheelDelta }) as const;
  assert.deepEqual(v.handleMouse(ev("wheel", -2) as never), { handled: true });
  assert.deepEqual(body(v.render(30)), ["L14", "L15", "L16", "L17"]);
  assert.deepEqual(v.handleMouse(ev("wheel", 2) as never), { handled: true });
  assert.deepEqual(body(v.render(30)), ["L16", "L17", "L18", "L19"]);
  assert.equal(v.handleMouse(ev("click") as never), undefined);
});

test("render is cached per width and version; setItems and invalidate redraw", () => {
  let calls = 0;
  const v = new ChatView({ ...deps, renderLines: () => (calls++, ["a"]) });
  v.targetHeight = 3;
  v.render(20);
  v.render(20);
  assert.equal(calls, 1);
  v.render(21);
  assert.equal(calls, 2);
  v.setItems([]);
  v.render(21);
  assert.equal(calls, 3);
  v.invalidate();
  v.render(21);
  assert.equal(calls, 4);
});

test("follow-bottom: new lines keep a bottom-pinned window at the bottom", () => {
  const v = view(20, 5);
  v.render(30);
  v.setItems(items(23));
  assert.deepEqual(body(v.render(30)), ["L19", "L20", "L21", "L22"]);
  assert.doesNotMatch(strip(v.render(30)[0]!), /more/);
});

test("follow-bottom: scrolled up, the window stays on the same lines and '↓ N more' grows", () => {
  const v = view(20, 5);
  v.render(30);
  v.scrollBy(-3);
  assert.deepEqual(body(v.render(30)), ["L13", "L14", "L15", "L16"]);
  v.setItems(items(25));
  const lines = v.render(30);
  assert.deepEqual(body(lines), ["L13", "L14", "L15", "L16"]);
  assert.match(strip(lines[0]!).slice(0, -MARGIN), /↓ 8 more $/);
  // Same items again (a rebuild with nothing new) does not move the window.
  v.setItems(items(25));
  assert.deepEqual(body(v.render(30)), ["L13", "L14", "L15", "L16"]);
  // Shrinking content (a /tree jump) clamps instead of going negative.
  v.setItems(items(3));
  assert.deepEqual(body(v.render(30)), ["L0", "L1", "L2", ""]);
});

// --- Expansion and clicks ---

import { cardKey, outputKey, renderChatRows, runKey, thinkingKey } from "../src/view/render.ts";

const thought = (id: string, lines = 3): ChatItem => ({ id, kind: "thinking", text: Array.from({ length: lines }, (_, i) => `t${i}`).join("\n") });
const say = (id: string, lines: number): ChatItem => ({ id, kind: "reply", text: Array.from({ length: lines }, (_, i) => `${id}${i}`).join("\n") });
const realView = (its: ChatItem[], height: number) => {
  const v = new ChatView({ ...deps, renderLines: (items, width, expanded) => renderChatRows(items, width, deps, { expanded }) });
  v.setItems(its);
  v.targetHeight = height;
  return v;
};
const mouse = (type: string, y: number, button = "left") => ({ type, button, x: 3, y, wheelDelta: undefined });
// Content columns: the margin taken off.
const shown = (v: ChatView) => v.render(30).slice(1).map((l) => strip(l).slice(MARGIN).trimEnd());

test("click: a left press on a '›' row toggles it; the click that follows the same press does not toggle back", () => {
  const v = realView([say("a", 2), thought("th")], 10);
  // Rows: 0 header, 1 a0, 2 a1, 3 blank, 4 › t0 …
  assert.deepEqual(shown(v).slice(0, 4), ["a0", "a1", "", "✻ t0 …"]);
  assert.deepEqual(v.handleMouse(mouse("press", 4)), { handled: true });
  assert.deepEqual(shown(v).slice(3, 6), ["✻ t0", "  t1", "  t2"]);
  assert.deepEqual(v.handleMouse(mouse("release", 4)), { handled: true });
  assert.deepEqual(v.handleMouse(mouse("click", 4)), { handled: true });
  assert.equal(shown(v)[3], "✻ t0", "still open");
  // A click with no press of ours before it (Pi's selection path) toggles.
  assert.deepEqual(v.handleMouse(mouse("click", 4)), { handled: true });
  assert.equal(shown(v)[3], "✻ t0 …");
});

test("click: header row, plain rows, other buttons, moves and empty rows are not ours", () => {
  const v = realView([say("a", 2), thought("th")], 10);
  v.render(30);
  // A press on the header is taken (no selection), one on text starts the chat's own selection.
  assert.deepEqual(v.handleMouse(mouse("press", 0)), { handled: true }, "header");
  assert.deepEqual(v.handleMouse(mouse("press", 1)), { handled: true, capture: true }, "reply text: the chat selects");
  v.handleMouse(mouse("release", 1));
  assert.equal(v.handleMouse(mouse("press", 4, "right")), undefined);
  assert.equal(v.handleMouse(mouse("move", 4)), undefined);
  assert.equal(v.handleMouse(mouse("drag", 4)), undefined);
  assert.deepEqual(v.handleMouse(mouse("press", 8)), { handled: true, capture: true }, "padding below the chat: selects from the end");
  v.handleMouse(mouse("release", 8));
  assert.equal(shown(v)[3], "✻ t0 …");
  assert.deepEqual(v.handleMouse({ type: "wheel", button: "none", x: 0, y: 4, wheelDelta: -1 }), { handled: true });
});

test("click hit-testing follows the scrolled window, and the clicked row keeps its screen row", () => {
  const v = realView([thought("th"), say("b", 20)], 6);
  v.render(30);
  v.top();
  // Window shows the top: row 1 is the thinking preview.
  assert.equal(shown(v)[0], "✻ t0 …");
  v.scrollBy(1); // one line down: thinking is above the window
  assert.equal(shown(v)[0], "");
  v.scrollBy(-1);
  assert.deepEqual(v.handleMouse(mouse("press", 1)), { handled: true });
  assert.deepEqual(shown(v), ["✻ t0", "  t1", "  t2", "", "b0"]);
  assert.match(strip(v.render(30)[0]!).slice(0, -MARGIN), /more $/);
  // Scrolled into the middle: click a row lower down the screen.
  const w = realView([say("a", 10), thought("th"), say("b", 10)], 6);
  w.render(30);
  w.scrollBy(-8);
  const before = shown(w);
  const y = before.indexOf("✻ t0 …") + 1;
  assert.ok(y > 1, JSON.stringify(before));
  w.handleMouse(mouse("press", y));
  const after = shown(w);
  assert.equal(after[y - 1], "✻ t0", "same screen row");
  assert.deepEqual(after.slice(0, y - 1), before.slice(0, y - 1), "rows above unchanged");
});

test("following the bottom, a toggle keeps following", () => {
  const v = realView([say("a", 10), thought("th")], 5);
  assert.equal(shown(v).at(-1), "✻ t0 …");
  v.handleMouse(mouse("press", 4));
  assert.deepEqual(shown(v), ["a9", "", "✻ t0", "  t1", "  t2"].slice(-4));
  assert.doesNotMatch(strip(v.render(30)[0]!), /more/);
});

test("expansion survives setItems with new items (live rebuilds)", () => {
  const items = [thought("th"), say("r", 1)];
  const v = realView(items, 12);
  v.toggle(thinkingKey("th"));
  v.setItems([...items, say("s", 1)]);
  assert.deepEqual(shown(v).slice(0, 3), ["✻ t0", "  t1", "  t2"]);
  assert.equal(v.isExpanded(thinkingKey("th")), true);
  assert.equal(v.isExpanded(runKey("nope")), false);
});

test("global toggles flip the default for their kind and clear that kind's per-row overrides", () => {
  const v = realView([thought("a", 1), say("r", 1), thought("b", 1)], 12);
  v.toggle(thinkingKey("a"));
  v.toggle(runKey("x"));
  v.toggleAllThinking();
  assert.deepEqual([v.isExpanded(thinkingKey("a")), v.isExpanded(thinkingKey("b"))], [true, true]);
  assert.equal(v.isExpanded(runKey("x")), true, "tools untouched");
  v.toggle(thinkingKey("b"));
  assert.equal(v.isExpanded(thinkingKey("b")), false);
  v.toggleAllThinking();
  assert.deepEqual([v.isExpanded(thinkingKey("a")), v.isExpanded(thinkingKey("b"))], [false, false]);
  v.toggleAllTools();
  assert.equal(v.isExpanded(runKey("x")), true, "default flipped to expanded, override cleared");
  v.toggle(runKey("x"));
  v.toggleAllTools();
  assert.equal(v.isExpanded(runKey("x")), false, "default back to collapsed, override cleared");
});

test("ctrl+o opens runs only; cards and output rows keep their own state", () => {
  const v = realView([say("r", 1)], 12);
  v.toggle(cardKey("c1"));
  v.toggleAllTools();
  assert.equal(v.isExpanded(runKey("x")), true);
  assert.equal(v.isExpanded(cardKey("c2")), false, "cards are not opened by ctrl+o");
  assert.equal(v.isExpanded(cardKey("c1")), true, "a card opened by hand stays open");
  assert.equal(v.isExpanded(outputKey("c1")), false);
});

test("click: a tool row opens its card, then its Output row opens the output", () => {
  const tool: ChatItem = { id: "c1", kind: "tool", status: "done", tool: { kind: "execute", command: "ls", output: "a\nb" } };
  const v = realView([tool], 10);
  assert.deepEqual(shown(v)[0], "✓ $ ls");
  v.handleMouse(mouse("press", 1));
  // Boxed: row 1 top border, 2 command, 3 separator, 4 Output, 5 bottom border.
  const inBox = () => shown(v).map((l) => l.replace(/^│ (.*?) *│$/, "$1"));
  assert.deepEqual(inBox().slice(0, 5), [`╭ ✓ Run ${"─".repeat(17)}╮`, "$ ls", `├${"─".repeat(24)}┤`, "› Output · 2 lines", `╰${"─".repeat(24)}╯`]);
  v.handleMouse(mouse("press", 4));
  assert.deepEqual(inBox().slice(3, 6), ["⌄ Output · 2 lines", "  a", "  b"]);
  v.handleMouse(mouse("press", 1));
  assert.deepEqual(shown(v).slice(0, 2), ["✓ $ ls", ""]);
  assert.equal(v.isExpanded(outputKey("c1")), true, "output state kept while the card is closed");
});

// --- Sticky user turn ---

const user = (id: string, text: string): ChatItem => ({ id, kind: "user", text });

test("sticky: following the bottom past a user box, its message is pinned under the header", () => {
  // Lines: 0 You, 1 first question, 2 blank, 3.. a0..a19 (23 lines); body 5.
  const v = realView([user("u1", "first question"), say("a", 20)], 6);
  const lines = v.render(30);
  assert.equal(lines.length, 6);
  assert.equal(strip(lines[1]!).slice(MARGIN).trimEnd(), "↑ You: first question");
  assert.doesNotMatch(lines[1]!, /<userMessageBg>/);
  assert.deepEqual(shown(v).slice(1), ["─".repeat(30 - 2 * MARGIN), "a17", "a18", "a19"]);
});

test("sticky: hidden while the user box is (partly) on screen, shown once it is above", () => {
  const v = realView([user("u1", "first question"), say("a", 20)], 6);
  v.render(30);
  v.top();
  assert.deepEqual(shown(v).slice(0, 2), ["▎ You", "▎ first question"]);
  v.scrollBy(1); // box text line at the top
  assert.deepEqual(shown(v)[0], "▎ first question");
  v.scrollBy(1); // the blank under the box at the top: box gone, pin and rule cover it and a0
  assert.deepEqual(shown(v), ["↑ You: first question", "─".repeat(30 - 2 * MARGIN), "a1", "a2", "a3"]);
});

test("sticky: none without an earlier user turn, and none in a window too small for it", () => {
  const v = realView([say("a", 20)], 6);
  v.render(30);
  v.scrollBy(-5);
  assert.ok(shown(v).every((l) => /^a\d+$/.test(l)));
  const tiny = realView([user("u1", "q"), say("a", 20)], 3); // body 2: no room
  assert.deepEqual(shown(tiny), ["a18", "a19"]);
});

test("sticky: the next user box right under it hides it; past that box the sticky is the new message", () => {
  // 0-1 u1, 2 blank, 3-5 a0..a2, 6 blank, 7 rule, 8 blank, 9-10 u2, 11 blank, 12.. b0..b19 (32 lines); body 5.
  const v = realView([user("u1", "one"), say("a", 3), user("u2", "two"), say("b", 20)], 6);
  v.render(30);
  v.scrollBy(-21); // raw start 6 (blank): u1 pinned over lines 6-7, lines 8..10
  assert.deepEqual(shown(v), ["↑ You: one", "─".repeat(30 - 2 * MARGIN), "", "▎ You", "▎ two"]);
  v.scrollBy(1); // raw start 7 (the turn rule): the pin would end right above u2's box
  assert.deepEqual(shown(v), ["─".repeat(30 - 2 * MARGIN), "", "▎ You", "▎ two", ""]);
  v.scrollBy(5); // raw start 12
  assert.deepEqual(shown(v), ["↑ You: two", "─".repeat(30 - 2 * MARGIN), "b2", "b3", "b4"]);
});

test("sticky: a click on it scrolls its user box to the top; release and click of that press are swallowed", () => {
  const v = realView([say("p", 5), user("u1", "first question"), say("a", 20)], 6);
  v.render(30);
  assert.equal(shown(v)[0], "↑ You: first question");
  assert.deepEqual(v.handleMouse(mouse("press", 1)), { handled: true });
  assert.deepEqual(shown(v).slice(0, 3), ["▎ You", "▎ first question", ""]);
  assert.deepEqual(v.handleMouse(mouse("release", 1)), { handled: true });
  assert.deepEqual(v.handleMouse(mouse("click", 1)), { handled: true });
  assert.deepEqual(shown(v).slice(0, 2), ["▎ You", "▎ first question"]);
  assert.match(strip(v.render(30)[0]!).slice(0, -MARGIN), /↓ \d+ more $/);
});

test("sticky: toggles under it are hit at the right row and the row keeps its place", () => {
  // 0-1 u1, 2 blank, 3 p0, 4 blank, 5 ⌄ t0, 6-7 t1..t2, 8 blank, 9.. a0..a9 (19 lines); body 5.
  const v = realView([user("u1", "q"), say("p", 1), thought("th"), say("a", 10)], 6);
  v.toggle(thinkingKey("th"));
  v.render(30);
  v.scrollBy(-12); // raw start 2: pin and rule over lines 2-3, line 5 on screen row 4
  assert.deepEqual(shown(v).slice(0, 4), ["↑ You: q", "─".repeat(30 - 2 * MARGIN), "", "✻ t0"]);
  assert.deepEqual(v.handleMouse(mouse("press", 4)), { handled: true });
  assert.deepEqual(shown(v).slice(0, 4), ["↑ You: q", "─".repeat(30 - 2 * MARGIN), "", "✻ t0 …"]);
  assert.equal(v.isExpanded(thinkingKey("th")), false);
});
