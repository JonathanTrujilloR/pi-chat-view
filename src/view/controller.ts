// Chat ⇄ Terminal: opens the chat as a non-capturing overlay over the transcript rows and closes it.
//
// Pure wiring: the Pi context, the TUI and the view factory are passed in, so the toggle, the
// sizing and the fail-closed rules are testable without Pi. `index.ts` supplies the real ones.

import { createItemsBuilder, type ItemsBuilder, type ItemsOptions, type SessionEntryLike } from "../model/items.ts";
import type { ChatView } from "./chat-view.ts";
import { gentleInsets, type Insets } from "./gentle-insets.ts";
import { chatHeight, countRows, measureBottom, type Renderable } from "./layout.ts";
import { hideImages, type ImageHandle } from "./pi-images.ts";
import { copyToClipboard, type NativeClipboardLike } from "./clipboard.ts";

const NO_INSETS: Insets = { top: 0, right: 0 };

export const UNAVAILABLE = "Chat view unavailable: unexpected Pi layout";
export const NEEDS_TUI = "Chat view needs Pi's interactive terminal";

/** The fields of pi-tui's `TUI` read here. */
export interface TuiLike {
  readonly mode?: string;
  children: readonly Renderable[];
  terminal: { rows: number; columns: number; write?: unknown };
  requestRender(): void;
  /** Fullscreen only: where Pi's own transcript is scrolled (`viewportTop` in Pi 1.4, `scrollTop` before), and whether it follows the end. */
  readonly viewportTop?: number;
  readonly scrollTop?: number;
  readonly isFollowingOutput?: boolean;
  /** Fullscreen only: Pi's own selection copy (internal, duck typed) and its copy-on-select setting. */
  copyTextToClipboard?: unknown;
  getCopyOnSelect?: unknown;
}

export interface KeybindingsLike {
  matches?(data: string, id: string): boolean;
}

export interface OverlayHandleLike {
  isFocused?(): boolean;
  unfocus?(): void;
}

/** The fields of Pi's `ExtensionContext` read here. */
export interface ContextLike {
  mode?: string;
  sessionManager: { getBranch(): readonly unknown[] };
  ui: {
    notify(message: string, type?: "info" | "warning" | "error"): void;
    onTerminalInput(handler: (data: string) => { consume?: boolean } | undefined): () => void;
    custom(
      factory: (tui: TuiLike, theme: unknown, keybindings: KeybindingsLike, done: (result: undefined) => void) => ChatView,
      options: { overlay: true; overlayOptions: () => Record<string, unknown>; onHandle: (handle: OverlayHandleLike) => void },
    ): Promise<unknown>;
  };
}

export interface ControllerDeps {
  createView(theme: unknown): ChatView;
  matchesKey(data: string, key: string): boolean;
  /** What is streaming and running now, for this branch (see `live.ts`). */
  liveOptions?(branch: readonly SessionEntryLike[]): ItemsOptions;
  /** Called once each time Chat closes, to stop live timers. */
  onClose?(): void;
  /** pi-tui's native clipboard, for copying a chat selection when Pi's own copy is not there. */
  nativeClipboard?(): NativeClipboardLike | undefined;
  /**
   * True for a component that renders exactly its children, one after another (pi-tui's own
   * Container). Lets regular mode count the transcript's rows without drawing all of it.
   */
  isContainer?(node: unknown): boolean;
}

/**
 * Keys the chat takes while it is on screen, by Pi's ids with their default keys as the fallback:
 * the fullscreen transcript's scroll keys, and Pi's own "expand thinking / tool output" toggles.
 */
const KEYS: readonly [string, string, (v: ChatView) => void][] = [
  ["tui.altScreen.pageUp", "pageUp", (v) => v.pageUp()],
  ["tui.altScreen.pageDown", "pageDown", (v) => v.pageDown()],
  ["tui.altScreen.top", "ctrl+home", (v) => v.top()],
  ["tui.altScreen.bottom", "ctrl+end", (v) => v.bottom()],
  ["app.thinking.toggle", "ctrl+t", (v) => v.toggleAllThinking()],
  ["app.tools.expand", "ctrl+o", (v) => v.toggleAllTools()],
];

interface Session {
  ctx: ContextLike;
  tui?: TuiLike;
  view?: ChatView;
  done?: (result: undefined) => void;
  unsubscribe?: () => void;
  /** Rows from the last measure; 0 hides the overlay. */
  height: number;
  /** Gentle's header rows and rail columns from the last measure (see gentle-insets.ts). */
  insets: Insets;
  /** Pi's transcript `scrollTop` when last seen, to follow its scrolling (see `followPiScroll`). */
  piScrollTop?: number;
  /** Whether Pi's transcript followed its end when last seen: only a change to following moves the chat. */
  piFollowing?: boolean;
  /** Pi's transcript images switched off while Chat is open (see pi-images.ts). */
  images?: ImageHandle;
  /** Items of the branch, kept between rebuilds: a live rebuild folds in only the new entries. */
  builder: ItemsBuilder;
}

export interface ChatToggle {
  isOpen(): boolean;
  toggle(ctx: ContextLike): void;
  close(): void;
  /** Reload the items from the active branch and redraw. */
  refresh(): void;
}

export function createChatToggle(deps: ControllerDeps): ChatToggle {
  let session: Session | undefined;

  const itemsOf = (s: Session) => {
    const branch = s.ctx.sessionManager.getBranch() as readonly SessionEntryLike[];
    return s.builder.build(branch, deps.liveOptions?.(branch));
  };

  /** Rows the chat may take right now and Gentle's chrome around it, or undefined when the layout is not Pi's. */
  const measure = (s: Session): { height: number; insets: Insets } | undefined => {
    const tui = s.tui;
    if (tui === undefined || (tui.mode !== "regular" && tui.mode !== "fullscreen")) return undefined;
    const { rows, columns } = tui.terminal;
    const insets = gentleInsets(tui.terminal, columns, tui.mode);
    // With Gentle's rail painting, the bottom region lives in the editor column and wraps at its width.
    const width = columns - insets.right;
    const bottomRows = measureBottom(tui.children, width);
    if (bottomRows === undefined) return undefined;
    // Regular mode: only a transcript shorter than the screen matters, so it is counted up to the screen's height.
    const docRows = tui.mode === "regular" ? countRows(tui.children[0]!, width, rows, deps.isContainer) : 0;
    const height = chatHeight({ mode: tui.mode, termRows: rows - insets.top, docRows, bottomRows });
    return { height, insets };
  };

  /**
   * In fullscreen Pi keeps PgUp/PgDn and ctrl+home/end for its own transcript: they reach only a focused
   * component, and the chat never takes focus. So the chat follows that transcript, hidden under it:
   * the lines Pi scrolled move the chat as many, its top is the chat's top, and following the end again
   * follows the chat's end. The wheel stays the chat's own.
   *
   * While Pi follows its end, new output moves its viewport too; that is not the reader scrolling, so
   * it must not move the chat (wheeled up in Chat during a working turn, the reader stays put).
   * Only Pi starting to follow again (ctrl+end) sends the chat to its end, and only Pi's moves while
   * it is not following (PgUp/PgDn, ctrl+home) scroll the chat.
   */
  const followPiScroll = (s: Session) => {
    const top = s.tui?.viewportTop ?? s.tui?.scrollTop;
    if (typeof top !== "number" || s.view === undefined) return;
    const following = s.tui?.isFollowingOutput === true;
    const was = s.piFollowing;
    const last = s.piScrollTop;
    s.piScrollTop = top;
    s.piFollowing = following;
    if (last === undefined) return;
    if (following) {
      if (was === false) s.view.bottom();
      return;
    }
    if (last === top) return;
    if (top === 0) s.view.top();
    else s.view.scrollBy(top - last);
  };

  const remeasure = (s: Session): number => {
    const m = measure(s);
    s.height = m?.height ?? 0;
    s.insets = m?.insets ?? NO_INSETS;
    if (s.view !== undefined) s.view.targetHeight = s.height;
    followPiScroll(s);
    return s.height;
  };

  const release = (s: Session) => {
    s.unsubscribe?.();
    s.unsubscribe = undefined;
    if (s.images !== undefined) {
      s.images.restore();
      s.images = undefined;
      s.tui?.requestRender();
    }
    if (session !== s) return;
    session = undefined;
    deps.onClose?.();
  };

  const close = () => {
    const s = session;
    if (s === undefined) return;
    release(s);
    s.done?.(undefined);
  };

  const onKey = (s: Session, keybindings: KeybindingsLike) => (data: string) => {
    // Only while the chat is on screen: hidden, the keys belong to Pi again.
    if (session !== s || s.view === undefined || s.height <= 0) return undefined;
    // Escape drops a chat selection; with none, it is Pi's (and Gentle's) as always.
    if (s.view.hasSelection() && (keybindings.matches?.(data, "tui.select.cancel") === true || deps.matchesKey(data, "escape"))) {
      s.view.clearSelection();
      s.tui?.requestRender();
      return { consume: true };
    }
    for (const [id, key, act] of KEYS) {
      if (keybindings.matches?.(data, id) === true || deps.matchesKey(data, key)) {
        act(s.view);
        s.tui?.requestRender();
        return { consume: true };
      }
    }
    return undefined;
  };

  const open = (ctx: ContextLike) => {
    if (ctx.mode !== "tui") {
      ctx.ui.notify(NEEDS_TUI, "warning");
      return;
    }
    const s: Session = { ctx, height: 0, insets: NO_INSETS, builder: createItemsBuilder() };
    session = s;
    const shown = ctx.ui.custom(
      (tui, theme, keybindings, done) => {
        s.tui = tui;
        s.done = done;
        const view = deps.createView(theme);
        s.view = view;
        // A drag over chat text copies it as Pi copies its own selection (copy-on-select, on by default).
        view.onCopy = (text, lines) => {
          if (typeof tui.getCopyOnSelect === "function" && tui.getCopyOnSelect.call(tui) === false) return;
          void copyToClipboard(text, tui, deps.nativeClipboard?.()).then((path) => {
            // Pi's own path already said "Copied!"; the others say it here.
            if (path === "native" || path === "osc52") ctx.ui.notify(`Copied ${lines} line${lines === 1 ? "" : "s"}`, "info");
          });
        };
        view.setItems(itemsOf(s));
        if (measure(s) === undefined) {
          // Fail closed: say so, draw nothing, and leave Terminal as it was.
          ctx.ui.notify(UNAVAILABLE, "error");
          queueMicrotask(() => {
            if (session === s) close();
            else done(undefined);
          });
          return view;
        }
        remeasure(s);
        // Terminal images would show through the chat: Pi's cards stop drawing them until it closes.
        s.images = hideImages(tui.children[0]);
        if (s.images.count > 0) tui.requestRender();
        s.unsubscribe = ctx.ui.onTerminalInput(onKey(s, keybindings));
        return view;
      },
      {
        overlay: true,
        // Pi calls this ONCE, when the overlay is shown, and keeps the object (interactive-mode.js resolveOptions).
        // pi-tui reads its fields on every frame, after `visible()` has re-measured, so the size and place are
        // getters: a resize (zooming the terminal) moves the chat with the bottom region and Gentle's chrome.
        overlayOptions: () => {
          remeasure(s);
          return {
            anchor: "top-left",
            // Below Gentle's header and left of its Status rail, like the transcript it covers.
            get row() {
              return s.insets.top;
            },
            col: 0,
            get width() {
              return s.insets.right > 0 ? (s.tui?.terminal.columns ?? 0) - s.insets.right : "100%";
            },
            get maxHeight() {
              return Math.max(1, s.height);
            },
            margin: 0,
            // Keyboard focus stays in Gentle's editor: Collie keeps finding and typing into it.
            nonCapturing: true,
            visible: () => session === s && remeasure(s) > 0,
          };
        },
        onHandle: (handle) => {
          if (handle.isFocused?.() === true) handle.unfocus?.();
        },
      },
    );
    void shown.finally(() => release(s));
  };

  return {
    isOpen: () => session !== undefined,
    toggle: (ctx) => (session === undefined ? open(ctx) : close()),
    close,
    refresh: () => {
      const s = session;
      if (s?.view === undefined) return;
      s.images?.sweep();
      s.view.setItems(itemsOf(s));
      s.tui?.requestRender();
    },
  };
}
