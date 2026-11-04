// The one place the view meets Pi: theme colours, Markdown and pi-tui's text helpers.
//
// Pi resolves these packages when it loads the extension; node tests cannot, so nothing else
// under src/ imports them.

import { getMarkdownTheme, highlightCode, type Theme } from "@earendil-works/pi-coding-agent";
import {
  Container,
  getCapabilities,
  getNativeClipboard,
  Image,
  Markdown,
  sliceByColumn,
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

import { ChatView } from "./chat-view.ts";
import { createRowsCache, renderChatRows, type RenderDeps } from "./render.ts";

/** Rendered markdown kept per width and text; a streaming reply changes text, so stale keys age out. */
const MAX_CACHED = 500;

/** A colour by token name, or the text unstyled when this Pi's theme has no such token. */
function paint(apply: () => string, text: string): string {
  try {
    return apply();
  } catch {
    return text;
  }
}

/** Image components kept, so an image keeps its Kitty id (and Pi its upload) across renders. */
const MAX_IMAGES = 64;
const images = new Map<string, Image>();

/**
 * An image as Kitty rows, or undefined. Kitty only: its sequence sits on the image's first row and
 * moves no cursor (C=1), so it composites into the overlay like any zero-width escape. iTerm2's puts
 * the sequence on the last row behind a cursor-up, which would drag the rest of the composited row
 * (Gentle's rail) up with it; Image's text fallback is never wanted, the chat has its own marker.
 */
function kittyImage(data: string, mimeType: string, maxWidthCells: number, width: number): string[] | undefined {
  try {
    if (getCapabilities().images !== "kitty") return undefined;
    // Identity by content without hashing megabytes: type, length and both ends.
    const key = `${mimeType}\0${data.length}\0${data.slice(0, 64)}\0${data.slice(-64)}\0${maxWidthCells}`;
    let image = images.get(key);
    if (image === undefined) {
      image = new Image(data, mimeType, { fallbackColor: (t: string) => t }, { maxWidthCells });
      if (images.size >= MAX_IMAGES) images.delete(images.keys().next().value!);
      images.set(key, image);
    } else {
      images.delete(key);
      images.set(key, image);
    }
    // Image draws at most `width - 2` columns; give it room for exactly `maxWidthCells`.
    const rows = image.render(Math.max(width, maxWidthCells) + 2);
    // A text fallback (e.g. a non-PNG with no transcoder) has no image sequence: use the chat's marker.
    return rows.length > 0 && rows[0]!.includes("\x1b_G") ? rows : undefined;
  } catch {
    return undefined;
  }
}

/** pi-tui's native clipboard, or undefined when it cannot load (no helper for this platform). */
export function piNativeClipboard() {
  try {
    return getNativeClipboard();
  } catch {
    return undefined;
  }
}

/**
 * `line` with columns [from, to) on the theme's selection background. Outside them the row keeps
 * its styles; inside, the selected text is drawn plain so its own resets cannot end the highlight.
 */
function selectionHighlight(theme: Theme, line: string, from: number, to: number): string {
  try {
    const before = sliceByColumn(line, 0, from, true);
    const mid = stripTerminalSequences(sliceByColumn(line, from, to - from, true));
    const after = sliceByColumn(line, to, Math.max(0, visibleWidth(line) - to), true);
    return `${before}\x1b[0m${paint(() => theme.bg("selectedBg", mid), `\x1b[7m${mid}\x1b[27m`)}\x1b[0m${after}`;
  } catch {
    return line;
  }
}

/** A component that renders exactly its children: pi-tui's Container, not a subclass drawing its own rows. */
export function isPlainContainer(node: unknown): boolean {
  try {
    return node instanceof Container && (node as Container).render === Container.prototype.render;
  } catch {
    return false;
  }
}

export function createPiChatView(theme: Theme): ChatView {
  const cache = new Map<string, string[]>();
  // Drawn groups: a live rebuild redraws the newest turn, not the session.
  const rows = createRowsCache();
  const deps: RenderDeps = {
    markdown: (text, width) => {
      const key = `${width}\0${text}`;
      const cached = cache.get(key);
      if (cached !== undefined) return [...cached];
      let lines: string[];
      try {
        lines = new Markdown(text, 0, 0, getMarkdownTheme()).render(width);
      } catch {
        // An unexpected Markdown API still shows the reply, as plain wrapped text.
        lines = wrapTextWithAnsi(text, width);
      }
      if (cache.size >= MAX_CACHED) cache.clear();
      cache.set(key, lines);
      return [...lines];
    },
    fg: (token, text) => paint(() => theme.fg(token as Parameters<Theme["fg"]>[0], text), text),
    bg: (token, text) => paint(() => theme.bg(token as Parameters<Theme["bg"]>[0], text), text),
    bold: (text) => paint(() => theme.bold(text), text),
    italic: (text) => paint(() => theme.italic(text), text),
    visibleWidth,
    truncate: (text, width) => truncateToWidth(text, width, "…"),
    wrap: (text, width) => wrapTextWithAnsi(text, width),
    image: kittyImage,
    // Pi's own highlighting, as in its transcript; an unknown language or an error gives plain lines.
    code: (code, lang) => {
      try {
        return typeof highlightCode === "function" ? highlightCode(code, lang === "" ? undefined : lang) : code.split("\n");
      } catch {
        return code.split("\n");
      }
    },
    // As Pi draws an open thinking block: italic Markdown in the theme's thinking colour.
    thinking: (text, width) => {
      try {
        return new Markdown(text, 0, 0, getMarkdownTheme(), { color: (t: string) => theme.fg("thinkingText", t), italic: true }).render(width);
      } catch {
        return wrapTextWithAnsi(text, width).map((l: string) => paint(() => theme.italic(theme.fg("thinkingText", l)), l));
      }
    },
  };
  return new ChatView({
    renderLines: (items, width, expanded, expansion) =>
      renderChatRows(items, width, deps, { now: new Date(), expanded, cache: rows, expansionVersion: expansion }),
    fg: deps.fg,
    visibleWidth,
    truncate: deps.truncate,
    // A theme change redraws everything.
    invalidate: () => {
      cache.clear();
      rows.clear();
    },
    plain: stripTerminalSequences,
    highlight: (line, from, to) => selectionHighlight(theme, line, from, to),
  });
}
