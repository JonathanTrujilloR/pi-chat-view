// An image from the chat, enlarged in a focused overlay over it (S24).
//
// A title row, the image as large as the overlay fits (aspect kept by the `image` dep), and a dim
// hint. Esc, alt+c or q close it, and so does any press on it. Pure: no Pi import, deps are injected.

import type { MouseEventLike, MouseResult } from "./chat-view.ts";

export const MODAL_HINT = "esc · click · alt+c to close";

/** An image's data, as the chat carries it. */
export interface ImageData {
  data: string;
  mimeType: string;
}

/** What the `image` dep draws: the rows, and when known its width in cells and its size in pixels. */
export interface ModalImage {
  rows: string[];
  columns?: number;
  size?: { widthPx: number; heightPx: number };
}

export interface ImageModalDeps {
  /** The image in at most `maxWidthCells` × `maxHeightCells` cells, or undefined when it cannot be drawn. */
  image(data: string, mimeType: string, maxWidthCells: number, maxHeightCells: number): ModalImage | undefined;
  fg(token: string, text: string): string;
  visibleWidth(text: string): number;
  truncate(text: string, width: number): string;
}

export interface ImageModalOptions {
  matchesKey(data: string, key: string): boolean;
  /** Rows the overlay may take. */
  height(): number;
  /** Close the modal; `viaMouse` when a press of its own did. */
  close(viaMouse: boolean): void;
}

const CLOSE_KEYS = ["escape", "alt+c", "q"];

export class ImageModal {
  private readonly image: ImageData;
  private readonly deps: ImageModalDeps;
  private readonly opts: ImageModalOptions;
  private cache: { width: number; height: number; lines: string[] } | undefined;

  constructor(image: ImageData, deps: ImageModalDeps, opts: ImageModalOptions) {
    this.image = image;
    this.deps = deps;
    this.opts = opts;
  }

  invalidate(): void {
    this.cache = undefined;
  }

  private drawn(width: number, height: number): ModalImage | undefined {
    try {
      const got = this.deps.image(this.image.data, this.image.mimeType, width, height);
      if (got === undefined || !Array.isArray(got.rows) || got.rows.length === 0 || got.rows.length > height) return undefined;
      if (got.rows.some((r) => typeof r !== "string" || this.deps.visibleWidth(r) > width)) return undefined;
      return got;
    } catch {
      return undefined;
    }
  }

  render(width: number): string[] {
    const height = Math.max(1, this.opts.height());
    if (this.cache?.width === width && this.cache.height === height) return this.cache.lines;
    const { fg, visibleWidth, truncate } = this.deps;
    const full = (line: string, left = 0) => {
      const pad = " ".repeat(Math.max(0, Math.min(left, width)));
      const fitted = visibleWidth(pad + line) > width ? truncate(pad + line, width) : pad + line;
      return fitted + " ".repeat(Math.max(0, width - visibleWidth(fitted)));
    };
    const centre = (text: string, token: string) => {
      const fitted = visibleWidth(text) > width ? truncate(text, width) : text;
      return full(fg(token, fitted), Math.floor((width - visibleWidth(fitted)) / 2));
    };
    const room = Math.max(1, height - 2);
    const got = this.drawn(width, room);
    const size = got?.size === undefined ? "" : ` · ${got.size.widthPx}×${got.size.heightPx}`;
    const title = centre(`🖼️ ${this.image.mimeType}${size}`, "accent");
    const body =
      got === undefined
        ? [centre("this image cannot be drawn here", "muted")]
        : got.rows.map((r) => full(r, got.columns === undefined ? 0 : Math.floor((width - got.columns) / 2)));
    const hint = centre(MODAL_HINT, "dim");
    const lines = height >= body.length + 2 ? [title, ...body, hint] : body.slice(0, height);
    this.cache = { width, height, lines };
    return lines;
  }

  handleInput(data: string): void {
    if (CLOSE_KEYS.some((key) => this.opts.matchesKey(data, key))) this.opts.close(false);
  }

  /**
   * Any press closes it. The release and click of the press that opened it land here first (it opens
   * under the pointer), so those alone are ignored.
   */
  handleMouse(event: MouseEventLike): MouseResult {
    if (event.type !== "press") return undefined;
    this.opts.close(true);
    return { handled: true };
  }
}
