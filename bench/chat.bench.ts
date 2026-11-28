// How much the chat costs, on synthetic sessions of 200 and 2000 turns: `node bench/chat.bench.ts`.
//
// Plain-text stand-ins replace Pi's theme and Markdown (Pi cannot load outside Pi). The Markdown
// stand-in does real per-line work (inline parsing, wrapping, measuring) and sits behind the same
// 500-entry cache pi-deps.ts puts in front of Pi's Markdown, so cache thrash shows here as it would
// there. Times are medians after warm-up, in milliseconds.

import { performance } from "node:perf_hooks";

import { itemsFromEntries, type SessionEntryLike } from "../src/model/items.ts";
import { ChatView } from "../src/view/chat-view.ts";
import { createChatToggle, type ContextLike, type TuiLike } from "../src/view/controller.ts";
import { GENTLE_SIDEBAR_STATE } from "../src/view/gentle-insets.ts";
import { createLiveFeed, liveOptions } from "../src/view/live.ts";
import { hideImages } from "../src/view/pi-images.ts";
import { createRowsCache, renderChatRows, type RenderDeps } from "../src/view/render.ts";
import { deps as fakes } from "../test/fake-deps.ts";
import { streamingReply, syntheticSession } from "./session.ts";

const WIDTH = 150;
const HEIGHT = 40;

/** Markdown with real work per line, cached as pi-deps.ts caches Pi's (500 entries, cleared when full). */
function costlyMarkdown(): RenderDeps["markdown"] {
  const cache = new Map<string, string[]>();
  return (text, width) => {
    const key = `${width}\0${text}`;
    const hit = cache.get(key);
    if (hit !== undefined) return [...hit];
    const lines = text.split("\n").flatMap((l) => {
      const styled = l
        .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
        .replace(/`([^`]+)`/g, "<code>$1</code>")
        .replace(/^(#+) (.*)$/, "<h>$2</h>")
        .replace(/^- /, "• ");
      return fakes.wrap(styled, width).map((r) => r + " ".repeat(Math.max(0, width - fakes.visibleWidth(r))));
    });
    if (cache.size >= 500) cache.clear();
    cache.set(key, lines);
    return [...lines];
  };
}

const renderDeps = (): RenderDeps => ({ ...fakes, markdown: costlyMarkdown() });

function median(fn: () => void, runs: number, warmup = 3): number {
  for (let i = 0; i < warmup; i++) fn();
  const times: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    fn();
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  return times[Math.floor(times.length / 2)]!;
}

/** A component that renders `n` cached lines, as Pi's components return their cached render. */
const block = (n: number) => {
  const lines = Array.from({ length: n }, (_, i) => `line ${i}`);
  return { render: () => lines };
};

/** Pi's transcript in regular mode: a container that concatenates its children's cached lines. */
function transcript(components: number) {
  const children = Array.from({ length: components }, () => block(30));
  return { container: true, children, render: () => children.flatMap((c) => c.render()) };
}

/** A fake tree of `n` components, a tenth of them tool cards with an image switch. */
function tree(n: number) {
  const children: unknown[] = [];
  for (let i = 0; i < n; i++) {
    const card = { showImages: true, children: [] as unknown[], setShowImages: (v: boolean) => void (card.showImages = v) };
    children.push(i % 10 === 0 ? card : { children: [{}, {}] });
  }
  return { children: [{ children }] };
}

function harness(entries: SessionEntryLike[], mode: "fullscreen" | "regular") {
  const live = createLiveFeed({ isOpen: () => chat.isOpen(), refresh: () => chat.refresh() });
  let frameOptions: Record<string, unknown> | undefined;
  let view: ChatView | undefined;
  const header = { render: (w: number) => [`Gentle · ${"─".repeat(Math.max(0, w - 12))}`, "status row", "─".repeat(w)] };
  const terminal = {
    rows: HEIGHT,
    columns: WIDTH + 40,
    [GENTLE_SIDEBAR_STATE]: { active: true, ownsHost: () => true, railColumns: 40, parts: new Map([["header", header]]) },
  };
  // SAFETY: the fake carries every TuiLike field the controller reads (mode, children, terminal,
  // requestRender); the Gentle state sits on a symbol key TuiLike does not declare.
  const tui = {
    mode,
    children: [transcript(entries.length / 2), block(2), block(1), block(1), block(8), block(0), block(12)],
    terminal,
    requestRender: () => {},
  } as unknown as TuiLike;
  const d = renderDeps();
  // As pi-deps.ts wires a view: one rows cache per view; plain containers counted, not drawn.
  const cache = createRowsCache();
  const chat = createChatToggle({
    createView: () => new ChatView({ ...fakes, renderLines: (items, width, expanded, expansion) => renderChatRows(items, width, d, { expanded, now: new Date(), cache, expansionVersion: expansion }) }),
    isContainer: (node) => node !== null && typeof node === "object" && (node as { container?: boolean }).container === true,
    matchesKey: () => false,
    liveOptions: (branch) => liveOptions(live.state, branch),
    onClose: () => live.stop(),
  });
  const ctx: ContextLike = {
    mode: "tui",
    sessionManager: { getBranch: () => entries },
    ui: {
      notify: () => {},
      onTerminalInput: () => () => {},
      custom: (factory, options) => {
        view = factory(tui, {}, {}, () => {});
        frameOptions = options.overlayOptions();
        return new Promise(() => {});
      },
    },
  };
  return { chat, ctx, live, tui, get view() { return view!; }, get options() { return frameOptions!; } };
}

interface Row {
  name: string;
  values: number[];
}

function run(): void {
  const rows: Row[] = [];
  const add = (name: string, values: number[]) => rows.push({ name, values });
  const sizes = [200, 2000];
  const sessions = sizes.map(syntheticSession);
  const runs = (turns: number) => (turns > 500 ? 15 : 41);

  add(
    "(a) itemsFromEntries, whole session",
    sessions.map((s) => median(() => itemsFromEntries(s), runs(s.length / 8))),
  );
  add(
    "(b) renderChatRows, whole session (cold cache)",
    sessions.map((s) => {
      const items = itemsFromEntries(s);
      return median(() => renderChatRows(items, WIDTH, renderDeps(), { now: new Date() }), runs(s.length / 8), 1);
    }),
  );
  add(
    "(c) ChatView.render, cached frame",
    sessions.map((s) => {
      const h = harness(s, "fullscreen");
      h.chat.toggle(h.ctx);
      h.view.render(WIDTH);
      return median(() => h.view.render(WIDTH), 2001, 50);
    }),
  );
  for (const mode of ["fullscreen", "regular"] as const) {
    add(
      `(d) per frame: visible() + getters + render, ${mode}`,
      sessions.map((s) => {
        const h = harness(s, mode);
        h.chat.toggle(h.ctx);
        const o = h.options;
        return median(() => {
          (o.visible as (w: number, r: number) => boolean)(WIDTH + 40, HEIGHT);
          void [o.row, o.width, o.maxHeight];
          h.view.render(WIDTH);
        }, 2001, 50);
      }),
    );
  }
  add(
    "(e) live rebuild: one streaming update",
    sessions.map((s, k) => {
      const h = harness(s, "fullscreen");
      h.chat.toggle(h.ctx);
      h.view.render(WIDTH);
      let chars = 10;
      return median(() => {
        h.live.onEvent({ type: "message_update", message: streamingReply(sizes[k]!, (chars += 7)) });
        h.chat.refresh();
        h.view.render(WIDTH);
      }, runs(s.length / 8));
    }),
  );
  add(
    "(f) hideImages + sweep, 4000 components",
    [4000, 4000].map((n, k) => {
      const root = tree(n);
      const handle = hideImages(root);
      return k === 0 ? median(() => hideImages(tree(n)).restore(), 21) : median(() => handle.sweep(), 201);
    }),
  );
  add(
    "(g) Chat closed: one Pi event, in µs",
    sessions.map((s) => {
      const h = harness(s, "fullscreen");
      const events = [
        { type: "message_update", message: streamingReply(1, 30) },
        { type: "tool_execution_start", toolCallId: "x" },
        { type: "tool_execution_end", toolCallId: "x" },
        { type: "turn_end" },
      ];
      let i = 0;
      return median(() => {
        for (let k = 0; k < 1000; k++) h.live.onEvent(events[i++ % events.length]!);
      }, 51); // 1000 events in ms = one event in µs
    }),
  );

  const label = (n: number) => (n < 0.01 ? n.toFixed(4) : n < 1 ? n.toFixed(3) : n.toFixed(1));
  console.log(`chat bench · width ${WIDTH} · height ${HEIGHT} · median ms`);
  console.log(`${"".padEnd(52)}${"200 turns".padStart(12)}${"2000 turns".padStart(12)}`);
  for (const r of rows) {
    const cols = r.name.startsWith("(f)") ? ["first hide", "re-sweep"] : undefined;
    console.log(`${r.name.padEnd(52)}${r.values.map((v, i) => `${label(v)}${cols ? ` ${cols[i]}` : ""}`.padStart(12)).join("")}`);
  }
}

run();
