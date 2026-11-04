// How many terminal rows the chat may take. Pure: the caller reads the live TUI and passes numbers.
//
// The chat is an overlay anchored at the top. It must never reach the bottom region (pending
// messages, status, widgets, Gentle's input box, footer): Collie finds Gentle's input box on screen,
// so covering it would break phone replies.

export type TuiMode = "regular" | "fullscreen";

/** Fewer rows than this and the chat is not worth drawing: the overlay hides instead. */
export const MIN_CHAT_ROWS = 3;

export interface ChatHeightInput {
  mode: TuiMode;
  termRows: number;
  /** Rows the transcript (`TUI.children[0]`) renders; read in regular mode only. */
  docRows: number;
  /** Rows of everything under the transcript (`TUI.children[1..]`). */
  bottomRows: number;
}

/**
 * Rows the chat may cover, or 0 when it should hide.
 *
 * Fullscreen: the bottom region is pinned to the last rows, the rest is the transcript viewport.
 * Regular: Pi draws the transcript and then the bottom region, and the screen shows the last
 * `termRows` of that, so a short transcript leaves the bottom region right under it.
 */
export function chatHeight({ mode, termRows, docRows, bottomRows }: ChatHeightInput): number {
  const rows = mode === "fullscreen" ? termRows - bottomRows : Math.min(docRows + bottomRows, termRows) - bottomRows;
  return rows < MIN_CHAT_ROWS ? 0 : rows;
}

export interface Renderable {
  render(width: number): string[];
}

/**
 * Rows `node` renders at `width`, counted only up to `cap`: past it the answer is `cap`, which is all
 * `chatHeight` needs (a transcript taller than the screen leaves the bottom region at the bottom). A
 * plain container (`isContainer`) is counted child by child and stops early, so a long transcript
 * costs a few children, not the whole of it. Anything else is rendered (pi-tui caches renders).
 */
export function countRows(node: Renderable, width: number, cap: number, isContainer?: (node: unknown) => boolean): number {
  const children = (node as { children?: unknown }).children;
  if (isContainer?.(node) !== true || !Array.isArray(children)) return Math.min(cap, node.render(width).length);
  let rows = 0;
  for (const child of children) {
    if (rows >= cap) break;
    if (child !== null && typeof child === "object" && typeof (child as Renderable).render === "function") {
      rows += countRows(child as Renderable, width, cap - rows, isContainer);
    }
  }
  return Math.min(cap, rows);
}

/**
 * Rows of everything under the transcript, or `undefined` when the TUI does not look like Pi's
 * (transcript first, then the bottom region). Undefined means "do not open": fail closed.
 */
export function measureBottom(children: readonly Renderable[] | undefined, width: number): number | undefined {
  if (!Array.isArray(children) || children.length < 2) return undefined;
  let rows = 0;
  for (const child of children.slice(1)) rows += child.render(width).length;
  return rows;
}
