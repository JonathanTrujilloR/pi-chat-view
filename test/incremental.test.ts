// Performance: every incremental path gives exactly what a full rebuild gives.

import { test } from "node:test";
import assert from "node:assert/strict";

import { createItemsBuilder, itemsFromEntries, type ChatItem, type SessionEntryLike } from "../src/model/items.ts";
import { ChatView } from "../src/view/chat-view.ts";
import { countRows } from "../src/view/layout.ts";
import { createLiveFeed, liveOptions, createLiveState, type Timers } from "../src/view/live.ts";
import { hideImages } from "../src/view/pi-images.ts";
import { createRowsCache, renderChatRows, cardKey, runKey, thinkingKey, type ChatRows } from "../src/view/render.ts";
import { syntheticSession, streamingReply } from "../bench/session.ts";
import { deps, viewDeps } from "./fake-deps.ts";

const session = syntheticSession(12);

/** Rows as plain data, sticky rows called, to compare a kept render with a fresh one. */
function snapshot(r: ChatRows) {
  return {
    lines: [...r.lines],
    targets: [...r.targets],
    turns: [...(r.turns ?? [])],
    sticky: [...(r.sticky ?? new Map()).entries()].sort((a, b) => a[0] - b[0]).map(([k, f]) => [k, f(3)]),
    images: [...(r.images ?? new Map()).entries()].sort((a, b) => a[0] - b[0]),
  };
}

test("builder: appending entries one by one gives exactly the full conversion, reusing the prefix", () => {
  const b = createItemsBuilder();
  for (let n = 1; n <= session.length; n++) {
    const branch = session.slice(0, n);
    const live = { runningToolCallIds: new Set<string>(n % 3 === 0 ? ["c3.1"] : []) };
    assert.deepEqual(b.build(branch, live), itemsFromEntries(branch, live), `after ${n} entries`);
    if (n > 1) assert.equal(b.reused, n - 1);
  }
});

test("builder: streaming output and running calls never leak into the kept state", () => {
  const b = createItemsBuilder();
  const branch = session.slice(0, 20);
  const streaming = { role: "assistant", content: [{ type: "toolCall", id: "s1", name: "bash", arguments: { command: "ls" } }, { type: "text", text: "Wor" }], timestamp: 7 };
  const opts = { streaming, runningToolCallIds: new Set(["s1"]) };
  assert.deepEqual(b.build(branch, opts), itemsFromEntries(branch, opts));
  assert.deepEqual(b.build(branch), itemsFromEntries(branch), "no streaming: none left over");
  // Unresolved calls marked failed in one build are not failed in the kept state.
  const cut = session.slice(0, 3); // user, assistant with calls, one result
  const b2 = createItemsBuilder();
  assert.deepEqual(b2.build(cut, { runningToolCallIds: new Set() }), itemsFromEntries(cut, { runningToolCallIds: new Set() }));
  assert.deepEqual(b2.build(session.slice(0, 6)), itemsFromEntries(session.slice(0, 6)));
});

test("builder: a branch switch, a shorter branch or a new first entry starts over", () => {
  const b = createItemsBuilder();
  b.build(session.slice(0, 30));
  const other: SessionEntryLike[] = [...session.slice(0, 10), { type: "message", id: "x1", parentId: session[9]!.id, message: { role: "user", content: "other way" } }];
  assert.deepEqual(b.build(other), itemsFromEntries(other));
  assert.equal(b.reused, 0);
  assert.deepEqual(b.build(session.slice(0, 5)), itemsFromEntries(session.slice(0, 5)));
  assert.equal(b.reused, 0);
  const compacted = [...session.slice(0, 5), { type: "compaction", id: "k1", summary: "recap" } as SessionEntryLike];
  assert.deepEqual(b.build(compacted), itemsFromEntries(compacted));
  assert.equal(b.reused, 5, "a compaction entry is appended like any other");
});

test("builder: an unchanged item keeps its identity; a call whose result arrived is a new object", () => {
  const b = createItemsBuilder();
  const before = b.build(session.slice(0, 2)); // user + assistant with calls, no results
  const after = b.build(session.slice(0, 3)); // first result
  assert.equal(after[0], before[0], "user item kept");
  const call = before.findIndex((i) => i.kind === "tool");
  assert.notEqual(after[call], before[call]);
  assert.equal((before[call] as Extract<ChatItem, { kind: "tool" }>).status, "running", "the old object is not changed");
  assert.equal(after[call + 1], before[call + 1], "a call still waiting is kept");
});

// --- Rows ---

const W = 60;
function renderBoth(items: ChatItem[], cache: ReturnType<typeof createRowsCache>, open: Set<string>, version: number, width = W, now?: Date) {
  const expanded = (k: string) => open.has(k);
  const kept = renderChatRows(items, width, deps, { expanded, cache, expansionVersion: version, now });
  const fresh = renderChatRows(items, width, deps, { expanded, now });
  assert.deepEqual(snapshot(kept), snapshot(fresh));
  return kept;
}

test("rows: appends and a growing streaming reply give exactly a full render, redrawing only the tail", () => {
  const cache = createRowsCache();
  const b = createItemsBuilder();
  const open = new Set<string>();
  for (let n = 1; n <= session.length; n += 3) renderBoth(b.build(session.slice(0, n)), cache, open, 0);
  const full = b.build(session);
  renderBoth(full, cache, open, 0);
  for (let chars = 5; chars < 200; chars += 40) {
    renderBoth(b.build(session, { streaming: streamingReply(99, chars) }), cache, open, 0);
    assert.ok(cache.kept > full.length - 5, `kept ${cache.kept} of ${full.length}`);
    assert.ok(cache.drawn <= 2, `drew ${cache.drawn} groups`);
  }
  // Streaming done and stored: the streaming items go, the stored ones come.
  renderBoth(b.build(session), cache, open, 0);
});

test("rows: a new step can fold two single rows into a run; the kept part is redrawn from the stretch's start", () => {
  const e = (id: string, message: Record<string, unknown>): SessionEntryLike => ({ type: "message", id, message });
  const call = (id: string) => ({ type: "toolCall", id, name: "bash", arguments: { command: id } });
  const steps = [
    e("u", { role: "user", content: "go" }),
    e("a1", { role: "assistant", content: [call("x1")] }),
    e("a2", { role: "assistant", content: [call("x2")] }),
    e("a3", { role: "assistant", content: [call("x3")] }),
    e("a4", { role: "assistant", content: [{ type: "text", text: "done" }] }),
  ];
  const cache = createRowsCache();
  const b = createItemsBuilder();
  for (let n = 1; n <= steps.length; n++) renderBoth(b.build(steps.slice(0, n)), cache, new Set(), 0);
});

test("rows: toggles, a width change and a branch switch give exactly a full render", () => {
  const cache = createRowsCache();
  const items = itemsFromEntries(session);
  const open = new Set<string>();
  let version = 0;
  renderBoth(items, cache, open, version);
  const run = items.find((i) => i.kind === "tool")!;
  const thought = items.find((i) => i.kind === "thinking")!;
  for (const key of [runKey(run.id), cardKey(run.id), thinkingKey(thought.id)]) {
    open.add(key);
    renderBoth(items, cache, open, ++version);
  }
  renderBoth(items, cache, open, version, 41);
  renderBoth(items, cache, open, version, W);
  renderBoth(itemsFromEntries(session.slice(0, 8)), cache, open, version);
  renderBoth(items, cache, open, version);
});

test("rows: a live run's duration follows the clock on every render, nothing else is redrawn", () => {
  const at = (s: number) => new Date(Date.UTC(2026, 9, 28, 10, 0, s)).toISOString();
  const tool = (id: string, status: "done" | "running", start: number, end?: number): ChatItem =>
    ({ id, kind: "tool", status, ts: at(start), ...(end === undefined ? {} : { end: at(end) }), tool: { kind: "execute", command: id } }) as ChatItem;
  // Eight steps: a live run hides two behind its "earlier steps" row, which carries the time.
  const items = [{ id: "u", kind: "user", text: "hi" } as ChatItem, ...Array.from({ length: 7 }, (_, i) => tool(`s${i}`, "done", i, i + 1)), tool("c", "running", 8)];
  const cache = createRowsCache();
  const first = snapshot(renderBoth(items, cache, new Set(), 0, W, new Date(Date.UTC(2026, 9, 28, 10, 0, 30)))).lines.join("\n");
  const later = snapshot(renderBoth(items, cache, new Set(), 0, W, new Date(Date.UTC(2026, 9, 28, 10, 1, 0)))).lines.join("\n");
  assert.match(first, /30s/);
  assert.match(later, /1m/);
});

test("ChatView: scrolled up while rows are updated in place, the window stays on the same lines", () => {
  const make = (cached: boolean) => {
    const cache = createRowsCache();
    const v = new ChatView({
      ...viewDeps,
      renderLines: (items, width, expanded, expansion) =>
        renderChatRows(items, width, deps, cached ? { expanded, cache, expansionVersion: expansion } : { expanded }),
    });
    v.targetHeight = 8;
    return v;
  };
  const kept = make(true);
  const fresh = make(false);
  const b = createItemsBuilder();
  const step = (n: number, streaming?: number) => {
    const items = b.build(session.slice(0, n), streaming === undefined ? {} : { streaming: streamingReply(9, streaming) });
    kept.setItems(items);
    fresh.setItems(items);
    assert.deepEqual(kept.render(W), fresh.render(W), `n=${n}`);
  };
  step(20);
  kept.scrollBy(-12);
  fresh.scrollBy(-12);
  step(20);
  for (let c = 10; c < 120; c += 30) step(20, c);
  step(30);
  step(session.length);
});

// --- Per frame, images, Chat closed ---

test("countRows: a plain container is counted only up to the cap; anything else is rendered", () => {
  let renders = 0;
  const leaf = (n: number) => ({ render: () => (renders++, Array.from({ length: n }, () => "x")) });
  const isContainer = (n: unknown) => (n as { box?: boolean }).box === true;
  const doc = { box: true, children: Array.from({ length: 1000 }, () => leaf(30)), render: () => { throw new Error("not drawn"); } };
  assert.equal(countRows(doc, 80, 40, isContainer), 40);
  assert.equal(renders, 2, "two children reach 40 rows");
  const short = { box: true, children: [leaf(3), { box: true, children: [leaf(2)], render: () => [] }], render: () => [] };
  assert.equal(countRows(short, 80, 40, isContainer), 5);
  assert.equal(countRows(leaf(7), 80, 40), 7);
  assert.equal(countRows(leaf(70), 80, 40), 40);
  const drawn = { box: true, children: [leaf(1)], render: () => Array.from({ length: 90 }, () => "x") };
  assert.equal(countRows(drawn, 80, 40), 40, "no container test: rendered, then capped");
});

test("image sweep: old children are not walked again; growth at the end, inside the last child and a swapped list are", () => {
  let reads = 0;
  const card = () => {
    const c = { showImages: true, setShowImages: (v: boolean) => void (c.showImages = v) };
    return c;
  };
  const watched = (children: unknown[]) => ({
    get children() {
      reads++;
      return children;
    },
  });
  const old = Array.from({ length: 50 }, () => watched([card()]));
  const chat = { children: old };
  const h = hideImages({ children: [chat] });
  assert.equal(h.count, 50);
  reads = 0;
  assert.equal(h.sweep(), 0);
  assert.equal(reads, 1, "only the last old child is looked at again");
  const inner = card();
  (old.at(-1)!.children as unknown[]).push(inner);
  chat.children.push(watched([card()]));
  assert.equal(h.sweep(), 2);
  assert.equal(inner.showImages, false);
  chat.children = [watched([card()])];
  assert.equal(h.sweep(), 1, "a rebuilt transcript is walked again");
  h.restore();
});

test("Chat closed: events cost O(1) bookkeeping, no timer, no rebuild", () => {
  let timers = 0;
  let refreshes = 0;
  const fake: Timers = { now: () => 0, setTimeout: () => (timers++, 1), clearTimeout: () => {} };
  const feed = createLiveFeed({ isOpen: () => false, refresh: () => void refreshes++, timers: fake });
  for (let i = 0; i < 1000; i++) {
    feed.onEvent({ type: "message_update", message: streamingReply(1, i) });
    feed.onEvent({ type: "tool_execution_start", toolCallId: `c${i}` });
    feed.onEvent({ type: "tool_execution_end", toolCallId: `c${i}` });
    feed.onEvent({ type: "turn_end" });
  }
  assert.deepEqual([timers, refreshes, feed.state.running.size], [0, 0, 0]);
});

test("liveOptions: the stored copy of the streaming message is found within the current turn only", () => {
  const s = createLiveState();
  s.apply({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "x" }], timestamp: 5 } });
  const msg = (id: string, role: string, timestamp?: number): SessionEntryLike => ({ type: "message", id, message: { role, content: "x", timestamp } });
  assert.equal(liveOptions(s, [msg("u", "user"), msg("a", "assistant", 5), msg("r", "toolResult")]).streaming, undefined, "stored");
  assert.ok(liveOptions(s, [msg("u", "user"), msg("a", "assistant", 4)]).streaming, "not stored yet");
  assert.ok(liveOptions(s, [msg("a", "assistant", 5), msg("u", "user")]).streaming, "an older turn's message is not this one");
});

test("the rows cache is bounded: past its size the oldest groups go, and output is still right", () => {
  const cache = createRowsCache(5);
  const items = itemsFromEntries(session);
  renderBoth(items, cache, new Set(), 0);
  assert.ok(cache.groups.size <= 5, String(cache.groups.size));
  renderBoth(items, cache, new Set(), 1);
});
