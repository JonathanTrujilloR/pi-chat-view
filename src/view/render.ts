// Chat items as terminal lines, drawn like Collie's chat cards (web/src/components/chat-cards.tsx, MIT).
//
// Pure: Pi's theme and pi-tui's text helpers come in as `RenderDeps`, so the look is testable with
// plain-text stand-ins and this file never imports Pi.

import type { ChatItem, ChatToolStatus } from "../model/items.ts";
import { earlierLabel, failedLabel, groupRuns, isLive, LIVE_TAIL, runSummary, shortPath, standsAlone, stepLine } from "../model/group.ts";

export interface RenderDeps {
  /** Markdown rendered to lines no wider than `width`. */
  markdown(text: string, width: number): string[];
  /** Theme foreground / background by Pi theme token (`dim`, `accent`, `userMessageBg`, ...). */
  fg(token: string, text: string): string;
  bg(token: string, text: string): string;
  bold(text: string): string;
  /** Italic, for the thinking preview row. Default: unstyled. */
  italic?(text: string): string;
  visibleWidth(text: string): number;
  truncate(text: string, width: number): string;
  /** Word-wrap to lines no wider than `width`. */
  wrap(text: string, width: number): string[];
  /**
   * An image as terminal rows (Kitty: the sequence on the first row, the rest empty), at most
   * `maxWidthCells` wide in a space `width` columns wide. Undefined or empty: it cannot be drawn
   * here, and the image marker stands in for it.
   */
  image?(data: string, mimeType: string, maxWidthCells: number, width: number): string[] | undefined;
  /** Code highlighted for `lang` (may be ""), one string per source line. Default: the plain lines. */
  code?(code: string, lang: string, width: number): string[];
  /** Thinking text as Pi draws it (italic `thinkingText` Markdown). Default: Markdown in `thinkingText`. */
  thinking?(text: string, width: number): string[];
}

export interface RenderOptions {
  /** Today, for the user label: a turn from another day also shows its date. */
  now?: Date;
  /** Whether a toggle (see {@link thinkingKey}, {@link runKey}) is open. Default: all closed. */
  expanded?: (key: string) => boolean;
  /** Rows of groups already drawn, reused while their items, width and toggles are the same. */
  cache?: RowsCache;
  /**
   * Changes whenever any toggle changes (ChatView's counter). While it stays the same, the rows of
   * the last render are kept up to the first item that changed and only the rest is redrawn; the
   * returned `ChatRows` is then the previous one, updated in place.
   */
  expansionVersion?: number;
}

/** The last render, kept so the next one can start where the items first differ. */
interface LastRender {
  items: readonly ChatItem[];
  out: ChatRows;
  day: string | undefined;
  expansionVersion: number;
  /** Per group: its first item's index, its first line (before the blank row above it), the box before it. */
  firstItem: number[];
  lineStart: number[];
  boxBefore: (number | undefined)[];
  /** Per group: its pinned-row key and image keys in `out`, to drop when the group goes. */
  keys: { sticky?: number; images: number[] }[];
  /** First item of the earliest live run: redrawn every time, its clock moves. */
  volatileFrom: number;
  /** The box the last line belongs to. */
  boxEnd: number | undefined;
}

/** One group's drawn rows, and what they were drawn from. */
interface GroupRows {
  items: readonly ChatItem[];
  /** Every toggle the group asked about, and the answer it got. */
  consulted: [string, boolean][];
  /** The day `now` was on: a turn's label carries its date when it is from another day. */
  day: string | undefined;
  lines: string[];
  targets: (string | undefined)[];
  /** Images by line, relative to the group's first line. */
  images: [number, ImageSpan][];
  /** Per line: drawn in the chat's own frame (see `Row.framed`). */
  framed: boolean[];
}

/**
 * Drawn groups, keyed by their first item's id, for one width. Items are never changed in place
 * (see `createItemsBuilder`), so the same item objects mean the same content: a live rebuild draws
 * only the groups that changed, the newest turn. Bounded: past `max` groups the oldest go.
 */
export interface RowsCache {
  width: number;
  groups: Map<string, GroupRows>;
  max: number;
  /** Groups drawn and reused by the last render (for tests and the bench). */
  drawn: number;
  reused: number;
  /** Items the last render kept without looking at them (for tests and the bench). */
  kept: number;
  last?: LastRender;
  clear(): void;
}

export function createRowsCache(max = 20_000): RowsCache {
  const cache: RowsCache = {
    width: -1,
    groups: new Map(),
    max,
    drawn: 0,
    reused: 0,
    kept: 0,
    clear() {
      cache.groups.clear();
      cache.last = undefined;
    },
  };
  return cache;
}

/** Chat lines plus, per line, the toggle a click on it flips (`undefined`: nothing to flip). */
export interface ChatRows {
  lines: string[];
  targets: (string | undefined)[];
  /**
   * Per line, the first line of the user box whose turn it follows: `undefined` on box lines and
   * before the first user turn. The view pins that message while its box is scrolled out of sight.
   */
  turns?: (number | undefined)[];
  /** The pinned row(s) of each user box, by its first line: at most `rows` lines, full width. */
  sticky?: Map<number, (rows: number) => string[]>;
  /**
   * Every drawn image by its first line: how many lines it takes, and what to show instead when
   * the window would cut it (the image marker, padded to `rows` lines). The view swaps it in.
   */
  images?: Map<number, ImageSpan>;
  /**
   * Per line: true when the chat drew a frame around it (a card's "│ … │", the user box's "▎"). Copying
   * drops only that frame, so a table in a reply keeps its own borders.
   */
  framed?: boolean[];
}

export interface ImageSpan {
  rows: number;
  fallback: string[];
}

/** What starts a pinned user row; continuation lines line up under the message. */
const STICKY_LABEL = "↑ You:";
/** Text rows of the pinned message at most; the rule under them is one more. */
const STICKY_TEXT_ROWS = 2;
/** The bar every row of a user box starts with, in the user colour (Gentle's float input style). */
const USER_BAR = "▎";

/** The toggle of one thinking block. Item ids are stable across rebuilds, so expansion survives them. */
export const thinkingKey = (id: string) => `thinking:${id}`;
/** The toggle of a run of steps, keyed by its first item, which stays first as the run grows. */
export const runKey = (firstId: string) => `run:${firstId}`;
export const isThinkingKey = (key: string) => key.startsWith("thinking:");

/** A rule (between blank rows) before every user box but the first block, so turns stand apart. False reverts to one blank row. */
export const TURN_RULE = true;
/** Labelled notices draw their glyph and name in the accent colour. False reverts to all dim. */
export const COLOR_TITLES = true;

/** The glyph of a thinking row, closed or open; runs keep "›" / "⌄". */
const THINKING_GLYPH = "✻";
/** The background code blocks sit on: a theme's tinted message panel. */
const CODE_BG = "customMessageBg";

/** A run's span as people say it: "12s", "4m 12s", "1h 3m"; under a second (or unknown) is nothing. */
export function formatDuration(ms: number): string | undefined {
  if (!Number.isFinite(ms) || ms < 1000) return undefined;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return s % 60 === 0 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 60)}m ${s % 60}s`;
  const m = Math.floor((s % 3600) / 60);
  return m === 0 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 3600)}h ${m}m`;
}

/** A reply's text in prose and fenced code segments. */
export type Segment = { prose: string } | { code: string; lang: string };

/**
 * Split on fenced code blocks (``` or ~~~, three or more, an optional language). A block closes on a
 * fence of the same character at least as long; one that never closes is left as prose, as written.
 */
export function splitFences(text: string): Segment[] {
  const lines = text.split("\n");
  const out: Segment[] = [];
  let prose: string[] = [];
  const flush = () => {
    const p = prose.join("\n").replace(/^\n+|\s+$/g, "");
    if (p !== "") out.push({ prose: p });
    prose = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const open = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)[^`]*$/.exec(lines[i]!);
    if (open === null) {
      prose.push(lines[i]!);
      continue;
    }
    const fence = open[1]!;
    const close = lines.findIndex((l, j) => j > i && new RegExp(`^ {0,3}${fence[0] === "`" ? "`" : "~"}{${fence.length},}\\s*$`).test(l));
    if (close < 0) {
      prose.push(...lines.slice(i));
      break;
    }
    flush();
    out.push({ code: lines.slice(i + 1, close).join("\n"), lang: open[2] ?? "" });
    i = close;
  }
  flush();
  return out;
}
/** Runs are what ctrl+o opens; cards and output rows open one at a time, as in Collie. */
export const isRunKey = (key: string) => key.startsWith("run:");
/** The toggle of a notice too long for one row (a background job's report, a long machine note). */
export const noticeKey = (id: string) => `notice:${id}`;
/** The toggle of one tool call's card, keyed by its call id. */
export const cardKey = (id: string) => `tool:${id}`;
/** The toggle of a card's output, under the card. */
export const outputKey = (id: string) => `tool:${id}:output`;
/** The "Show all N lines" toggle under an open output's preview. */
export const outputAllKey = (id: string) => `tool:${id}:output:all`;

/** Output lines an open output row shows before "› Show all N lines". */
export const OUTPUT_PREVIEW_ROWS = 10;

/** Diff lines an edit card shows before "… N more lines". */
export const MAX_DIFF_ROWS = 40;
/** Output lines an open output row shows before "… N more lines". */
export const MAX_OUTPUT_ROWS = 200;

/** Diff colours by op, Pi's tool diff tokens. */
const DIFF_TOKENS: Record<string, string> = { "+": "toolDiffAdded", "-": "toolDiffRemoved", " ": "toolDiffContext", "@": "dim" };

interface Row {
  line: string;
  target?: string;
  /** Set on an image's first row. */
  image?: ImageSpan;
  /** A row of the chat's own frame (a card's "│ … │", the user box's "▎"): copying drops that frame. */
  framed?: true;
}

/** Widest an attached image is drawn in the user box, and a tool's result image in its card. */
export const USER_IMAGE_CELLS = 30;
export const CARD_IMAGE_CELLS = 60;

/** Drawn at the end of a reply still streaming. */
export const CURSOR = "▍";

type ToolItem = Extract<ChatItem, { kind: "tool" }>;

/** Status glyph and its token. Denied is a "no", not an error, so it gets its own glyph and colour. */
const GLYPHS: Record<ChatToolStatus, [string, string]> = {
  running: ["●", "accent"],
  done: ["✓", "dim"],
  failed: ["✗", "error"],
  denied: ["⊘", "warning"],
};

const pad2 = (n: number) => String(n).padStart(2, "0");

/** "hh:mm", with the date in front when the turn is not from `now`'s day. */
function clock(ts: string | undefined, now: Date | undefined): string | undefined {
  if (ts === undefined) return undefined;
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return undefined;
  const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  if (now === undefined || d.toDateString() === now.toDateString()) return time;
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${time}`;
}

const collapse = (text: string) => text.replace(/\s+/g, " ").trim();

/**
 * "🖼️ image" / "🖼️ 3 images". The emoji carries VS16 so pi-tui measures it as two columns: a
 * terminal that draws it narrower leaves a column blank rather than pushing the row past its edge.
 */
export function imagesLabel(n: number): string {
  return n === 1 ? "🖼️ image" : `🖼️ ${n} images`;
}

/** One line of Markdown as plain words: no heading, quote or list marker, no emphasis, links as their text. */
function plainLine(line: string): string {
  return collapse(
    line
      .replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)+/, "")
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/(\*\*|__|`)/g, "")
      .replace(/(^|[^\w*])[*_](?=\S)([^*_]*?\S)[*_](?=[^\w*]|$)/g, "$1$2"),
  );
}

/** A thought's first non-empty line (as plain words) and the text after that line. */
function splitThought(text: string): { first: string; rest: string } {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => plainLine(l) !== "");
  if (at < 0) return { first: "", rest: "" };
  return { first: plainLine(lines[at]!), rest: lines.slice(at + 1).join("\n").trim() };
}

export function renderChat(items: readonly ChatItem[], width: number, deps: RenderDeps, opts: RenderOptions = {}): string[] {
  return renderChatRows(items, width, deps, opts).lines;
}

export function renderChatRows(items: readonly ChatItem[], width: number, deps: RenderDeps, opts: RenderOptions = {}): ChatRows {
  const { fg, bg, truncate, visibleWidth } = deps;
  const ask = opts.expanded ?? (() => false);
  // What the group being drawn asked: its cached rows hold while the answers stay the same.
  let consulted: [string, boolean][] = [];
  let volatile = false;
  const open = (key: string) => {
    const v = ask(key);
    consulted.push([key, v]);
    return v;
  };
  const plain = (lines: string[]): Row[] => lines.map((line) => ({ line }));
  const w = Math.max(1, width);
  const fit = (line: string) => (visibleWidth(line) > w ? truncate(line, w) : line);
  const padTo = (line: string) => {
    const fitted = fit(line);
    return fitted + " ".repeat(Math.max(0, w - visibleWidth(fitted)));
  };
  const centre = (text: string) => {
    const fitted = fit(text);
    return " ".repeat(Math.floor((w - visibleWidth(fitted)) / 2)) + fitted;
  };

  /** An image's rows from the `image` dep, or undefined when it cannot be drawn or would not fit `room`. */
  const drawImage = (img: { data: string; mimeType: string }, maxCells: number, room: number): string[] | undefined => {
    if (deps.image === undefined) return undefined;
    try {
      const rows = deps.image(img.data, img.mimeType, Math.max(1, Math.min(maxCells, room)), room);
      if (!Array.isArray(rows) || rows.length === 0 || rows.some((r) => typeof r !== "string" || visibleWidth(r) > room)) return undefined;
      return rows;
    } catch {
      return undefined;
    }
  };

  /**
   * Draw what can be drawn of `data`; `marker(n)` the lines that stand for n images. Each drawn image
   * carries its marker as the fallback, padded with `blank` to its own height; the images that could
   * not be drawn (or have no data) share one marker at the end.
   */
  const imageRows = (
    data: readonly { data: string; mimeType: string }[] | undefined,
    count: number,
    maxCells: number,
    room: number,
    wrapRow: (row: string) => string,
    marker: (n: number) => string[],
  ): Row[] => {
    const rows: Row[] = [];
    let drawn = 0;
    for (const img of data ?? []) {
      const lines = drawImage(img, maxCells, room);
      if (lines === undefined) continue;
      drawn++;
      const fallback = marker(1).slice(0, lines.length);
      while (fallback.length < lines.length) fallback.push(wrapRow(""));
      lines.forEach((l, i) => rows.push(i === 0 ? { line: wrapRow(l), image: { rows: lines.length, fallback } } : { line: wrapRow(l) }));
    }
    if (count - drawn > 0) rows.push(...marker(count - drawn).map((line) => ({ line })));
    return rows;
  };

  const userTurn = (item: Extract<ChatItem, { kind: "user" }>): Row[] => {
    const time = clock(item.ts, opts.now);
    const label = time === undefined ? "You" : `You · ${time}`;
    // "▎ " on every row, the box's tint to the edge; content keeps two columns clear on the right.
    const boxed = (l: string) => bg("userMessageBg", padTo(`${fg("warning", USER_BAR)} ${l}`));
    const room = Math.max(1, w - 4);
    const body = item.text === "" ? [] : deps.wrap(item.text, room).map((l) => fg("userMessageText", l));
    const rows: Row[] = [fg("warning", label), ...body].map((l) => ({ line: boxed(l) }));
    if (item.images) {
      const marker = (n: number) => [boxed(fg("muted", `${imagesLabel(n)} attached`))];
      rows.push(...imageRows(item.imageData, item.images, USER_IMAGE_CELLS, room, boxed, marker));
    }
    return rows;
  };

  /**
   * The message pinned while its box is above the window: "↑ You: text" in dim, cut with "…", then
   * a rule. Plainly not a box, so it never reads as a new message. `rows` counts the rule.
   */
  const stickyOf = (text: string) => (rows: number): string[] => {
    const lead = `${STICKY_LABEL} `;
    const room = Math.max(1, w - lead.length);
    const wrapped = deps.wrap(collapse(text), room);
    const shown = wrapped.slice(0, Math.max(1, Math.min(STICKY_TEXT_ROWS, rows - 1)));
    if (wrapped.length > shown.length) {
      const last = shown[shown.length - 1]!.replace(/ +$/, "");
      shown[shown.length - 1] = `${visibleWidth(last) + 1 <= room ? last : truncate(last, room - 1)}…`;
    }
    const lines = shown.map((l, i) => padTo(fg("dim", `${i === 0 ? lead : " ".repeat(lead.length)}${l}`)));
    return [...lines, fg("borderMuted", "─".repeat(w))];
  };

  /** A fenced block on its own background, full width: a dim language row, then the code, wrapped. */
  const codeBlock = (code: string, lang: string): string[] => {
    const room = Math.max(1, w - 2);
    let src: string[];
    try {
      src = deps.code?.(code, lang, room) ?? code.split("\n");
    } catch {
      src = code.split("\n");
    }
    // Lines that fit keep their indentation; only longer ones go through the wrapper.
    const body = src.flatMap((l) => (visibleWidth(l) <= room ? [l] : deps.wrap(l, room)));
    const rows = lang === "" ? body : [fg("dim", lang), ...body];
    return rows.map((l) => bg(CODE_BG, padTo(` ${l}`)));
  };

  /** Rendered rows of one reply text: prose as Markdown, code blocks as blocks, a blank row between. */
  const replyLines = (text: string): string[] => {
    const out: string[] = [];
    for (const seg of splitFences(text)) {
      const lines = "code" in seg ? codeBlock(seg.code, seg.lang) : deps.markdown(seg.prose, w);
      while (lines.length > 0 && visibleWidth(lines[0]!.trim()) === 0) lines.shift();
      while (lines.length > 0 && visibleWidth(lines.at(-1)!.trim()) === 0) lines.pop();
      if (lines.length === 0) continue;
      if (out.length > 0) out.push("");
      out.push(...lines);
    }
    return out;
  };

  /** A reply, always whole: it is what the reader came for, so it never folds (thinking does). */
  const reply = (item: Extract<ChatItem, { kind: "reply" }>): Row[] => {
    const lines = replyLines(item.text);
    if (item.partial) {
      const last = lines.length > 0 ? lines[lines.length - 1]!.replace(/ +$/, "") : undefined;
      if (last !== undefined && visibleWidth(last) + 1 <= w) lines[lines.length - 1] = last + CURSOR;
      else lines.push(CURSOR);
      return plain(lines);
    }
    return plain(lines);
  };

  /** `text` cut to `room` columns, at the last word boundary when there is one. */
  const cutWords = (text: string, room: number) => {
    const cut = truncate(text, Math.max(0, room));
    const space = cut.lastIndexOf(" ");
    return (space > 0 && cut.length < text.length && text[cut.length] !== " " ? cut.slice(0, space) : cut).replace(/ +$/, "");
  };

  const thought = (text: string) => (deps.italic ?? ((t: string) => t))(fg("thinkingText", text));

  /**
   * A thought as one row: whole when it is one line that fits ("· text", nothing to open), else its
   * first line as a preview ("› first …"). Open, "⌄ first" over the rest, so the first line is not
   * drawn twice; a first line too long for its row is cut there and drawn whole below.
   */
  const thinking = (item: Extract<ChatItem, { kind: "thinking" }>, indent: string): Row[] => {
    const { first, rest } = splitThought(item.text);
    const room = Math.max(1, w - indent.length - 2);
    if (rest === "" && visibleWidth(first) <= room) return [{ line: `${indent}${fg("dim", "·")} ${thought(first)}` }];
    const target = thinkingKey(item.id);
    if (!open(target)) {
      const cut = visibleWidth(first) + 2 > room ? cutWords(first, room - 2) : first;
      return [{ line: `${indent}${fg("dim", THINKING_GLYPH)} ${thought(cut)}${fg("dim", " …")}`, target }];
    }
    const fits = visibleWidth(first) <= room;
    // A first line that fits heads the block and the rest follows; one that does not fit is not cut and then
    // repeated below: the whole thought wraps from the toggle row on, so nothing is drawn twice.
    const below = fits ? rest : item.text.trim();
    const text = below === "" ? [] : (deps.thinking?.(below, room) ?? deps.markdown(below, room).map((l) => fg("thinkingText", l)));
    while (text.length > 0 && visibleWidth(text.at(-1)!.trim()) === 0) text.pop();
    while (!fits && text.length > 0 && visibleWidth(text[0]!.trim()) === 0) text.shift();
    const glyph = `${indent}${fg("dim", THINKING_GLYPH)} `;
    if (!fits && text.length > 0) return text.map((l, i) => (i === 0 ? { line: `${glyph}${l}`, target } : { line: `${indent}  ${l}` }));
    return [{ line: `${glyph}${thought(first)}`, target }, ...text.map((l) => ({ line: `${indent}  ${l}` }))];
  };

  /** One step in one row: status glyph, verb, subject. */
  const toolRow = (item: ToolItem): string => {
    const [glyph, token] = GLYPHS[item.status];
    const step = stepLine(item.tool);
    // Grey, so the replies lead; the glyph alone says how the step went.
    const words = [step.verb, step.subject].filter((p) => p !== "").join(" ");
    let row = words === "" ? fg(token, glyph) : `${fg(token, glyph)} ${fg("muted", words)}`;
    const call = item.tool;
    if (call.kind === "execute" && call.exitCode !== undefined && call.exitCode !== 0) row += fg("dim", ` · exit ${call.exitCode}`);
    if (call.images) row += fg("dim", ` · ${imagesLabel(call.images)}`);
    if (call.kind === "other" && call.badge?.result !== undefined) row += fg("dim", ` · ${call.badge.result}`);
    return row;
  };

  /** "… N more lines", or nothing when nothing was cut. */
  const more = (n: number, indent = ""): Row[] => (n > 0 ? [{ line: `${indent}${fg("dim", `… ${n} more line${n === 1 ? "" : "s"}`)}` }] : []);

  /** `text` wrapped to `room`, the first line after `first` and the rest after as many spaces. */
  const hanging = (text: string, room: number, first: string, token: string): Row[] => {
    const pad = " ".repeat(first.length);
    return text.split("\n").flatMap((para, p) => {
      // A line's own indentation is kept (a command's continuation lines), not left to the wrapper.
      const lead = /^\s*/.exec(para)![0].replace(/\t/g, "  ");
      const inner = Math.max(1, room - first.length - lead.length);
      return deps.wrap(para.trimStart(), inner).map((l, i) => ({ line: fg(token, `${p === 0 && i === 0 ? first : pad}${lead}${l}`) }));
    });
  };

  /** Collie's card header word for a call. A tool outside the nine is named by its own name. */
  const label = (call: ToolItem["tool"]): string => {
    switch (call.kind) {
      case "execute":
        return "Run";
      case "edit":
        return call.write ? "Write" : "Edit";
      case "read":
        return "Read";
      case "search":
        return "Search";
      case "fetch":
        return "Fetch";
      case "task":
        return "Agent";
      case "delete":
        return "Delete";
      case "move":
        return "Move";
      case "question":
        return call.name;
      case "other":
        return call.badge?.label ?? call.name;
    }
  };

  /** What the call was asked to do, in full, wrapped to `room`: the command, the diff, the path, the query. */
  const cardBody = (call: ToolItem["tool"], room: number): Row[] => {
    const mono = (text: string) => hanging(text, room, "", "accent");
    switch (call.kind) {
      case "execute":
        return [...(call.description ? hanging(call.description, room, "", "muted") : []), ...hanging(call.command, room, "$ ", "accent")];
      case "edit": {
        const diff = call.diff ?? [];
        const kept = diff.slice(0, MAX_DIFF_ROWS);
        // Each diff line keeps its colour on every row it wraps to; the sign stays in its own column.
        const shown = kept.flatMap((d) => hanging(d.text, room, d.op === "@" ? "" : d.op, DIFF_TOKENS[d.op]!));
        return [...mono(shortPath(call.path)), ...shown, ...more(diff.length - kept.length)];
      }
      case "read":
        return mono(call.range ? `${shortPath(call.path)} · lines ${call.range[0]}–${call.range[1]}` : shortPath(call.path));
      case "search":
        return mono(call.where ? `${call.query} · in ${call.where}` : call.query);
      case "fetch":
        return mono(call.url);
      case "task":
        return hanging(`${call.agent ?? "Agent"}: ${call.summary}`, room, "", "muted");
      case "delete":
        return mono(shortPath(call.path));
      case "move":
        return mono(call.to ? `${shortPath(call.path)} → ${shortPath(call.to)}` : shortPath(call.path));
      case "question":
        return call.summary === "" ? [] : hanging(call.summary, room, "", "muted");
      case "other": {
        // A badge card's title already says what it did: the body is its outcome (RDD), its script
        // (codemode) or what it acted on, never the action again.
        const b = call.badge;
        if (b === undefined) return call.summary === "" ? [] : hanging(call.summary, room, "", "muted");
        if (b.summary !== undefined) return hanging(b.summary, room, "", "toolOutput");
        if (b.body !== undefined) return mono(b.body);
        return b.subject === "" ? [] : hanging(b.subject, room, "", "muted");
      }
    }
  };

  /**
   * "› Output · N lines", and open, the first lines of the output (dim) and "› Show all N lines";
   * that open, every line up to the cap and "⌄ Show fewer". Rows are wrapped to `room`.
   */
  const outputRows = (item: ToolItem, room: number): Row[] => {
    const text = item.tool.output?.replace(/\s+$/, "");
    if (text === undefined || text === "") return [];
    const target = outputKey(item.id);
    const all = text.split("\n");
    const total = Math.max(item.tool.outputLines ?? 0, all.length);
    const isOpen = open(target);
    // With a summary drawn above, what is left is the raw envelope.
    const name = item.tool.kind === "other" && item.tool.badge?.summary !== undefined ? "Raw output" : "Output";
    const title = `${isOpen ? "⌄" : "›"} ${name} · ${total} line${total === 1 ? "" : "s"}`;
    const rows: Row[] = [{ line: fg(item.status === "failed" ? "error" : "dim", title), target }];
    if (!isOpen) return rows;
    const allKey = outputAllKey(item.id);
    const preview = total > OUTPUT_PREVIEW_ROWS;
    const everything = preview && open(allKey);
    // Cut lines are counted in source lines; a wrapped line is still one of them.
    const kept = all.slice(0, everything ? MAX_OUTPUT_ROWS : OUTPUT_PREVIEW_ROWS);
    const inner = Math.max(1, room - 2);
    rows.push(...kept.flatMap((l) => deps.wrap(l, inner)).map((l) => ({ line: `  ${fg("dim", l)}` })));
    if (!preview) return rows;
    if (!everything) return [...rows, { line: fg("dim", `› Show all ${total} lines`), target: allKey }];
    return [...rows, ...more(total - kept.length, "  "), { line: fg("dim", "⌄ Show fewer"), target: allKey }];
  };

  /**
   * A tool call: its one-line row, or open (a click on it), Collie's card in a rounded box from
   * `indent` to the right edge. The top border is the card's toggle.
   */
  const toolStep = (item: ToolItem, indent: string): Row[] => {
    const target = cardKey(item.id);
    if (!open(target)) return [{ line: `${indent}${toolRow(item)}`, target }];
    const border = (text: string) => fg("borderMuted", text);
    const span = Math.max(4, w - indent.length);
    const room = Math.max(1, span - 4);
    const [glyph, token] = GLYPHS[item.status];
    const call = item.tool;
    // A badge card is titled like its closed row ("🌹 rdd inspect"), not by its family's name.
    const name = call.kind === "other" && call.badge !== undefined ? stepLine(call).verb : label(call);
    let title = `${fg(token, glyph)} ${deps.bold(name)}`;
    if (call.kind === "execute" && call.exitCode !== undefined && call.exitCode !== 0) title += fg("dim", ` · exit ${call.exitCode}`);
    if (visibleWidth(title) > Math.max(1, span - 5)) title = truncate(title, Math.max(1, span - 5));
    const dashes = Math.max(0, span - 4 - visibleWidth(title));
    const line = (content: string) => {
      const fitted = visibleWidth(content) > room ? truncate(content, room) : content;
      return `${indent}${border("│ ")}${fitted}${" ".repeat(Math.max(0, room - visibleWidth(fitted)))}${border(" │")}`;
    };
    const rule = (left: string, right: string) => `${indent}${border(`${left}${"─".repeat(span - 2)}${right}`)}`;
    const rows: Row[] = [{ line: `${indent}${border("╭ ")}${title} ${border(`${"─".repeat(dashes)}╮`)}`, target }];
    rows.push(...cardBody(call, room).map((r) => ({ line: line(r.line) })));
    // Drawn inside the box when the terminal can; otherwise say where they are.
    if (call.images) {
      const marker = (n: number) => {
        const where = n === 1 ? "alt+c shows it in Terminal" : "alt+c shows them in Terminal";
        return hanging(`${imagesLabel(n)} — ${where}`, room, "", "dim").map((r) => line(r.line));
      };
      rows.push(...imageRows(call.imageData, call.images, CARD_IMAGE_CELLS, room, line, marker));
    }
    const output = outputRows(item, room);
    if (output.length > 0) rows.push({ line: rule("├", "┤") }, ...output.map((r) => ({ line: line(r.line), target: r.target })));
    rows.push({ line: rule("╰", "╯") });
    return rows.map((r) => ({ ...r, framed: true as const }));
  };

  /** A step of a run. `card`: a tool step may open into its card (single rows and open runs). */
  const step = (item: ChatItem, indent: string, card = false): Row[] =>
    item.kind === "thinking"
      ? thinking(item, indent)
      : item.kind === "tool"
        ? card
          ? toolStep(item, indent)
          : [{ line: `${indent}${toolRow(item)}` }]
        : [];

  /** A question the agent asked: its text, each option, and the answer once there is one. */
  const question = (item: ToolItem): string[] => {
    const call = item.tool;
    if (call.kind !== "question") return [toolRow(item)];
    const [glyph, token] = GLYPHS[item.status];
    const lines = [`${fg(token, glyph)} ${stepLine(call).verb}`];
    // The chosen options are marked in the list itself (☑ / ●; fonts draw ☑ wide, so two spaces follow it; success colour; the rest dims); an answer that is
    // no option (typed by the person) shows under its question. Without per-question choices, the old "→" line.
    const chosen = call.chosen;
    call.questions.forEach((q, i) => {
      const text = q.header === undefined ? q.question : `${q.header}: ${q.question}`;
      for (const l of deps.wrap(text, Math.max(1, w - 2))) lines.push(`  ${l}`);
      const picked = chosen?.[i] ?? [];
      for (const o of q.options) {
        const desc = o.description === undefined ? "" : fg("dim", ` — ${collapse(o.description)}`);
        if (picked.includes(o.label)) lines.push(`    ${fg("success", `${q.multiple ? "☑  " : "● "}${o.label}`)}${desc}`);
        else if (picked.length > 0) lines.push(`    ${fg("muted", q.multiple ? "□" : "○")} ${fg("dim", o.label)}${desc}`);
        else lines.push(`    ${fg("muted", q.multiple ? "□" : "○")} ${o.label}${desc}`);
      }
      for (const typed of picked.filter((p) => !q.options.some((o) => o.label === p))) lines.push(`    ${fg("accent", `→ ${collapse(typed)}`)}`);
    });
    if (chosen === undefined && call.output !== undefined && call.output.trim() !== "") lines.push(`  ${fg("accent", `→ ${collapse(call.output)}`)}`);
    return lines;
  };

  /**
   * A question waiting for the person shows every option. Once answered it folds to one row with its answers
   * ("› ✓ ❓ Question · Inventario · Quejas"); a click opens the full card again.
   */
  const questionRows = (item: ToolItem): Row[] => {
    const lines = question(item);
    const call = item.tool;
    const answer = call.kind === "question" ? call.output?.trim() : undefined;
    // A failed or refused question never reached the person: it folds too, red, saying why.
    const refused = item.status === "failed" || item.status === "denied";
    // Waiting for the person, Gentle's dialog under the chat already lists the options: the card folds too.
    const waiting = item.status === "running";
    if (!waiting && !refused && (answer === undefined || answer === "")) return plain(lines);
    const target = cardKey(item.id);
    if (open(target)) return [{ line: `${fg("dim", "⌄")} ${lines[0]!}`, target }, ...plain(lines.slice(1))];
    const said = waiting
      ? fg("dim", "waiting for your answer below")
      : refused
        ? fg("error", collapse((call as ChatToolCall).failure ?? "not asked"))
        : fg("success", collapse(answer!));
    return [{ line: truncate(`${fg("dim", "›")} ${lines[0]!} ${fg("dim", "·")} ${said}`, w), target }];
  };

  /**
   * " · 4m 12s": the earliest start to the latest result of a run; a live one counts to `now`. Nothing
   * when the times are not known or it took under a second.
   */
  const runDuration = (steps: ChatItem[]): string => {
    const ms = (iso: string | undefined) => (iso === undefined ? NaN : Date.parse(iso));
    const starts = steps.map((s) => ms(s.ts)).filter(Number.isFinite);
    const ends = steps.map((s) => (s.kind === "tool" ? ms(s.end) : NaN)).filter(Number.isFinite);
    if (starts.length === 0) return "";
    // A live run counts to now: its rows change with every frame of the clock, so they are never cached.
    if (isLive(steps)) volatile = true;
    const end = isLive(steps) ? opts.now?.getTime() : ends.length > 0 ? Math.max(...ends) : undefined;
    const label = end === undefined ? undefined : formatDuration(end - Math.min(...starts));
    return label === undefined ? "" : fg("dim", ` · ${label}`);
  };

  /**
   * 3+ steps. Closed, an open run shows its tail and a finished one folds into a summary row. Open
   * (a click on its "›" row, or ctrl+o), either shows every step under a "⌄ summary" row.
   */
  const run = (steps: ChatItem[]): Row[] => {
    const target = runKey(steps[0]!.id);
    const { summary, failed } = runSummary(steps);
    const took = runDuration(steps);
    const head = (glyph: string) => {
      let line = `${fg("dim", glyph)} ${fg("muted", summary === "" ? "Thinking" : summary)}${took}`;
      if (failed > 0) line += `  ${fg("error", `[${failedLabel(failed)}]`)}`;
      return { line, target };
    };
    if (open(target)) return [head("⌄"), ...steps.flatMap((s) => step(s, "  ", true))];
    if (isLive(steps)) {
      const hidden = Math.max(0, steps.length - LIVE_TAIL);
      const rows: Row[] = [];
      if (hidden > 0) {
        const earlier = runSummary(steps.slice(0, hidden)).summary;
        const label = earlier === "" ? `${hidden} earlier step${hidden === 1 ? "" : "s"}` : earlierLabel(hidden, earlier);
        rows.push({ line: `${fg("dim", `› ${label}`)}${took}`, target });
      }
      for (const s of steps.slice(hidden)) rows.push(...step(s, "  "));
      return rows;
    }
    const last = [...steps].reverse().find((s) => s.kind === "tool") ?? steps[steps.length - 1]!;
    return [head("›"), ...step(last, "  ")];
  };

  const block = (group: ChatItem[]): Row[] => {
    if (group.length > 1) return run(group);
    const item = group[0]!;
    switch (item.kind) {
      case "user":
        return userTurn(item).map((r) => ({ ...r, framed: true as const }));
      case "reply":
        return reply(item);
      case "thinking":
        return thinking(item, "");
      case "notice": {
        // `plain` (no styling yet) in `tone`, its notice label in accent when it carries it whole or cut at the end.
        const paint = (text: string, tone: string): string => {
          const label = COLOR_TITLES && !item.error ? item.label : undefined;
          const at = label === undefined ? -1 : text.indexOf(label.slice(0, Math.min(label.length, 3)));
          if (label === undefined || at < 0) return fg(tone, text);
          let end = at;
          while (end < text.length && end - at < label.length && text[end] === label[end - at]) end++;
          if (end === at) return fg(tone, text);
          const before = text.slice(0, at);
          const after = text.slice(end);
          return `${before === "" ? "" : fg(tone, before)}${fg("accent", text.slice(at, end))}${after === "" ? "" : fg(tone, after)}`;
        };
        // Fits the row: one centred status line, as before. Too long: Collie folds a long machine note behind its
        // label; here the row previews it and opens to the whole text, wrapped and dim.
        // collapse() squeezes spaces; ❀ keeps its second one (fonts draw it wide, see glyphGap in group.ts).
        // A notice with a heading (a background job) always folds to it, red when the job failed.
        if (item.title !== undefined) {
          const target = noticeKey(item.id);
          const tone = item.error ? "error" : "dim";
          const head = open(target) ? "⌄" : "›";
          const title = visibleWidth(`${head} ${item.title}`) > w ? truncate(`${head} ${item.title}`, w) : `${head} ${item.title}`;
          const rows: Row[] = [{ line: paint(title, tone), target }];
          if (!open(target)) return rows;
          for (const l of item.text.split("\n").flatMap((l) => deps.wrap(l, Math.max(1, w - 2)))) rows.push({ line: fg("dim", `  ${l}`) });
          return rows;
        }
        const one = collapse(item.text).replace(/❀ /g, "❀  ");
        if (visibleWidth(one) <= w) return plain([centre(paint(one, "dim"))]);
        const target = noticeKey(item.id);
        if (!open(target)) {
          // pi-tui's truncate already ends in "…" (before its closing style codes); add one only when it did not.
          const cut = truncate(`› ${one}`, Math.max(1, w - 1));
          return [{ line: paint(/…(\x1b\[[0-9;]*m)*$/.test(cut) ? cut : `${cut}…`, "dim"), target }];
        }
        // Open: the whole text, wrapped, its first row carrying the "⌄" toggle so nothing is drawn twice.
        const body = item.text.trim().split("\n").flatMap((l) => deps.wrap(l, Math.max(1, w - 2)));
        return body.map((r, i) => (i === 0 ? { line: paint(`⌄ ${r}`, "dim"), target } : { line: fg("dim", `  ${r}`) }));
      }
      case "compacted": {
        const time = clock(item.ts, opts.now);
        return plain([centre(fg("dim", time === undefined ? "Context compacted" : `Context compacted · ${time}`))]);
      }
      case "tool":
        return item.tool.kind === "question" ? questionRows(item) : toolStep(item, "");
    }
  };

  const cache = opts.cache;
  if (cache !== undefined) {
    if (cache.width !== w) {
      cache.clear();
      cache.width = w;
    }
    cache.drawn = 0;
    cache.reused = 0;
  }
  const day = opts.now?.toDateString();

  /** A group's rows, from the cache when nothing it was drawn from has changed. */
  const groupRows = (group: ChatItem[]): GroupRows => {
    const key = group[0]!.id;
    const hit = cache?.groups.get(key);
    if (
      hit !== undefined &&
      hit.day === day &&
      hit.items.length === group.length &&
      hit.items.every((item, i) => item === group[i]) &&
      hit.consulted.every(([k, v]) => ask(k) === v)
    ) {
      cache!.reused++;
      return hit;
    }
    consulted = [];
    volatile = false;
    const drawn: GroupRows = { items: group, consulted, day, lines: [], targets: [], images: [], framed: [] };
    for (const row of block(group)) {
      if (row.image !== undefined) drawn.images.push([drawn.lines.length, row.image]);
      drawn.lines.push(fit(row.line));
      drawn.targets.push(row.target);
      drawn.framed.push(row.framed === true);
    }
    if (cache !== undefined) {
      cache.drawn++;
      cache.groups.delete(key);
      if (!volatile) {
        cache.groups.set(key, drawn);
        if (cache.groups.size > cache.max) cache.groups.delete(cache.groups.keys().next().value!);
      }
    }
    return drawn;
  };

  /** Is `item` one a run of steps can take in? Runs only form from these. */
  const runnable = (item: ChatItem) => !standsAlone(item) && (item.kind === "tool" || item.kind === "thinking");

  // Where to start: the first item that differs from the last render, moved back to the start of the
  // stretch of steps it belongs to (a new step can turn two single rows into a folded run), and to a
  // live run before it. Everything before that is kept as it was.
  const last = cache?.last;
  let from = 0;
  let k = 0;
  let out: ChatRows;
  let book: LastRender;
  let boxStart: number | undefined;
  if (last !== undefined && opts.expansionVersion !== undefined && last.expansionVersion === opts.expansionVersion && last.day === day) {
    const n = Math.min(items.length, last.items.length);
    let p = 0;
    while (p < n && items[p] === last.items[p]) p++;
    if (p === items.length && p === last.items.length && last.volatileFrom === Infinity) {
      cache!.kept = items.length;
      return last.out;
    }
    p = Math.min(p, last.volatileFrom);
    while (p > 0 && runnable(items[p - 1]!)) p--;
    // The group that starts there, in the last render: everything from it on is drawn again.
    k = last.firstItem.length;
    while (k > 0 && last.firstItem[k - 1]! >= p) k--;
    from = k < last.firstItem.length ? last.firstItem[k]! : last.items.length;
    out = last.out;
    boxStart = k < last.boxBefore.length ? last.boxBefore[k] : last.boxEnd;
    const cut = k < last.lineStart.length ? last.lineStart[k]! : out.lines.length;
    for (let g = k; g < last.keys.length; g++) {
      const keys = last.keys[g]!;
      if (keys.sticky !== undefined) out.sticky!.delete(keys.sticky);
      for (const i of keys.images) out.images!.delete(i);
    }
    out.lines.length = cut;
    out.targets.length = cut;
    out.turns!.length = cut;
    out.framed!.length = cut;
    book = last;
    book.firstItem.length = k;
    book.lineStart.length = k;
    book.keys.length = k;
    book.boxBefore.length = k;
    book.volatileFrom = Infinity;
    book.items = items;
  } else {
    out = { lines: [], targets: [], turns: [], sticky: new Map(), images: new Map(), framed: [] };
    book = { items, out, day, expansionVersion: opts.expansionVersion ?? -1, firstItem: [], lineStart: [], boxBefore: [], keys: [], volatileFrom: Infinity, boxEnd: undefined };
  }
  if (cache !== undefined) {
    cache.kept = from;
    cache.last = opts.expansionVersion === undefined ? undefined : book;
  }

  const turns = out.turns!;
  // First line of the newest user box so far: what the lines after it belong to.
  let box = boxStart;
  let index = from;
  for (const group of groupRuns(from === 0 ? items : items.slice(from))) {
    const first = group[0]!;
    book.firstItem.push(index);
    book.lineStart.push(out.lines.length);
    book.boxBefore.push(box);
    const keys: { sticky?: number; images: number[] } = { images: [] };
    book.keys.push(keys);
    volatile = false;
    const rows = groupRows(group);
    if (volatile && book.volatileFrom === Infinity) book.volatileFrom = index;
    index += group.length;
    if (rows.lines.length === 0) continue;
    const isUser = group.length === 1 && first.kind === "user";
    if (out.lines.length > 0) {
      // Separator rows belong to the turn before. Recorded after this group's lineStart, so a kept
      // render that redraws from this group drops them with it.
      const gap = isUser && TURN_RULE ? ["", fg("borderMuted", "─".repeat(w)), ""] : [""];
      for (const line of gap) {
        out.lines.push(line);
        out.targets.push(undefined);
        turns.push(box);
        out.framed!.push(false);
      }
    }
    if (isUser) {
      box = out.lines.length;
      keys.sticky = box;
      out.sticky!.set(box, stickyOf(first.text !== "" ? first.text : `${imagesLabel(first.images ?? 0)} attached`));
    }
    const at = out.lines.length;
    for (const [i, span] of rows.images) {
      out.images!.set(at + i, span);
      keys.images.push(at + i);
    }
    const turn = isUser ? undefined : box;
    for (let i = 0; i < rows.lines.length; i++) {
      out.lines.push(rows.lines[i]!);
      out.targets.push(rows.targets[i]);
      turns.push(turn);
      out.framed!.push(rows.framed[i] === true);
    }
  }
  book.boxEnd = box;
  return out;
}
