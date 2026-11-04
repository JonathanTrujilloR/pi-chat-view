// The chat as a pi-tui component: a one-line header over a scrollable window of chat lines.
//
// It renders exactly `targetHeight` lines, set by the caller from the live layout, so the overlay
// covers the transcript rows and nothing under them. Pure: no Pi import, deps are injected.
//
// It also owns what is open: thinking blocks and runs of steps open with a click on their "›" row
// or all at once (ctrl+t / ctrl+o, through the controller), and stay open across live rebuilds.
//
// And it owns text selection over its rows: with an overlay on screen, pi-tui's own selection
// spans whole terminal rows, Gentle's Status rail included (tui-alt-screen.js ~1161). A press on chat
// text captures the mouse, so the drag and release come here and Pi starts no selection of its own.

import type { ChatItem } from "../model/items.ts";
import { isRunKey, isThinkingKey, type ChatRows, type ImageSpan } from "./render.ts";

/** Columns kept clear on each side of the chat's content, header and pinned row included. 0 reverts. */
export const MARGIN = 2;

export const HEADER = " Chat · alt+c Terminal · PgUp/PgDn scroll";

export interface ChatViewDeps {
  /**
   * The chat items as lines no wider than `width`, opening the toggles `expanded` says are open.
   * Plain lines are a chat with nothing to click.
   */
  renderLines(items: readonly ChatItem[], width: number, expanded: (key: string) => boolean, expansion?: number): string[] | ChatRows;
  fg(token: string, text: string): string;
  visibleWidth(text: string): number;
  truncate(text: string, width: number): string;
  /** Drop caches below the view (rendered markdown), e.g. on a theme change. */
  invalidate?(): void;
  /** A rendered line as plain text: styles and zero-width sequences gone. Default: strip escapes. */
  plain?(line: string): string;
  /** Background by theme token; draws the selection (`selectedBg`) when `highlight` is absent. */
  bg?(token: string, text: string): string;
  /** `line` with columns [from, to) drawn as selected, keeping the rest's styles. */
  highlight?(line: string, from: number, to: number): string;
}

/** A cell of the chat: line index in the chat's own lines, and visible column. */
export interface ChatPoint {
  line: number;
  col: number;
}

/** CSI, OSC and APC sequences, and two-character escapes. */
const ESCAPES = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b_[^\x1b]*\x1b\\|\x1b[@-Z\\-_]/g;

/** A line's decoration that is not its text: the user bar, card borders. Removed from copies. */
function undecorate(text: string): string {
  return text.replace(/^(\s*)(?:▎|│) ?/, "$1").replace(/ ?│\s*$/, "").replace(/\s+$/, "");
}

/** The subset of pi-tui's `TuiMouseEvent` read here. `y` is local to the overlay (0 = header row). */
export interface MouseEventLike {
  type: string;
  button?: string;
  x?: number;
  y?: number;
  wheelDelta?: number;
}

/** What `handleMouse` answers: `capture` routes the drag and release of a selection here. */
export type MouseResult = { handled: true; capture?: true } | undefined;

export class ChatView {
  /** Rows to render, header included. 0 renders nothing. */
  targetHeight = 0;

  private items: readonly ChatItem[] = [];
  private version = 0;
  /** Bumped whenever what is open changes; tells the renderer when its kept rows may still be used. */
  private expansion = 0;
  private cache:
    | {
        width: number;
        version: number;
        lines: string[];
        targets: (string | undefined)[];
        turns: (number | undefined)[];
        sticky: Map<number, (rows: number) => string[]>;
        images: Map<number, ImageSpan>;
        /** Per line: drawn in the chat's own frame; undefined (plain lines) means every line may be. */
        framed?: boolean[];
      }
    | undefined;
  /** Default for each kind, flipped by ctrl+t / ctrl+o, and per-row overrides of it. */
  private thinkingOpen = false;
  private toolsOpen = false;
  private readonly overrides = new Map<string, boolean>();
  /** Screen row of a press this view toggled on: its release and click are the same gesture. */
  private pressedRow: number | undefined;
  /** The selection: where the press was and where the pointer is, in chat cells. */
  private sel: { anchor: ChatPoint; focus: ChatPoint } | undefined;
  /** A press started a selection and its release has not come yet. */
  private selecting = false;
  /** The pointer moved since that press: a still press and release selects nothing. */
  private dragged = false;
  /** Called with the selected text when a drag ends (copy-on-select). */
  onCopy?: (text: string, lines: number) => void;
  /** The margin and content width of the last render: mouse x is content x plus the margin. */
  private margin = 0;
  private inner = 0;
  /** Lines hidden under the window; 0 follows the bottom. */
  private offset = 0;
  /** Most `offset` can be, from the last render. */
  private maxOffset = 0;

  private readonly deps: ChatViewDeps;

  constructor(deps: ChatViewDeps) {
    this.deps = deps;
  }

  setItems(items: readonly ChatItem[]): void {
    this.items = items;
    this.version++;
  }

  invalidate(): void {
    this.cache = undefined;
    this.deps.invalidate?.();
  }

  isExpanded(key: string): boolean {
    // Cards and output rows start closed whatever ctrl+o says: it opens runs, as Collie's group does.
    return this.overrides.get(key) ?? (isThinkingKey(key) ? this.thinkingOpen : isRunKey(key) ? this.toolsOpen : false);
  }

  /** Open or close one row. Scrolled up, the row keeps its screen row (see `lines`). */
  toggle(key: string): void {
    this.overrides.set(key, !this.isExpanded(key));
    this.expansion++;
    this.version++;
  }

  /** ctrl+t: every thinking block, and the default for new ones; per-row choices reset. */
  toggleAllThinking(): void {
    this.thinkingOpen = !this.thinkingOpen;
    for (const key of [...this.overrides.keys()]) if (isThinkingKey(key)) this.overrides.delete(key);
    this.expansion++;
    this.version++;
  }

  /** ctrl+o: every run of steps, and the default for new ones; per-run choices reset, cards stay. */
  toggleAllTools(): void {
    this.toolsOpen = !this.toolsOpen;
    for (const key of [...this.overrides.keys()]) if (isRunKey(key)) this.overrides.delete(key);
    this.expansion++;
    this.version++;
  }

  /** Negative scrolls up (older), as a wheel's delta does. */
  scrollBy(delta: number): void {
    this.offset = Math.max(0, Math.min(this.maxOffset, this.offset - delta));
  }

  private get page(): number {
    return Math.max(1, this.targetHeight - 2);
  }

  pageUp(): void {
    this.scrollBy(-this.page);
  }

  pageDown(): void {
    this.scrollBy(this.page);
  }

  top(): void {
    this.offset = this.maxOffset;
  }

  bottom(): void {
    this.offset = 0;
  }

  /**
   * The window for the current offset over the last render: chat lines [start, end), and above them
   * the pinned user message, when the box its first line follows is scrolled out of sight. The pin
   * covers the window's top rows, so the window keeps its height; it is left out when the next user
   * box would sit right under it, or when fewer than two chat rows would remain.
   */
  private layout(): { start: number; end: number; box?: number; sticky: string[] } {
    const c = this.cache!;
    const body = this.targetHeight - 1;
    const end = c.lines.length - this.offset;
    const raw = Math.max(0, end - body);
    const box = c.turns[raw];
    const make = box === undefined ? undefined : c.sticky.get(box);
    if (make !== undefined) {
      // Up to two text rows and the rule under them; at least one text row and two chat rows left.
      const want = make(3);
      const k = Math.min(want.length, body - 2);
      if (k >= 2 && raw + k < end && c.turns[raw + k] === box) {
        return { start: raw + k, end, box, sticky: k === want.length ? want : make(k) };
      }
    }
    return { start: raw, end, sticky: [] };
  }

  /** What screen row `y` (row 0 is the header) shows, as the window stands now. */
  private hit(y: number | undefined): { box: number } | { key: string } | undefined {
    if (this.cache === undefined || y === undefined || y < 1 || this.targetHeight <= 1) return undefined;
    const { start, end, box, sticky } = this.layout();
    // The pinned text scrolls to its box; the rule under it is not a target.
    if (box !== undefined && y < sticky.length) return { box };
    if (box !== undefined && y === sticky.length) return undefined;
    const line = start + y - 1 - sticky.length;
    const key = line < end ? this.cache.targets[line] : undefined;
    return key === undefined ? undefined : { key };
  }

  hasSelection(): boolean {
    return this.sel !== undefined;
  }

  /** The selection, start before end (both cells included), or undefined. */
  selection(): { start: ChatPoint; end: ChatPoint } | undefined {
    if (this.sel === undefined) return undefined;
    const { anchor: a, focus: f } = this.sel;
    const before = a.line < f.line || (a.line === f.line && a.col <= f.col);
    return before ? { start: a, end: f } : { start: f, end: a };
  }

  /** Drop the selection (Escape, a new press). True when there was one. */
  clearSelection(): boolean {
    const had = this.sel !== undefined;
    this.sel = undefined;
    this.selecting = false;
    return had;
  }

  private plain(line: string): string {
    return this.deps.plain?.(line) ?? line.replace(ESCAPES, "");
  }

  /** Visible columns [from, to) of plain text. */
  private columns(text: string, from: number, to: number): string {
    let col = 0;
    let out = "";
    for (const ch of text) {
      const w = this.deps.visibleWidth(ch);
      if (col >= from && col + w <= to) out += ch;
      col += w;
      if (col >= to) break;
    }
    return out;
  }

  /** The selected columns [from, to) of chat line `line`, or undefined when none of it is selected. */
  private selectedColumns(line: number, width: number): [number, number] | undefined {
    const r = this.selection();
    if (r === undefined || line < r.start.line || line > r.end.line) return undefined;
    const from = line === r.start.line ? r.start.col : 0;
    const to = Math.min(width, line === r.end.line ? r.end.col + 1 : width);
    return from < to ? [from, to] : undefined;
  }

  /** The selected text: plain, without the user bar and card borders, trailing spaces trimmed. */
  selectedText(): { text: string; lines: number } | undefined {
    const r = this.selection();
    if (r === undefined || this.cache === undefined) return undefined;
    const out: string[] = [];
    for (let line = r.start.line; line <= r.end.line && line < this.cache.lines.length; line++) {
      const cols = this.selectedColumns(line, this.cache.width);
      const text = cols === undefined ? "" : this.columns(this.plain(this.cache.lines[line]!), cols[0], cols[1]);
      // Only the chat's own frame is dropped: a reply's table keeps its "│" borders.
      out.push(this.cache.framed === undefined || this.cache.framed[line] === true ? undecorate(text) : text.replace(/\s+$/, ""));
    }
    const text = out.join("\n").replace(/\s+$/, "");
    return text === "" ? undefined : { text, lines: out.length };
  }

  /**
   * The chat cell under screen point (x, y), or where a drag past an edge points: "above" over the
   * header and pinned rows or higher, "below" under the last row. Past the last line, the end of it.
   */
  private pointAt(x: number, y: number): ChatPoint | "above" | "below" | undefined {
    if (this.cache === undefined || this.cache.lines.length === 0) return undefined;
    const { start, end, sticky } = this.layout();
    if (y < 1 + sticky.length) return "above";
    if (y > this.targetHeight - 1) return "below";
    const line = start + y - 1 - sticky.length;
    const col = Math.max(0, Math.min(this.cache.width - 1, x));
    if (line < end) return { line, col };
    const last = Math.max(0, end - 1);
    return { line: last, col: this.cache.width - 1 };
  }

  /** Move the selection's moving end to (x, y), scrolling one line when it is past an edge. */
  private dragTo(x: number, y: number): void {
    const at = this.pointAt(x, y);
    if (this.sel === undefined || at === undefined) return;
    if (at === "above" || at === "below") {
      this.scrollBy(at === "above" ? -1 : 1);
      const { start, end } = this.layout();
      const col = Math.max(0, Math.min(this.cache!.width - 1, x));
      this.sel.focus = { line: at === "above" ? start : Math.max(start, end - 1), col };
      return;
    }
    this.sel.focus = at;
  }

  /** Scroll so chat line `line` is the window's first row. */
  private scrollToLine(line: number): void {
    const total = this.cache?.lines.length ?? 0;
    this.offset = Math.max(0, Math.min(this.maxOffset, total - line - (this.targetHeight - 1)));
  }

  /**
   * Wheel scrolls. A left press on a "›" / "⌄" row opens or closes it; Pi then sends that press's
   * release and click here too, which are swallowed rather than toggling back. A click with no
   * press of ours before it (Pi's text-selection path) toggles. A press on the pinned user message
   * scrolls its box to the top.
   *
   * A left press anywhere else on the chat's rows starts a selection and captures the mouse: the
   * drags extend it (past the top or bottom edge they scroll a line each), the release copies it.
   * Pressed and released without moving, it selects nothing and clears what was selected. A press on
   * the header or the pinned rows is taken too, so Pi never starts its whole-screen selection here.
   */
  handleMouse(event: MouseEventLike): MouseResult {
    if (event.type === "wheel") {
      if (!event.wheelDelta) return undefined;
      this.scrollBy(event.wheelDelta);
      return { handled: true };
    }
    // Content columns: the left margin taken off. A press in either margin is on no text.
    const rawX = event.x ?? 0;
    const x = rawX - this.margin;
    const inMargin = x < 0 || (this.inner > 0 && x >= this.inner);
    const y = event.y ?? 0;
    if (event.type === "drag" && this.selecting) {
      this.dragged = true;
      this.dragTo(x, y);
      return { handled: true };
    }
    if (event.type === "release" && this.selecting) {
      this.selecting = false;
      if (!this.dragged) this.sel = undefined;
      else {
        const copied = this.selectedText();
        if (copied !== undefined) this.onCopy?.(copied.text, copied.lines);
      }
      return { handled: true };
    }
    if (event.type === "press") {
      this.pressedRow = undefined;
      this.clearSelection();
    }
    if (event.button !== "left") return undefined;
    if ((event.type === "release" || event.type === "click") && this.pressedRow !== undefined && this.pressedRow === event.y) {
      if (event.type === "click") this.pressedRow = undefined;
      return { handled: true };
    }
    if (event.type !== "press" && event.type !== "click") return undefined;
    const target = this.hit(event.y);
    if (target === undefined) {
      if (event.type !== "press") return undefined;
      const at = this.pointAt(x, y);
      this.pressedRow = event.y;
      if (at === undefined || at === "above" || at === "below" || inMargin) return { handled: true };
      this.sel = { anchor: at, focus: at };
      this.selecting = true;
      this.dragged = false;
      return { handled: true, capture: true };
    }
    if ("box" in target) this.scrollToLine(target.box);
    else this.toggle(target.key);
    if (event.type === "press") this.pressedRow = event.y;
    return { handled: true };
  }

  private lines(width: number): string[] {
    const old = this.cache;
    if (old?.width !== width || old.version !== this.version) {
      // Read before rendering: a renderer may update the previous rows in place.
      const oldLength = old?.lines.length ?? 0;
      const rendered = this.deps.renderLines(this.items, width, (key) => this.isExpanded(key), this.expansion);
      const { lines, targets, turns = [], sticky = new Map(), images = new Map(), framed } = Array.isArray(rendered) ? { lines: rendered, targets: [], framed: undefined } : rendered;
      // Scrolled up, new lines arrive below the window, or under a row just opened or closed in it:
      // grow the offset by as many, so the window (and the clicked row) stays on what the person is
      // reading. At 0 the window follows the bottom on its own.
      // Chat cells mean other text at another width.
      if (old !== undefined && old.width !== width) this.clearSelection();
      if (old !== undefined && old.width === width && this.offset > 0) {
        this.offset = Math.max(0, this.offset + lines.length - oldLength);
      }
      this.cache = { width, version: this.version, lines, targets, turns, sticky, images, framed };
    }
    return this.cache!.lines;
  }

  private highlight(line: string, from: number, to: number): string {
    if (this.deps.highlight !== undefined) return this.deps.highlight(line, from, to);
    // Plain fallback: the row loses its own colours while part of it is selected.
    const text = this.plain(line);
    const mark = this.deps.bg ?? ((_t: string, s: string) => `\x1b[7m${s}\x1b[27m`);
    const mid = this.columns(text, from, to);
    return mid === "" ? line : `${this.columns(text, 0, from)}${mark("selectedBg", mid)}${this.columns(text, to, Number.MAX_SAFE_INTEGER)}`;
  }

  render(outer: number): string[] {
    const height = this.targetHeight;
    if (height <= 0) return [];
    const { fg, visibleWidth, truncate } = this.deps;
    // Everything is drawn at the inner width, then set between the margins.
    const m = Math.min(MARGIN, Math.max(0, Math.floor((outer - 1) / 2)));
    const width = outer - 2 * m;
    this.margin = m;
    this.inner = width;
    const side = " ".repeat(m);
    const full = (line: string) => {
      const fitted = visibleWidth(line) > width ? truncate(line, width) : line;
      return side + fitted + " ".repeat(Math.max(0, width - visibleWidth(fitted))) + side;
    };

    const lines = this.lines(width);
    const body = height - 1;
    this.maxOffset = Math.max(0, lines.length - body);
    this.offset = Math.min(this.offset, this.maxOffset);
    const { start, end, sticky } = this.layout();
    const shownLines = lines.slice(start, end);
    // An image is drawn only when all of it is inside the window (it must never reach past the
    // overlay onto Gentle's input box). Cut at the bottom, or with its first row above the window or
    // under the pinned row, its rows show its fallback instead: the marker, then blank rows. The
    // span keeps its height, so scrolling is unchanged.
    for (const [first, span] of this.cache!.images) {
      const last = first + span.rows;
      if (last <= start || first >= end) continue;
      if (first >= start && last <= end) continue;
      for (let line = Math.max(first, start); line < Math.min(last, end); line++) {
        shownLines[line - start] = span.fallback[line - first] ?? "";
      }
    }
    // The selection, over its cells of the visible chat rows only (never the header or pinned rows).
    if (this.sel !== undefined) {
      for (let i = 0; i < shownLines.length; i++) {
        const cols = this.selectedColumns(start + i, width);
        const line = shownLines[i]!;
        if (cols === undefined || line.includes("\x1b_G")) continue;
        shownLines[i] = this.highlight(line, cols[0], cols[1]);
      }
    }
    const window = [...sticky, ...shownLines];

    // "↓ N more" sits at the right edge and wins over the hint text on a narrow terminal.
    const more = this.offset > 0 ? `↓ ${this.offset} more ` : "";
    const room = Math.max(0, width - visibleWidth(more) - (more === "" ? 0 : 1));
    const hint = visibleWidth(HEADER) > room ? truncate(HEADER, room) : HEADER;
    const gap = " ".repeat(Math.max(0, width - visibleWidth(hint) - visibleWidth(more)));
    const out = [full(fg("dim", hint + gap + more)), ...window.map(full)];
    while (out.length < height) out.push(" ".repeat(outer));
    return out;
  }
}
