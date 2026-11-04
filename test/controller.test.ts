import { test } from "node:test";
import assert from "node:assert/strict";

import { ChatView } from "../src/view/chat-view.ts";
import { createChatToggle, NEEDS_TUI, UNAVAILABLE, type ContextLike, type ControllerDeps, type TuiLike } from "../src/view/controller.ts";
import { renderChatRows } from "../src/view/render.ts";
import { deps } from "./fake-deps.ts";
import { GENTLE_SIDEBAR_STATE } from "../src/view/gentle-insets.ts";

const rows = (n: number) => ({ render: () => Array.from({ length: n }, () => "x") });

function harness(opts: { mode?: string; tui?: Partial<TuiLike>; matches?: (data: string, id: string) => boolean; live?: ControllerDeps["liveOptions"]; onClose?: () => void } = {}) {
  const notices: [string, string | undefined][] = [];
  const handlers: ((data: string) => { consume?: boolean } | undefined)[] = [];
  let unsubscribed = 0;
  let renders = 0;
  let doneCalls = 0;
  let overlayOptions: (() => Record<string, unknown>) | undefined;
  let view: ChatView | undefined;
  let resolve: (() => void) | undefined;
  const tui: TuiLike = {
    mode: "fullscreen",
    children: [rows(100), rows(2), rows(5), rows(3)],
    terminal: { rows: 40, columns: 80 },
    requestRender: () => void renders++,
    ...opts.tui,
  };
  const ctx: ContextLike = {
    mode: opts.mode ?? "tui",
    sessionManager: {
      getBranch: () => [{ type: "message", id: "u1", timestamp: "2026-10-27T10:00:00.000Z", message: { role: "user", content: "hello" } }],
    },
    ui: {
      notify: (m, t) => void notices.push([m, t]),
      onTerminalInput: (h) => {
        handlers.push(h);
        return () => void unsubscribed++;
      },
      custom: (factory, options) =>
        new Promise((res) => {
          resolve = () => res(undefined);
          overlayOptions = options.overlayOptions;
          view = factory(tui, {}, { matches: opts.matches }, () => {
            doneCalls++;
            resolve?.();
          });
          options.onHandle({ isFocused: () => false });
        }),
    },
  };
  const chat = createChatToggle({
    createView: () => new ChatView({ ...deps, renderLines: (items, width, expanded) => renderChatRows(items, width, deps, { expanded }) }),
    matchesKey: (data, key) => data === key,
    liveOptions: opts.live,
    onClose: opts.onClose,
  });
  return {
    chat,
    ctx,
    tui,
    notices,
    handlers,
    get unsubscribed() { return unsubscribed; },
    get renders() { return renders; },
    get doneCalls() { return doneCalls; },
    get overlayOptions() { return overlayOptions; },
    get view() { return view; },
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

test("outside the TUI the chat refuses to open with a notice", () => {
  const h = harness({ mode: "rpc" });
  h.chat.toggle(h.ctx);
  assert.deepEqual(h.notices, [[NEEDS_TUI, "warning"]]);
  assert.equal(h.overlayOptions, undefined);
  assert.equal(h.chat.isOpen(), false);
});

test("opens as a non-capturing, full-width overlay over the transcript rows only", () => {
  const h = harness();
  h.chat.toggle(h.ctx);
  assert.equal(h.chat.isOpen(), true);
  const o = h.overlayOptions!();
  assert.deepEqual({ ...o, visible: undefined }, {
    anchor: "top-left", row: 0, col: 0, width: "100%", maxHeight: 30, margin: 0, nonCapturing: true, visible: undefined,
  });
  assert.equal((o.visible as () => boolean)(), true);
  assert.equal(h.view!.targetHeight, 30);
  assert.equal(h.view!.render(80).length, 30);
  assert.deepEqual(h.notices, []);
  // Items come from the active branch.
  assert.ok(h.view!.render(80).some((l) => l.includes("hello")));
});

test("with Gentle's header and Status rail painting, the chat sits below the header and left of the rail", () => {
  let measuredAt = -1;
  const bottom = { render: (w: number) => ((measuredAt = w), Array.from({ length: 5 }, () => "x")) };
  const terminal = {
    rows: 40,
    columns: 200,
    [GENTLE_SIDEBAR_STATE]: {
      active: true,
      ownsHost: () => true,
      railColumns: 53,
      parts: new Map([["header", { render: () => ["✿ Gentle Shell"] }]]),
    },
  };
  const h = harness({ tui: { children: [rows(100), bottom], terminal } });
  h.chat.toggle(h.ctx);
  const o = h.overlayOptions!();
  assert.deepEqual({ row: o.row, col: o.col, width: o.width, maxHeight: o.maxHeight }, { row: 1, col: 0, width: 147, maxHeight: 34 });
  assert.equal(measuredAt, 147, "the bottom region is measured in the editor column");
  assert.equal(h.view!.render(147).length, 34);
});

test("sizing follows the live bottom region and the regular-mode transcript", () => {
  const h = harness({ tui: { mode: "regular", children: [rows(6), rows(10)] } });
  h.chat.toggle(h.ctx);
  assert.equal(h.overlayOptions!().maxHeight, 6);
  h.tui.children = [rows(6), rows(36)];
  assert.equal(h.overlayOptions!().maxHeight, 4, "bottom grew: min(6+36, 40) - 36");
  h.tui.children = [rows(6), rows(38)];
  const o = h.overlayOptions!();
  assert.equal((o.visible as () => boolean)(), false, "under 3 rows: hidden");
});

test("an unexpected layout fails closed: notice, nothing drawn, closed", async () => {
  for (const tui of [{ children: [rows(10)] }, { mode: undefined }] as Partial<TuiLike>[]) {
    const h = harness({ tui });
    h.chat.toggle(h.ctx);
    assert.deepEqual(h.notices, [[UNAVAILABLE, "error"]]);
    assert.equal((h.overlayOptions!().visible as () => boolean)(), false);
    assert.equal(h.handlers.length, 0, "no key listener");
    await tick();
    assert.equal(h.doneCalls, 1);
    assert.equal(h.chat.isOpen(), false);
  }
});

test("scroll keys are consumed only while the chat is open; others pass through", async () => {
  const h = harness({ tui: { children: [rows(100), rows(37)] } }); // 3 rows: header + 2
  h.ctx.sessionManager.getBranch = () =>
    Array.from({ length: 10 }, (_, i) => ({ type: "message", id: `u${i}`, message: { role: "user", content: `m${i}` } }));
  h.chat.toggle(h.ctx);
  const [onKey] = h.handlers;
  assert.ok(onKey);
  h.view!.render(80);
  assert.deepEqual(onKey("pageUp"), { consume: true });
  assert.match(h.view!.render(80)[0]!, /more/);
  assert.deepEqual(onKey("ctrl+end"), { consume: true });
  assert.doesNotMatch(h.view!.render(80)[0]!, /more/);
  assert.deepEqual(onKey("ctrl+home"), { consume: true });
  assert.deepEqual(onKey("pageDown"), { consume: true });
  assert.equal(onKey("a"), undefined);
  assert.equal(onKey("enter"), undefined);
  assert.ok(h.renders >= 4);

  h.chat.toggle(h.ctx);
  assert.equal(h.chat.isOpen(), false);
  assert.equal(h.doneCalls, 1);
  assert.equal(h.unsubscribed, 1);
  assert.equal(onKey("pageUp"), undefined, "closed: Pi gets pageUp back");
  await tick();
  assert.equal(h.unsubscribed, 1, "unsubscribed once");
});

for (const prop of ["viewportTop", "scrollTop"]) test(`in fullscreen the chat follows Pi's own transcript scrolling via ${prop} (PgUp/PgDn, ctrl+home/end never reach it)`, () => {
  const pi = { scrollTop: 500, isFollowingOutput: true };
  const h = harness({ tui: { children: [rows(100), rows(37)] } }); // 3 rows: header + 2
  Object.defineProperty(h.tui, prop, { get: () => pi.scrollTop });
  Object.defineProperty(h.tui, "isFollowingOutput", { get: () => pi.isFollowingOutput });
  h.ctx.sessionManager.getBranch = () =>
    Array.from({ length: 10 }, (_, i) => ({ type: "message", id: `u${i}`, message: { role: "user", content: `m${i}` } }));
  h.chat.toggle(h.ctx);
  const frame = () => (h.overlayOptions!(), h.view!.render(80));
  frame();
  assert.doesNotMatch(frame()[0]!, /more/, "opening never scrolls by itself");

  // PgUp: Pi scrolls its hidden transcript up a page and stops following.
  pi.scrollTop = 470;
  pi.isFollowingOutput = false;
  const up = frame()[0]!;
  assert.match(up, /↓ \d+ more/);
  const offset = Number(/↓ (\d+) more/.exec(up)![1]);
  assert.ok(offset > 0);
  assert.equal(frame()[0], up, "no new Pi scroll, no chat scroll");

  // PgDn back down a little, still not following.
  pi.scrollTop = 480;
  assert.equal(Number(/↓ (\d+) more/.exec(frame()[0]!)?.[1] ?? 0) < offset, true);

  // ctrl+home: Pi at its top, the chat at its top.
  pi.scrollTop = 0;
  frame();
  assert.match(frame().slice(1).join("\n"), /You[^\n]*\n[^\n]*m0/, "first user box at the top");

  // ctrl+end: Pi follows the end again, so does the chat.
  pi.scrollTop = 500;
  pi.isFollowingOutput = true;
  assert.doesNotMatch(frame()[0]!, /more/);
});

test("rebound keys are honoured through Pi's keybindings", () => {
  const h = harness({ matches: (data, id) => data === "\x1b[5;5~" && id === "tui.altScreen.pageUp" });
  h.chat.toggle(h.ctx);
  assert.deepEqual(h.handlers[0]!("\x1b[5;5~"), { consume: true });
});

test("close() (session_shutdown) closes an open chat and is idempotent", () => {
  const h = harness();
  h.chat.toggle(h.ctx);
  h.chat.close();
  h.chat.close();
  assert.equal(h.doneCalls, 1);
  assert.equal(h.chat.isOpen(), false);
});

test("refresh reloads the branch and redraws", () => {
  const h = harness();
  h.chat.toggle(h.ctx);
  h.ctx.sessionManager.getBranch = () => [{ type: "message", id: "u9", message: { role: "user", content: "fresh" } }];
  const before = h.renders;
  h.chat.refresh();
  assert.equal(h.renders, before + 1);
  assert.ok(h.view!.render(80).some((l) => l.includes("fresh")));
});

test("live options flow into open and refresh: the streaming reply shows with its cursor", () => {
  let text = "Thin";
  const h = harness({ live: () => ({ streaming: { role: "assistant", content: [{ type: "text", text }], timestamp: 1 } }) });
  h.chat.toggle(h.ctx);
  assert.ok(h.view!.render(80).some((l) => l.includes("Thin▍")));
  text = "Thinking more";
  h.chat.refresh();
  assert.ok(h.view!.render(80).some((l) => l.includes("Thinking more▍")));
});

test("onClose runs once per close, from toggle and from close()", () => {
  let closes = 0;
  const h = harness({ onClose: () => void closes++ });
  h.chat.toggle(h.ctx);
  h.chat.toggle(h.ctx);
  assert.equal(closes, 1);
  h.chat.toggle(h.ctx);
  h.chat.close();
  h.chat.close();
  assert.equal(closes, 2);
});

test("ctrl+t / ctrl+o toggle every thinking row / tool run while open, and pass through once closed", () => {
  const h = harness();
  h.ctx.sessionManager.getBranch = () => [
    { type: "message", id: "a1", message: { role: "assistant", content: [
      { type: "thinking", thinking: "why\nbecause" },
      { type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } },
      { type: "toolCall", id: "c2", name: "bash", arguments: { command: "pwd" } },
    ] } },
    { type: "message", id: "r1", message: { role: "toolResult", toolCallId: "c1", content: [{ type: "text", text: "" }] } },
    { type: "message", id: "r2", message: { role: "toolResult", toolCallId: "c2", content: [{ type: "text", text: "" }] } },
  ];
  h.chat.toggle(h.ctx);
  const [onKey] = h.handlers;
  const text = () => h.view!.render(80).join("\n");
  assert.match(text(), /›<\/dim> <muted>2 commands<\/muted>/);
  assert.deepEqual(onKey!("ctrl+o"), { consume: true });
  assert.match(text(), /⌄<\/dim> <muted>2 commands<\/muted>/);
  assert.match(text(), /✻<\/dim> <i><thinkingText>why<\/thinkingText><\/i>/);
  assert.doesNotMatch(text(), /because/);
  assert.deepEqual(onKey!("ctrl+t"), { consume: true });
  assert.match(text(), /✻<\/dim> <i><thinkingText>why<\/thinkingText><\/i>/);
  assert.match(text(), /because/);
  h.chat.toggle(h.ctx);
  assert.equal(onKey!("ctrl+t"), undefined, "closed: Pi's thinking toggle again");
  assert.equal(onKey!("ctrl+o"), undefined);
});

test("expand toggles honour Pi's app.thinking.toggle / app.tools.expand bindings", () => {
  const h = harness({ matches: (data, id) => (data === "T" && id === "app.thinking.toggle") || (data === "O" && id === "app.tools.expand") });
  h.chat.toggle(h.ctx);
  assert.deepEqual(h.handlers[0]!("T"), { consume: true });
  assert.deepEqual(h.handlers[0]!("O"), { consume: true });
});

test("images: Pi's cards stop drawing images while Chat is open and come back on close", () => {
  const card = (show = true) => {
    const c = { showImages: show, calls: [] as boolean[], render: () => ["x"], setShowImages(v: boolean) { c.calls.push(v); c.showImages = v; } };
    return c;
  };
  const a = card(), off = card(false);
  const transcript = { children: [{ children: [a, off] }] as unknown[], render: () => ["x"] };
  const h = harness({ tui: { children: [transcript, rows(5)] } });
  h.chat.toggle(h.ctx);
  assert.deepEqual(a.calls, [false]);
  assert.deepEqual(off.calls, []);
  // A card added while Chat is open is switched on the next rebuild.
  const late = card();
  transcript.children.push(late);
  h.chat.refresh();
  assert.deepEqual(late.calls, [false]);
  const before = h.renders;
  h.chat.close();
  assert.deepEqual(a.calls, [false, true]);
  assert.deepEqual(late.calls, [false, true]);
  assert.deepEqual(off.calls, []);
  assert.ok(h.renders > before, "redrawn with the images back");
  // Closed: nothing is touched.
  const after = card();
  transcript.children.push(after);
  h.chat.refresh();
  assert.deepEqual(after.calls, []);
});

test("images: a layout that fails closed never touches the cards", async () => {
  const c = { showImages: true, calls: [] as boolean[], render: () => ["x"], setShowImages(v: boolean) { c.calls.push(v); c.showImages = v; } };
  const h = harness({ tui: { children: [{ children: [c], render: () => [] }] } });
  h.chat.toggle(h.ctx);
  await tick();
  assert.deepEqual(c.calls, []);
});

test("Pi reads the overlay options object once: its size and place still follow a resize (zoom) while Chat is open", () => {
  const state = { active: true, ownsHost: () => true, railColumns: 53, parts: new Map([["header", { render: () => ["✿ Gentle Shell"] }]]) };
  const terminal = { rows: 40, columns: 200, [GENTLE_SIDEBAR_STATE]: state };
  const h = harness({ tui: { children: [rows(100), rows(5)], terminal } });
  h.chat.toggle(h.ctx);
  const o = h.overlayOptions!(); // the one object Pi keeps
  const visible = o.visible as () => boolean;
  assert.ok(visible());
  assert.deepEqual([o.row, o.width, o.maxHeight], [1, 147, 34]);
  // Zoom in: fewer columns and rows, rail still painting.
  terminal.columns = 160;
  terminal.rows = 30;
  assert.ok(visible());
  assert.deepEqual([o.row, o.width, o.maxHeight], [1, 107, 24]);
  // Narrower than Gentle's breakpoint: no rail, no header row -> whole width from row 0.
  terminal.columns = 120;
  state.active = false;
  state.parts = new Map();
  assert.ok(visible());
  assert.deepEqual([o.row, o.width, o.maxHeight], [0, "100%", 25]);
});

test("selection: release copies through Pi's clipboard; Escape clears only a selection", async () => {
  const copied: string[] = [];
  const h = harness({ tui: { copyTextToClipboard: async (t: string) => (copied.push(t), true) } as Partial<TuiLike> });
  h.chat.toggle(h.ctx);
  const [onKey] = h.handlers;
  assert.equal(onKey!("escape"), undefined, "no selection: Escape is Pi's");
  h.view!.render(80);
  h.view!.handleMouse({ type: "press", button: "left", x: 2, y: 1 }); // x 2: just past the margin
  h.view!.handleMouse({ type: "drag", button: "left", x: 11, y: 2 });
  h.view!.handleMouse({ type: "release", button: "left", x: 11, y: 2 });
  await tick();
  assert.equal(copied.length, 1);
  assert.deepEqual(onKey!("escape"), { consume: true });
  assert.equal(h.view!.hasSelection(), false);
  assert.equal(onKey!("escape"), undefined);
});

test("selection: with copy-on-select off nothing is copied; OSC 52 copies say so", async () => {
  const off: string[] = [];
  const h = harness({ tui: { getCopyOnSelect: () => false, copyTextToClipboard: async (t: string) => (off.push(t), true) } as Partial<TuiLike> });
  h.chat.toggle(h.ctx);
  h.view!.render(80);
  h.view!.handleMouse({ type: "press", button: "left", x: 2, y: 1 }); // x 2: just past the margin
  h.view!.handleMouse({ type: "drag", button: "left", x: 11, y: 2 });
  h.view!.handleMouse({ type: "release", button: "left", x: 11, y: 2 });
  await tick();
  assert.deepEqual(off, []);
  const writes: string[] = [];
  const o = harness({ tui: { terminal: { rows: 40, columns: 80, write: (s: string) => void writes.push(s) } } as Partial<TuiLike> });
  o.chat.toggle(o.ctx);
  o.view!.render(80);
  o.view!.handleMouse({ type: "press", button: "left", x: 2, y: 1 }); // x 2: just past the margin
  o.view!.handleMouse({ type: "drag", button: "left", x: 11, y: 2 });
  o.view!.handleMouse({ type: "release", button: "left", x: 11, y: 2 });
  await tick();
  assert.equal(writes.length, 1);
  assert.match(writes[0]!, /^\x1b\]52;c;/);
  assert.deepEqual(o.notices, [["Copied 2 lines", "info"]]);
});

test("scrolled up by wheel during a working turn, new output and Pi's following transcript never move the chat", () => {
  const pi = { top: 500, following: true };
  const h = harness({ tui: { children: [rows(100), rows(33)] } }); // 7 rows: header + 6
  Object.defineProperty(h.tui, "viewportTop", { get: () => pi.top });
  Object.defineProperty(h.tui, "isFollowingOutput", { get: () => pi.following });
  let n = 30;
  h.ctx.sessionManager.getBranch = () =>
    Array.from({ length: n }, (_, i) => ({ type: "message", id: `u${i}`, message: { role: "user", content: `m${i}` } }));
  h.chat.toggle(h.ctx);
  const frame = () => (h.overlayOptions!(), h.view!.render(80));
  frame();
  frame();
  // The reader wheels up.
  h.view!.handleMouse({ type: "wheel", wheelDelta: -10 } as never);
  const before = frame().slice(1).join("\n");
  assert.match(frame()[0]!, /↓ 10 more/);
  // Output arrives: new items, and Pi's hidden transcript (still following its end) grows.
  for (let k = 0; k < 3; k++) {
    n += 2;
    pi.top += 9;
    h.chat.refresh();
    const now = frame();
    assert.equal(now.slice(1).join("\n"), before, `update ${k}: the window stays on the same lines`);
    assert.match(now[0]!, /↓ \d+ more/);
  }
  // Wheeling back down to the end follows again.
  h.view!.handleMouse({ type: "wheel", wheelDelta: 1000 } as never);
  assert.doesNotMatch(frame()[0]!, /more/);
  n += 2;
  pi.top += 9;
  h.chat.refresh();
  assert.doesNotMatch(frame()[0]!, /more/, "at the bottom, new output is followed");
  assert.match(frame().slice(1).join("\n"), new RegExp(`m${n - 1}`));
  // ctrl+end after Pi stopped following: following resumes and the chat jumps to the end.
  h.view!.handleMouse({ type: "wheel", wheelDelta: -5 } as never);
  pi.following = false;
  pi.top -= 20; // PgUp in Pi
  frame();
  pi.following = true;
  pi.top += 20;
  assert.doesNotMatch(frame()[0]!, /more/);
});
