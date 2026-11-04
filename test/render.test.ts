import { test } from "node:test";
import assert from "node:assert/strict";

import type { ChatItem, ChatToolCall, ChatToolStatus } from "../src/model/items.ts";
import { cardKey, isRunKey, noticeKey, outputAllKey, outputKey, renderChat, renderChatRows, runKey, thinkingKey } from "../src/view/render.ts";
import { deps, strip } from "./fake-deps.ts";

// A local wall-clock time, so the expected "hh:mm" holds in any time zone.
const TS = new Date(2026, 9, 27, 9, 5).toISOString();
const NOW = new Date(2026, 9, 27, 12, 0);
const W = 40;

let n = 0;
const tool = (t: ChatToolCall, status: ChatToolStatus = "done"): ChatItem => ({ id: `t${++n}`, kind: "tool", tool: t, status });
const cmd = (status?: ChatToolStatus, command = "ls") => tool({ kind: "execute", command }, status);
const edit = (path = "a.ts") => tool({ kind: "edit", path });
const render = (items: ChatItem[], width = W) => renderChat(items, width, deps, { now: NOW });
/** As `render`, every toggle open: an answered question folds, these tests read its opened card. */
const renderOpen = (items: ChatItem[], width = W) => renderChat(items, width, deps, { now: NOW, expanded: () => true }).map(strip);
const plain = (items: ChatItem[], width = W) => render(items, width).map(strip);

test("user turn: tinted box, 'You · hh:mm' label in warning, every line padded to full width", () => {
  const lines = render([{ id: "u", ts: TS, kind: "user", text: "hello there, this is a message long enough to wrap" }]);
  assert.ok(lines.length >= 3, "label + at least two wrapped lines");
  for (const line of lines) {
    assert.match(line, /^<userMessageBg>.*<\/userMessageBg>$/);
    assert.equal(deps.visibleWidth(line), W);
  }
  assert.match(lines[0]!, /<warning>You · 09:05<\/warning>/);
  assert.equal(strip(lines.slice(1).join(" ")).replace(/▎/g, "").replace(/\s+/g, " ").trim(), "hello there, this is a message long enough to wrap");
});

test("user turn from another day carries its date", () => {
  const [label] = plain([{ id: "u", ts: new Date(2026, 9, 20, 18, 30).toISOString(), kind: "user", text: "hi" }]);
  assert.match(label!, /You · 2026-10-20 18:30/);
});

test("reply is plain markdown; a partial reply ends with ▍", () => {
  assert.deepEqual(plain([{ id: "r", kind: "reply", text: "Done **now**" }]), ["Done **now**"]);
  assert.deepEqual(plain([{ id: "r", kind: "reply", text: "Writ", partial: true }]), ["Writ▍"]);
  const full = "x".repeat(W);
  assert.deepEqual(plain([{ id: "r", kind: "reply", text: full, partial: true }]), [full, "▍"]);
});

test("thinking is one row: a preview of its first line", () => {
  assert.deepEqual(render([{ id: "th", kind: "thinking", text: "long\nthoughts" }]), [
    "<dim>✻</dim> <i><thinkingText>long</thinkingText></i><dim> …</dim>",
  ]);
});

test("notice and compaction: one centred dim line", () => {
  const [notice] = render([{ id: "n", kind: "notice", text: "$ npm test · exit 1" }]);
  assert.match(notice!, /<dim>\$ npm test · exit 1<\/dim>/);
  const text = strip(notice!);
  const left = text.length - text.trimStart().length;
  assert.ok(Math.abs(left - (W - "$ npm test · exit 1".length) / 2) <= 1, `centred: ${JSON.stringify(text)}`);

  assert.deepEqual(plain([{ id: "c", ts: TS, kind: "compacted", text: "recap" }]).map((l) => l.trim()), ["Context compacted · 09:05"]);
  assert.deepEqual(plain([{ id: "c", kind: "compacted" }]).map((l) => l.trim()), ["Context compacted"]);
  assert.deepEqual(plain([{ id: "n", kind: "notice", text: "one\n\ntwo" }]).map((l) => l.trim()), ["one two"]);
});

test("single tool row: glyph per status, denied drawn differently from failed", () => {
  const row = (status: ChatToolStatus) => render([cmd(status)])[0]!;
  assert.match(row("running"), /^<accent>●<\/accent> /);
  assert.match(row("done"), /^<dim>✓<\/dim> /);
  assert.match(row("failed"), /^<error>✗<\/error> /);
  assert.match(row("denied"), /^<warning>⊘<\/warning> /);
  assert.notEqual(row("failed").slice(0, 20), row("denied").slice(0, 20));
  assert.equal(strip(row("done")), "✓ $ ls");
});

test("single tool row: verb + subject per kind, muted", () => {
  assert.match(render([edit("/home/me/x.ts")])[0]!, /<muted>Edited ~\/x\.ts<\/muted>/);
  assert.deepEqual(plain([tool({ kind: "read", path: "b.ts" })]), ["✓ Read b.ts"]);
  assert.deepEqual(plain([tool({ kind: "execute", command: "ls", description: "List files" })]), ["✓ List files"]);
  assert.deepEqual(plain([tool({ kind: "task", agent: "explore", summary: "map the repo" }, "running")]), ["● explore: map the repo"]);
});

test("two steps stay single rows; blank line between blocks", () => {
  assert.deepEqual(plain([cmd(), { id: "r", kind: "reply", text: "ok" }, edit()]), ["✓ $ ls", "", "ok", "", "✓ Edited a.ts"]);
});

test("folded run: summary row with failed badge and the indented last step", () => {
  const lines = render([cmd(), cmd("failed"), cmd(), edit(), edit("b.ts")]);
  assert.equal(lines.length, 2);
  assert.equal(strip(lines[0]!), "› 3 commands, 2 edits  [1 failed]");
  assert.match(lines[0]!, /<error>\[1 failed\]<\/error>/);
  assert.equal(strip(lines[1]!), "  ✓ Edited b.ts");
  assert.deepEqual(plain([cmd(), cmd(), cmd()]), ["› 3 commands", "  ✓ $ ls"]);
});

test("live run: 'N earlier steps' row then the last LIVE_TAIL steps", () => {
  const items: ChatItem[] = [];
  for (let i = 0; i < 8; i++) items.push(cmd("done", `c${i}`));
  items.push(cmd("running", "c8"));
  assert.deepEqual(plain(items), [
    "› 3 earlier steps · 3 commands",
    "  ✓ $ c3",
    "  ✓ $ c4",
    "  ✓ $ c5",
    "  ✓ $ c6",
    "  ✓ $ c7",
    "  ● $ c8",
  ]);
  // Nothing hidden: no "earlier" row.
  assert.deepEqual(plain([{ id: "th", kind: "thinking", text: "x" }, cmd(), cmd("running")]), ["  · x", "  ✓ $ ls", "  ● $ ls"]);
});

test("question: its text and every option, with descriptions", () => {
  const q = tool(
    {
      kind: "question",
      name: "ask_user_question",
      summary: "Which DB?",
      questions: [{ question: "Which DB?", multiple: false, options: [{ label: "Postgres", description: "relational" }, { label: "SQLite" }] }],
    },
    "running",
  );
  assert.deepEqual(renderOpen([q]), ["⌄ ● ❓ Question", "  Which DB?", "    ○ Postgres — relational", "    ○ SQLite"]);
  // Only the result's text, no per-question choice: the old "→" line.
  const answered = { ...q, status: "done", tool: { ...(q as { tool: ChatToolCall }).tool, output: "Postgres" } } as ChatItem;
  assert.deepEqual(renderOpen([answered]).at(-1), "  → Postgres");
});

test("question: the chosen options are marked in the list, in the success colour; no separate answer line", () => {
  const q = tool(
    {
      kind: "question",
      name: "ask_user_question",
      summary: "Areas?",
      questions: [
        { header: "Areas", question: "Which?", multiple: true, options: [{ label: "Caja" }, { label: "Inventario" }, { label: "Reportes" }] },
        { question: "Origin?", multiple: false, options: [{ label: "Quejas" }, { label: "Revisa" }] },
      ],
      output: "Inventario, Reportes · Quejas",
      chosen: [["Inventario", "Reportes"], ["Quejas"]],
    } as ChatToolCall,
    "done",
  );
  assert.deepEqual(renderOpen([q]), [
    "⌄ ✓ ❓ Question",
    "  Areas: Which?",
    "    □ Caja",
    "    ☑  Inventario",
    "    ☑  Reportes",
    "  Origin?",
    "    ○ Quejas".replace("○", "●"),
    "    ○ Revisa",
  ]);
  const raw = renderChat([q], W, deps, { now: NOW, expanded: () => true });
  assert.match(raw[3]!, /<success>☑  Inventario<\/success>/);
  assert.match(raw[2]!, /<muted>□<\/muted> <dim>Caja<\/dim>/);
});

test("question: an answer that is not one of the options (typed by the user) shows under its question", () => {
  const q = tool(
    {
      kind: "question",
      name: "ask_user_question",
      summary: "Size?",
      questions: [{ question: "Size?", multiple: false, options: [{ label: "S" }, { label: "M" }] }],
      output: "something else",
      chosen: [["something else"]],
    } as ChatToolCall,
    "done",
  );
  assert.deepEqual(renderOpen([q]), ["⌄ ✓ ❓ Question", "  Size?", "    ○ S", "    ○ M", "    → something else"]);
});

test("every line fits the width", () => {
  const long = "word ".repeat(60);
  const items: ChatItem[] = [
    { id: "u", ts: TS, kind: "user", text: long },
    { id: "r", kind: "reply", text: long, partial: true },
    { id: "n", kind: "notice", text: long },
    tool({ kind: "execute", command: long }),
    tool({ kind: "question", name: "ask", summary: long, questions: [{ question: long, multiple: true, options: [{ label: long, description: long }] }] }),
    cmd(), cmd("failed", long), edit(long),
  ];
  for (const width of [12, 30, 80]) {
    for (const line of render(items, width)) assert.ok(deps.visibleWidth(line) <= width, `${width}: ${JSON.stringify(strip(line))}`);
  }
});

test("empty chat renders nothing", () => {
  assert.deepEqual(render([]), []);
});

// --- Expansion ---

const rows = (items: ChatItem[], expanded: (key: string) => boolean = () => false, width = W) =>
  renderChatRows(items, width, deps, { now: NOW, expanded });
const thought = (id: string, text = "first idea\nsecond idea"): ChatItem => ({ id, kind: "thinking", text });

test("thinking collapsed: one '›' row that toggles its own key", () => {
  const r = rows([thought("th1")]);
  assert.deepEqual(r.lines.map(strip), ["✻ first idea …"]);
  assert.deepEqual(r.targets, [thinkingKey("th1")]);
});

test("thinking expanded: '⌄ first line' then the rest as thinkingText markdown, indented 2", () => {
  const r = rows([thought("th1")], (k) => k === thinkingKey("th1"));
  assert.deepEqual(r.lines.map(strip), ["✻ first idea", "  second idea"]);
  assert.match(r.lines[1]!, /<thinkingText>second idea<\/thinkingText>/);
  assert.deepEqual(r.targets, [thinkingKey("th1"), undefined]);
  for (const width of [8, 20]) for (const l of rows([thought("th1", "word ".repeat(30))], () => true, width).lines) assert.ok(deps.visibleWidth(l) <= width);
});

test("folded run: head toggles the run (keyed by its first item); expanded shows every step under '⌄'", () => {
  const items = [cmd("done", "a"), cmd("failed", "b"), cmd("done", "c"), edit("x.ts"), edit("y.ts")];
  const key = runKey(items[0]!.id);
  const closed = rows(items);
  assert.deepEqual(closed.targets, [key, undefined]);
  const open = rows(items, (k) => k === key);
  assert.deepEqual(open.lines.map(strip), [
    "⌄ 3 commands, 2 edits  [1 failed]",
    "  ✓ $ a",
    "  ✗ $ b",
    "  ✓ $ c",
    "  ✓ Edited x.ts",
    "  ✓ Edited y.ts",
  ]);
  // Each step of an open run is its own card toggle.
  assert.deepEqual(open.targets, [key, ...items.map((i) => cardKey(i.id))]);
});

test("live run: the 'earlier steps' row toggles; expanded shows every step, not just the tail", () => {
  const items: ChatItem[] = [];
  for (let i = 0; i < 8; i++) items.push(cmd("done", `c${i}`));
  items.push(cmd("running", "c8"));
  const key = runKey(items[0]!.id);
  assert.equal(rows(items).targets[0], key);
  const open = rows(items, (k) => k === key);
  assert.equal(strip(open.lines[0]!), "⌄ 9 commands");
  assert.deepEqual(open.lines.slice(1).map(strip), items.map((_, i) => `  ${i === 8 ? "●" : "✓"} $ c${i}`));
});

test("thinking inside a run is its own toggle, indented with the run", () => {
  const items = [thought("th9", "deep\nthought"), cmd(), cmd()];
  const key = runKey("th9");
  const open = rows(items, (k) => k === key || k === thinkingKey("th9"));
  assert.deepEqual(open.lines.map(strip), ["⌄ 2 commands", "  ✻ deep", "    thought", "  ✓ $ ls", "  ✓ $ ls"]);
  assert.deepEqual(open.targets.slice(0, 3), [key, thinkingKey("th9"), undefined]);
});

test("renderChat is renderChatRows' lines, everything collapsed", () => {
  const items = [thought("a"), { id: "r", kind: "reply", text: "ok" } as ChatItem, cmd(), cmd(), cmd()];
  assert.deepEqual(render(items), rows(items).lines);
});

// --- Tool cards ---

const card = (item: ChatItem, extra: string[] = [], width = W) => {
  const keys = new Set([cardKey(item.id), ...extra]);
  return rows([item], (k) => keys.has(k), width);
};
const toolWith = (t: ChatToolCall, status: ChatToolStatus = "done", id = `k${++n}`): ChatItem => ({ id, kind: "tool", tool: t, status });
/** A boxed card read back as its title then body rows, borders and padding dropped; "├" marks the separator. */
const boxed = (r: { lines: string[] }) =>
  r.lines.map(strip).flatMap((l) => {
    const t = l.trimStart();
    if (t.startsWith("╭ ")) return [t.slice(2).replace(/ ─*╮$/, "")];
    if (t.startsWith("├")) return ["├"];
    if (t.startsWith("╰")) return [];
    return t.startsWith("│ ") ? [t.slice(2, -2).trimEnd()] : [l];
  });

test("a single tool row toggles its card; closed it is today's one-line row", () => {
  const item = toolWith({ kind: "execute", command: "ls" }, "done", "c1");
  const r = rows([item]);
  assert.deepEqual(r.lines.map(strip), ["✓ $ ls"]);
  assert.deepEqual(r.targets, [cardKey("c1")]);
});

test("run card: label header, the whole command under '$ ', description, exit code", () => {
  const item = toolWith({ kind: "execute", command: "npm test \\\n  --watch", description: "Run tests", exitCode: 2 }, "failed", "c1");
  const r = card(item);
  assert.deepEqual(boxed(r), ["✗ Run · exit 2", "Run tests", "$ npm test \\", "    --watch"]);
  assert.match(r.lines[0]!, /<b>Run<\/b>/);
  assert.match(r.lines[2]!, /<accent>\$ npm test/);
  assert.deepEqual(r.targets, [cardKey("c1"), undefined, undefined, undefined, undefined]);
  // A long command wraps to the box instead of being cut.
  const long = card(toolWith({ kind: "execute", command: "x".repeat(50) }), [], 30);
  assert.deepEqual(boxed(long).slice(1), ["$ " + "x".repeat(24), "  " + "x".repeat(24), "  xx"]);
});

test("edit card: path, coloured diff, capped at 40 lines", () => {
  const diff = [{ op: "@", text: "@@ -1 +1 @@" }, { op: " ", text: "keep" }, { op: "-", text: "old" }, { op: "+", text: "new" }] as const;
  const r = card(toolWith({ kind: "edit", path: "/home/me/a.ts", diff: [...diff] }));
  assert.deepEqual(boxed(r), ["✓ Edit", "~/a.ts", "@@ -1 +1 @@", " keep", "-old", "+new"]);
  assert.match(r.lines[3]!, /<toolDiffContext> keep<\/toolDiffContext>/);
  assert.match(r.lines[4]!, /<toolDiffRemoved>-old<\/toolDiffRemoved>/);
  assert.match(r.lines[5]!, /<toolDiffAdded>\+new<\/toolDiffAdded>/);
  const big = card(toolWith({ kind: "edit", path: "a", diff: Array.from({ length: 45 }, (_, i) => ({ op: "+" as const, text: `l${i}` })) }));
  assert.equal(big.lines.length, 2 + 40 + 1 + 1);
  assert.equal(boxed(big).at(-1), "… 5 more lines");
  assert.equal(boxed(card(toolWith({ kind: "edit", path: "n.md", write: true, diff: [{ op: "+", text: "x" }] })))[0], "✓ Write");
});

test("cards per kind: read, search, fetch, task, delete, move, other", () => {
  const head = (t: ChatToolCall) => boxed(card(toolWith(t)));
  assert.deepEqual(head({ kind: "read", path: "a.ts", range: [10, 30] }), ["✓ Read", "a.ts · lines 10–30"]);
  assert.deepEqual(head({ kind: "read", path: "a.ts" }), ["✓ Read", "a.ts"]);
  assert.deepEqual(head({ kind: "search", query: "TODO", where: "src" }), ["✓ Search", "TODO · in src"]);
  assert.deepEqual(head({ kind: "fetch", url: "https://x.dev" }), ["✓ Fetch", "https://x.dev"]);
  assert.deepEqual(head({ kind: "task", agent: "explore", summary: "map the repo" }), ["✓ Agent", "explore: map the repo"]);
  assert.deepEqual(head({ kind: "delete", path: "a" }), ["✓ Delete", "a"]);
  assert.deepEqual(head({ kind: "move", path: "a", to: "b" }), ["✓ Move", "a → b"]);
  assert.deepEqual(head({ kind: "other", name: "mcp_x", summary: "do it" }), ["✓ mcp_x", "do it"]);
});

test("output row: '› Output · N lines' toggles; open shows dim text, capped at 200 lines", () => {
  const item = toolWith({ kind: "execute", command: "ls", output: "a\nb\nc" }, "done", "c1");
  const closed = card(item);
  assert.deepEqual(boxed(closed).slice(-1), ["› Output · 3 lines"]);
  assert.equal(closed.targets.at(-2), outputKey("c1"));
  const open = card(item, [outputKey("c1")]);
  assert.deepEqual(boxed(open).slice(-4), ["⌄ Output · 3 lines", "  a", "  b", "  c"]);
  assert.match(open.lines.at(-2)!, /<dim>c<\/dim>/);
  assert.equal(boxed(card(toolWith({ kind: "execute", command: "x", output: "one" }))).at(-1), "› Output · 1 line");

  // Capped at 200 lines once "Show all" is open.
  const many = Array.from({ length: 250 }, (_, i) => `o${i}`).join("\n");
  const capped = card(toolWith({ kind: "execute", command: "x", output: many }, "done", "c2"), [outputKey("c2"), outputAllKey("c2")]);
  assert.deepEqual(boxed(capped).slice(-2), ["  … 50 more lines", "⌄ Show fewer"]);
  // Cut by the model: the count is the whole output's.
  const cut = card(toolWith({ kind: "execute", command: "x", output: "a\nb", outputLines: 900 }, "done", "c3"), [outputKey("c3"), outputAllKey("c3")]);
  assert.deepEqual(boxed(cut).slice(-5), ["⌄ Output · 900 lines", "  a", "  b", "  … 898 more lines", "⌄ Show fewer"]);
});

test("a failed call's output row is closed and drawn in the error colour", () => {
  const r = card(toolWith({ kind: "edit", path: "a.ts", output: "Could not find oldText" }, "failed"));
  assert.match(r.lines.at(-2)!, /<error>› Output · 1 line<\/error>/);
  assert.match(card(toolWith({ kind: "execute", command: "ls", output: "x" })).lines.at(-2)!, /<dim>› Output · 1 line<\/dim>/);
});

test("in an open run, each step opens its own card, indented with the run", () => {
  const items = [toolWith({ kind: "execute", command: "a" }, "done", "s1"), toolWith({ kind: "execute", command: "b", output: "x" }, "done", "s2"), toolWith({ kind: "edit", path: "c" }, "done", "s3")];
  const keys = new Set([runKey("s1"), cardKey("s2")]);
  const r = rows(items, (k) => keys.has(k));
  assert.deepEqual(boxed(r), ["⌄ 2 commands, 1 edit", "  ✓ $ a", "✓ Run", "$ b", "├", "› Output · 1 line", "  ✓ Edited c"]);
  assert.match(strip(r.lines[2]!), /^ {2}╭ ✓ Run ─+╮$/);
  assert.deepEqual(r.targets, [runKey("s1"), cardKey("s1"), cardKey("s2"), undefined, undefined, outputKey("s2"), undefined, cardKey("s3")]);
  // A closed folded run's last step is a summary, not a card.
  assert.deepEqual(rows(items).targets, [runKey("s1"), undefined]);
});

test("toggle keys are told apart: runs are the ones ctrl+o opens", () => {
  assert.equal(isRunKey(runKey("a")), true);
  assert.equal(isRunKey(cardKey("a")), false);
  assert.equal(isRunKey(outputKey("a")), false);
  assert.equal(isRunKey(thinkingKey("a")), false);
});

test("cards fit the width", () => {
  const t = toolWith({ kind: "execute", command: "word ".repeat(40), description: "d ".repeat(40), output: "z".repeat(300) }, "done", "w1");
  for (const width of [10, 25]) {
    for (const l of card(t, [outputKey("w1")], width).lines) assert.ok(deps.visibleWidth(l) <= width, JSON.stringify(strip(l)));
  }
});

// --- Sticky user turn ---

test("turns: each line after a user box names that box's first line; box lines and earlier lines name none", () => {
  const r = rows([{ id: "r0", kind: "reply", text: "pre" }, { id: "u", kind: "user", text: "hi" }, { id: "r", kind: "reply", text: "ok" }]);
  assert.deepEqual(r.lines.map(strip).map((l) => l.trim()), ["pre", "", "─".repeat(W), "", "▎ You", "▎ hi", "", "ok"]);
  assert.deepEqual(r.turns, [undefined, undefined, undefined, undefined, undefined, undefined, 4, 4]);
  assert.deepEqual([...r.sticky!.keys()], [4]);
});

test("sticky row: '↑ You:' and the message, two text lines at most, cut with '…', then a rule", () => {
  const short = rows([{ id: "u", kind: "user", text: "first  question\nhere" }]).sticky!.get(0)!;
  assert.deepEqual(short(3).map(strip), ["↑ You: first question here".padEnd(W), "─".repeat(W)]);
  const long = rows([{ id: "u", kind: "user", text: "word ".repeat(30) }]).sticky!.get(0)!;
  const two = long(3).map(strip);
  assert.equal(two.length, 3);
  assert.match(two[1]!, /^ {7}word.*…\s*$/);
  for (const l of long(3)) assert.equal(deps.visibleWidth(l), W);
  const one = long(2).map(strip);
  assert.equal(one.length, 2);
  assert.match(one[0]!, /^↑ You: word.*…\s*$/);
});

// --- Image markers ---

test("image markers: step row, open card and user box; every line fits", () => {
  const one = toolWith({ kind: "read", path: "a.png", images: 1 }, "done", "i1");
  const three = toolWith({ kind: "execute", command: "shot", images: 3 }, "done", "i3");
  assert.deepEqual(rows([one]).lines.map(strip), ["✓ Read a.png · 🖼️ image"]);
  assert.match(rows([one]).lines[0]!, /<dim> · 🖼️ image<\/dim>/);
  assert.deepEqual(rows([three]).lines.map(strip), ["✓ $ shot · 🖼️ 3 images"]);
  // The note wraps inside the box at this width; read it back as one text.
  const said = (c: ChatItem) => boxed(card(c)).slice(1).join(" ");
  assert.match(said(one), /🖼️ image — alt\+c shows it in Terminal/);
  assert.match(said(three), /🖼️ 3 images — alt\+c shows them in Terminal/);
  assert.match(card(one).lines.find((l) => l.includes("🖼️"))!, /<dim>🖼️ image —/);
  const u = (text: string, images: number) => rows([{ id: "u", kind: "user", text, images } as ChatItem]).lines.map(strip).map((l) => l.trimEnd());
  assert.deepEqual(u("look", 1), ["▎ You", "▎ look", "▎ 🖼️ image attached"]);
  assert.deepEqual(u("", 2), ["▎ You", "▎ 🖼️ 2 images attached"]);
  for (const width of [8, 20]) {
    const items = [one, three, { id: "u", kind: "user", text: "look at this", images: 2 } as ChatItem];
    for (const l of rows(items, (k) => k.startsWith("tool:"), width).lines) assert.ok(deps.visibleWidth(l) <= width, JSON.stringify(strip(l)));
    for (const l of rows(items, () => false, width).lines) assert.ok(deps.visibleWidth(l) <= width);
  }
});

test("image markers: the pinned row of an image-only turn names the images", () => {
  const sticky = rows([{ id: "u", kind: "user", text: "", images: 1 } as ChatItem]).sticky!.get(0)!;
  assert.equal(strip(sticky(2)[0]!).trimEnd(), "↑ You: 🖼️ image attached");
});

test("a notice that fits stays one centred dim line, with nothing to open", () => {
  const r = rows([{ id: "n1", kind: "notice", text: "short note" }], () => false, 40);
  assert.equal(strip(r.lines[0]!).trim(), "short note");
  assert.deepEqual(r.targets, [undefined]);
});

test("a long notice (a background job's report) previews on one row and opens to its whole text", () => {
  const text = "Background job job-4 (\"redeploy backend rename\") exited with code 0 after 1m 7s. Command: cd /home/x && docker build --platform linux/amd64 .\nlast line";
  const key = noticeKey("n2");
  const closed = rows([{ id: "n2", kind: "notice", text }], () => false, 40);
  assert.equal(closed.lines.length, 1);
  assert.match(strip(closed.lines[0]!), /^› Background job job-4/);
  assert.match(strip(closed.lines[0]!), /…$/);
  assert.deepEqual(closed.targets, [key]);
  const opened = rows([{ id: "n2", kind: "notice", text }], (k) => k === key, 40);
  assert.match(strip(opened.lines[0]!), /^⌄ Background job job-4/);
  const body = opened.lines.map(strip).join(" ");
  assert.equal(body.split("Background job").length, 2, "the text is drawn once");
  assert.match(body, /docker build --platform linux\/amd64/);
  assert.match(body, /last line/);
  assert.equal(opened.targets[0], key);
  for (const l of opened.lines) assert.ok(deps.visibleWidth(l) <= 40);
});

// --- Engram ---

test("Engram rows: 🧠 and a verb instead of the tool name; glyph coloured, row muted; card label 'Engram'", () => {
  const mem = (engram: { action: string; subject: string }, status: ChatToolStatus = "done", id = "m1") =>
    toolWith({ kind: "other", name: "mcp__engram__mem_save", summary: "x", badge: { glyph: "🧠", ...engram, label: "Engram" } }, status, id);
  assert.deepEqual(plain([mem({ action: "saved", subject: "Fixed the bug" })]), ["✓ 🧠 saved Fixed the bug"]);
  assert.equal(render([mem({ action: "saved", subject: "T" }, "failed")])[0], "<error>✗</error> <muted>🧠 saved T</muted>");
  assert.deepEqual(plain([mem({ action: "context", subject: "" })]), ["✓ 🧠 context"]);
  // An open badge card is titled like its row.
  assert.equal(boxed(card(mem({ action: "read", subject: "#42" }, "done", "m2")))[0], "✓ 🧠 read");
  for (const width of [6, 12, 30]) {
    for (const l of rows([mem({ action: "searched", subject: "word ".repeat(20) })], () => false, width).lines) {
      assert.ok(deps.visibleWidth(l) <= width, JSON.stringify(strip(l)));
    }
  }
});

test("an RDD step reads '🌹 rdd inspect', glyph coloured, row muted", () => {
  const item: ChatItem = { id: "g1", kind: "tool", status: "done", tool: { kind: "other", name: "gentle_review", summary: "", badge: { glyph: "🌹", action: "rdd inspect", subject: "", label: "RDD" } } as ChatToolCall };
  const r = rows([item]);
  assert.match(strip(r.lines[0]!), /^✓ 🌹 rdd inspect\s*$/);
});

test("an answered question folds to one row with its answers; a click opens it; a pending one stays open", () => {
  const call = {
    kind: "question",
    name: "ask_user_question",
    summary: "Areas?",
    questions: [
      { question: "Which?", multiple: true, options: [{ label: "Caja" }, { label: "Inventario" }, { label: "Reportes" }] },
      { question: "Origin?", multiple: false, options: [{ label: "Quejas" }, { label: "Revisa" }] },
    ],
  } as ChatToolCall;
  const answered = tool({ ...call, output: "Inventario, Reportes · Quejas", chosen: [["Inventario", "Reportes"], ["Quejas"]] } as ChatToolCall, "done");
  const closed = rows([answered], () => false, 80);
  assert.deepEqual(closed.lines.map(strip), ["› ✓ ❓ Question · Inventario, Reportes · Quejas"]);
  assert.deepEqual(closed.targets, [cardKey(answered.id)]);
  assert.match(closed.lines[0]!, /<success>Inventario, Reportes · Quejas<\/success>/);
  const opened = rows([answered], (k) => k === cardKey(answered.id));
  assert.equal(strip(opened.lines[0]!), "⌄ ✓ ❓ Question");
  assert.equal(opened.targets[0], cardKey(answered.id));
  assert.ok(opened.lines.length > 5);
  // Waiting for the person: Gentle's dialog below shows the options, so the card folds to one row; a click opens it.
  const waiting = tool(call, "running");
  const pending = rows([waiting], () => false, 80);
  assert.deepEqual(pending.lines.map(strip), ["› ● ❓ Question · waiting for your answer below"]);
  assert.deepEqual(pending.targets, [cardKey(waiting.id)]);
  const pendingOpen = rows([waiting], (k) => k === cardKey(waiting.id), 80);
  assert.equal(strip(pendingOpen.lines[0]!), "⌄ ● ❓ Question");
  assert.ok(pendingOpen.lines.length > 5);
  for (const width of [10, 30]) for (const l of rows([answered], () => false, width).lines) assert.ok(deps.visibleWidth(l) <= width);
});

test("a failed question (never asked) folds to one red row with why; a click opens it", () => {
  const call = {
    kind: "question",
    name: "ask_user_question",
    summary: "Areas?",
    questions: [{ question: "Which?", multiple: false, options: [{ label: "A" }, { label: "B" }] }],
    failure: "Validation failed for tool \"ask_user_question\":",
  } as ChatToolCall;
  const failed = tool(call, "failed");
  const closed = rows([failed], () => false, 100);
  assert.deepEqual(closed.lines.map(strip), ['› ✗ ❓ Question · Validation failed for tool "ask_user_question":']);
  assert.deepEqual(closed.targets, [cardKey(failed.id)]);
  assert.match(closed.lines[0]!, /<error>Validation failed/);
  const opened = rows([failed], (k) => k === cardKey(failed.id), 100);
  assert.equal(strip(opened.lines[0]!), "⌄ ✗ ❓ Question");
  assert.ok(opened.lines.some((l) => strip(l).includes("○ A")));
  // Without a recorded reason it still folds, saying it was not asked.
  const bare = tool({ ...call, failure: undefined } as ChatToolCall, "failed");
  assert.deepEqual(rows([bare], () => false, 100).lines.map(strip), ["› ✗ ❓ Question · not asked"]);
});
