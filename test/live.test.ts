import { test } from "node:test";
import assert from "node:assert/strict";

import { itemsFromEntries, type SessionEntryLike } from "../src/model/items.ts";
import { createLiveFeed, createLiveState, createThrottle, LIVE_EVENTS, liveOptions, type Timers } from "../src/view/live.ts";
import { renderChat } from "../src/view/render.ts";
import { deps, strip } from "./fake-deps.ts";

/** A clock the test moves by hand. */
function fakeTimers() {
  let now = 0;
  let nextId = 1;
  const pending = new Map<number, { at: number; fn: () => void }>();
  const timers: Timers = {
    now: () => now,
    setTimeout: (fn, ms) => {
      const id = nextId++;
      pending.set(id, { at: now + Math.max(0, ms), fn });
      return id;
    },
    clearTimeout: (id) => void pending.delete(Number(id)),
  };
  const advance = (ms: number) => {
    const until = now + ms;
    for (;;) {
      const due = [...pending.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (due === undefined) break;
      pending.delete(due[0]);
      now = due[1].at;
      due[1].fn();
    }
    now = until;
  };
  return { timers, advance, get pending() { return pending.size; } };
}

const assistant = (content: unknown[], timestamp = 5) => ({ role: "assistant", content, timestamp });

test("throttle: at most one run per interval, trailing edge guaranteed, never synchronous", () => {
  const clock = fakeTimers();
  let runs = 0;
  const t = createThrottle(() => void runs++, 80, clock.timers);
  t.schedule();
  assert.equal(runs, 0, "deferred, so Pi has stored the entry first");
  clock.advance(0);
  assert.equal(runs, 1);
  for (let i = 0; i < 10; i++) {
    t.schedule();
    clock.advance(10);
  }
  assert.equal(runs, 2, "100 ms of updates: one more run");
  clock.advance(80);
  assert.equal(runs, 3, "trailing edge after the burst");
  clock.advance(1000);
  assert.equal(runs, 3);
  assert.equal(clock.pending, 0);
});

test("throttle: cancel drops a pending run and leaves no timer", () => {
  const clock = fakeTimers();
  let runs = 0;
  const t = createThrottle(() => void runs++, 80, clock.timers);
  t.schedule();
  t.cancel();
  assert.equal(clock.pending, 0);
  clock.advance(500);
  assert.equal(runs, 0);
});

test("live state: streaming from message_update, cleared on message_end; running ids from tool_execution_*", () => {
  const s = createLiveState();
  s.apply({ type: "message_update", message: assistant([{ type: "text", text: "Hel" }]) });
  assert.equal(s.streaming?.content && (s.streaming.content as { text: string }[])[0]!.text, "Hel");
  // A user or tool-result message never becomes the streaming reply.
  s.apply({ type: "message_update", message: { role: "user", content: "x" } });
  assert.equal((s.streaming?.content as { text: string }[])[0]!.text, "Hel");
  s.apply({ type: "message_end", message: assistant([{ type: "text", text: "Hello" }]) });
  assert.equal(s.streaming, undefined);

  s.apply({ type: "tool_execution_start", toolCallId: "c1" });
  s.apply({ type: "tool_execution_start", toolCallId: "c2" });
  s.apply({ type: "tool_execution_end", toolCallId: "c1" });
  assert.deepEqual([...s.running], ["c2"]);
  s.apply({ type: "message_update", message: assistant([{ type: "text", text: "a" }]) });
  s.apply({ type: "agent_settled" });
  assert.deepEqual([...s.running], []);
  assert.equal(s.streaming, undefined);
  s.apply({ type: "tool_execution_start", toolCallId: "c3" });
  s.reset();
  assert.deepEqual([...s.running], []);
});

test("liveOptions: the streaming reply is partial and ends with the cursor", () => {
  const s = createLiveState();
  s.apply({ type: "message_update", message: assistant([{ type: "text", text: "Writing" }]) });
  const branch: SessionEntryLike[] = [{ type: "message", id: "u1", message: { role: "user", content: "hi", timestamp: 1 } }];
  const items = itemsFromEntries(branch, liveOptions(s, branch));
  assert.deepEqual(items.at(-1), { id: "streaming:0", ts: new Date(5).toISOString(), kind: "reply", text: "Writing", partial: true });
  assert.equal(strip(renderChat(items, 40, deps).at(-1)!), "Writing▍");
});

test("liveOptions: a running tool in the streaming turn draws running; one Pi already stored is not drawn twice", () => {
  const s = createLiveState();
  const msg = assistant([{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } }], 9);
  s.apply({ type: "message_update", message: msg });
  s.apply({ type: "tool_execution_start", toolCallId: "c1" });
  const empty: SessionEntryLike[] = [];
  const live = itemsFromEntries(empty, liveOptions(s, empty));
  assert.deepEqual(live.map((i) => i.kind === "tool" && i.status), ["running"]);
  // Pi stored the message before message_end reached us: the stored one wins.
  const stored: SessionEntryLike[] = [{ type: "message", id: "a1", message: msg }];
  const opts = liveOptions(s, stored);
  assert.equal(opts.streaming, undefined);
  assert.deepEqual(opts.runningToolCallIds, new Set(["c1"]));
  assert.deepEqual(itemsFromEntries(stored, opts).map((i) => i.kind === "tool" && i.status), ["running"]);
});

test("feed: tracks every event, rebuilds only while open, throttled, and stops its timer on close", () => {
  const clock = fakeTimers();
  let open = false;
  let refreshes = 0;
  const feed = createLiveFeed({ isOpen: () => open, refresh: () => void refreshes++, timers: clock.timers, intervalMs: 80 });

  feed.onEvent({ type: "tool_execution_start", toolCallId: "c1" });
  clock.advance(500);
  assert.equal(refreshes, 0, "closed: no rebuild, no timer");
  assert.equal(clock.pending, 0);
  assert.deepEqual([...feed.state.running], ["c1"], "closed: still tracked, so opening mid-turn is right");

  open = true;
  for (const type of LIVE_EVENTS) feed.onEvent({ type });
  clock.advance(0);
  assert.equal(refreshes, 1, "a burst of events is one rebuild");
  for (let i = 0; i < 20; i++) {
    feed.onEvent({ type: "message_update", message: assistant([{ type: "text", text: "x".repeat(i) }]) });
    clock.advance(10);
  }
  clock.advance(100);
  assert.ok(refreshes >= 3 && refreshes <= 4, `200 ms of streaming at 80 ms: ${refreshes}`);

  feed.onEvent({ type: "message_update", message: assistant([]) });
  open = false;
  feed.stop();
  assert.equal(clock.pending, 0);
  const before = refreshes;
  clock.advance(500);
  assert.equal(refreshes, before);

  // tool_execution_update has nothing the chat draws: no rebuild.
  open = true;
  feed.onEvent({ type: "tool_execution_update", toolCallId: "c1" });
  assert.equal(clock.pending, 0);
});

test("LIVE_EVENTS: the events that change what the chat draws", () => {
  assert.deepEqual([...LIVE_EVENTS].sort(), [
    "agent_settled", "message_end", "message_update", "session_compact", "session_start", "session_tree",
    "tool_execution_end", "tool_execution_start", "turn_end",
  ]);
});
