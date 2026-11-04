// Run durations and code blocks in replies. (Replies are never folded.)

import { test } from "node:test";
import assert from "node:assert/strict";

import { itemsFromEntries, type ChatItem, type ChatToolStatus, type SessionEntryLike } from "../src/model/items.ts";
import { formatDuration, renderChatRows, runKey, splitFences, type RenderDeps } from "../src/view/render.ts";
import { deps, strip } from "./fake-deps.ts";

const W = 30;
const rows = (items: ChatItem[], open: string[] = [], o: { width?: number; now?: Date; d?: RenderDeps } = {}) => {
  const keys = new Set(open);
  return renderChatRows(items, o.width ?? W, o.d ?? deps, { expanded: (k) => keys.has(k), now: o.now });
};
const plain = (r: { lines: string[] }) => r.lines.map(strip).map((l) => l.trimEnd());
const reply = (n: number, partial = false): ChatItem =>
  ({ id: "r", kind: "reply", text: Array.from({ length: n }, (_, i) => `l${i}`).join("\n"), ...(partial ? { partial: true } : {}) }) as ChatItem;

// --- Replies are never folded (user: "ya q es respuesta") ---

test("a long finished reply shows whole, with nothing to open", () => {
  const r = rows([reply(60)]);
  assert.equal(r.lines.length, 60);
  assert.equal(plain(r).at(-1), "l59");
  assert.ok(!plain(r).some((l) => /Show \d+ more lines|Show fewer/.test(l)));
  assert.ok(r.targets.every((t) => t === undefined));
});

test("a streaming reply never folds", () => {
  const r = rows([reply(40, true)]);
  assert.equal(r.lines.length, 40);
  assert.equal(plain(r).at(-1), "l39▍");
  assert.ok(r.targets.every((t) => t === undefined));
});

// --- Run duration ---

test("formatDuration: under a second hidden, then s, m s, h m", () => {
  const cases: [number, string | undefined][] = [
    [0, undefined], [999, undefined], [1000, "1s"], [12_400, "12s"], [59_999, "59s"],
    [60_000, "1m"], [252_000, "4m 12s"], [3_599_000, "59m 59s"], [3_600_000, "1h"], [3_780_000, "1h 3m"], [-5, undefined],
  ];
  for (const [ms, want] of cases) assert.equal(formatDuration(ms), want, String(ms));
});

const at = (s: number) => new Date(Date.UTC(2026, 9, 28, 10, 0, s)).toISOString();
const step = (id: string, start: number | undefined, end: number | undefined, status: ChatToolStatus = "done"): ChatItem =>
  ({ id, kind: "tool", status, tool: { kind: "execute", command: id }, ...(start === undefined ? {} : { ts: at(start) }), ...(end === undefined ? {} : { end: at(end) }) }) as ChatItem;

test("a folded run reads its span from the earliest start to the latest end, before the failed badge", () => {
  const items = [step("a", 0, 5), step("b", 10, 200, "failed"), step("c", 20, 252)];
  const wide = { width: 50 };
  assert.equal(plain(rows(items, [], wide))[0], "› 3 commands · 4m 12s  [1 failed]");
  assert.equal(plain(rows(items, [runKey("a")], wide))[0], "⌄ 3 commands · 4m 12s  [1 failed]");
  assert.match(rows(items, [], wide).lines[0]!, /<dim> · 4m 12s<\/dim>/);
});

test("a live run counts to now; its 'earlier steps' row carries it", () => {
  const items = [...Array.from({ length: 7 }, (_, i) => step(`s${i}`, i, i + 1)), step("s7", 8, undefined, "running")];
  const now = new Date(Date.UTC(2026, 9, 28, 10, 1, 30));
  assert.equal(plain(rows(items, [], { now, width: 50 }))[0], "› 2 earlier steps · 2 commands · 1m 30s");
  assert.equal(plain(rows(items, [runKey("s0")], { now, width: 50 }))[0], "⌄ 8 commands · 1m 30s");
  assert.equal(plain(rows(items, [], { width: 50 }))[0], "› 2 earlier steps · 2 commands", "no clock: no live time");
});

test("missing timestamps omit the duration", () => {
  assert.equal(plain(rows([step("a", undefined, undefined), step("b", undefined, undefined), step("c", undefined, undefined)]))[0], "› 3 commands");
  assert.equal(plain(rows([step("a", 0, undefined), step("b", 1, undefined), step("c", 2, undefined)]))[0], "› 3 commands");
  assert.equal(plain(rows([step("a", 0, 0), step("b", 0, 0), step("c", 0, 0)]))[0], "› 3 commands", "under a second");
});

test("the model records a tool's end from its result's timestamp", () => {
  const e = (id: string, ts: string, message: Record<string, unknown>): SessionEntryLike => ({ type: "message", id, timestamp: ts, message });
  const items = itemsFromEntries([
    e("a1", at(0), { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } }], timestamp: 1 }),
    e("r1", at(42), { role: "toolResult", toolCallId: "c1", content: [{ type: "text", text: "" }], isError: false }),
  ]);
  const t = items[0] as Extract<ChatItem, { kind: "tool" }>;
  assert.deepEqual([t.ts, t.end], [at(0), at(42)]);
});

// --- Code blocks ---

test("splitFences: ``` and ~~~ blocks with an optional language; an unterminated fence stays prose", () => {
  const text = "intro\n```ts\nconst a = 1;\n```\nmid\n~~~\nraw\n  x\n~~~\nend\n```py\nopen";
  assert.deepEqual(splitFences(text), [
    { prose: "intro" },
    { code: "const a = 1;", lang: "ts" },
    { prose: "mid" },
    { code: "raw\n  x", lang: "" },
    { prose: "end\n```py\nopen" },
  ]);
  assert.deepEqual(splitFences("no code"), [{ prose: "no code" }]);
  assert.deepEqual(splitFences("````md\n```\ninner\n```\n````"), [{ code: "```\ninner\n```", lang: "md" }]);
});

test("a code block is its own full-width block on the code background, with a dim language label", () => {
  const r = rows([{ id: "r", kind: "reply", text: "Look:\n```ts\nconst a = 1;\n  b();\n```\nDone." }]);
  assert.deepEqual(plain(r), ["Look:", "", " ts", " const a = 1;", "   b();", "", "Done."]);
  for (const l of r.lines.slice(2, 5)) {
    assert.match(l, /^<customMessageBg>.*<\/customMessageBg>$/);
    assert.equal(deps.visibleWidth(l), W);
  }
  assert.match(r.lines[2]!, /<dim>ts<\/dim>/);
  // No language: no label row.
  assert.deepEqual(plain(rows([{ id: "r", kind: "reply", text: "~~~\nx\n~~~" }])), [" x"]);
});

test("code goes through the code dep when there is one; it falls back to plain lines when it throws", () => {
  const seen: [string, string][] = [];
  const d: RenderDeps = { ...deps, code: (code, lang) => (seen.push([code, lang]), code.split("\n").map((l) => `<hl>${l}</hl>`)) };
  const r = rows([{ id: "r", kind: "reply", text: "```js\nx()\n```" }], [], { d });
  assert.deepEqual(seen, [["x()", "js"]]);
  assert.match(r.lines[1]!, /<hl>x\(\)<\/hl>/);
  const bad: RenderDeps = { ...deps, code: () => { throw new Error("no"); } };
  assert.deepEqual(plain(rows([{ id: "r", kind: "reply", text: "```js\nx()\n```" }], [], { d: bad })), [" js", " x()"]);
});

test("long code lines wrap, nothing past the width", () => {
  const text = `\`\`\`sh\n${"word ".repeat(20)}\n\`\`\``;
  for (const width of [8, 20, 30]) {
    const r = rows([{ id: "r", kind: "reply", text }], [], { width });
    assert.ok(r.lines.length > 2, String(width));
    for (const l of r.lines) assert.equal(deps.visibleWidth(l), width, JSON.stringify(strip(l)));
    assert.equal(plain(r).slice(1).join(" ").replace(/\s+/g, " ").trim(), "word ".repeat(20).trim());
  }
});

test("a long code block in a reply shows whole too", () => {
  const text = `\`\`\`\n${Array.from({ length: 30 }, (_, i) => `c${i}`).join("\n")}\n\`\`\``;
  const r = rows([{ id: "r", kind: "reply", text }]);
  assert.equal(r.lines.length, 30);
  assert.ok(!plain(r).some((l) => /Show \d+ more lines/.test(l)));
});
