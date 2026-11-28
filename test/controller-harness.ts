// The controller's test harness: a fake Pi context and TUI that record overlays, keys and renders.

import { ChatView } from "../src/view/chat-view.ts";
import { createChatToggle, type ContextLike, type ControllerDeps, type TuiLike } from "../src/view/controller.ts";
import { renderChatRows } from "../src/view/render.ts";
import { deps } from "./fake-deps.ts";

export const rows = (n: number) => ({ render: () => Array.from({ length: n }, () => "x") });

/** A `ctx.ui.custom` call after the chat's own: an image modal. */
export interface CustomCall {
  component: unknown;
  options: { overlay: true; overlayOptions: () => Record<string, unknown>; onHandle: (handle: { isFocused?(): boolean; unfocus?(): void }) => void };
  done: number;
  unfocused: number;
}

export function harness(opts: { mode?: string; tui?: Partial<TuiLike>; matches?: (data: string, id: string) => boolean; live?: ControllerDeps["liveOptions"]; onClose?: () => void; imageModal?: ControllerDeps["imageModal"] } = {}) {
  const notices: [string, string | undefined][] = [];
  const handlers: ((data: string) => { consume?: boolean } | undefined)[] = [];
  let unsubscribed = 0;
  let renders = 0;
  let doneCalls = 0;
  let overlayOptions: (() => Record<string, unknown>) | undefined;
  let view: ChatView | undefined;
  let resolve: (() => void) | undefined;
  const modals: CustomCall[] = [];
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
          let call: CustomCall | undefined;
          const component = factory(tui, {}, { matches: opts.matches }, () => {
            if (call !== undefined) {
              call.done++;
              res(undefined);
              return;
            }
            doneCalls++;
            resolve?.();
          });
          if (!(component instanceof ChatView)) {
            // Any other overlay is the image modal.
            call = { component, options, done: 0, unfocused: 0 };
            modals.push(call);
            options.onHandle({ isFocused: () => true, unfocus: () => void call!.unfocused++ });
            return;
          }
          resolve = () => res(undefined);
          overlayOptions = options.overlayOptions;
          view = component;
          options.onHandle({ isFocused: () => false });
        }),
    },
  };
  const chat = createChatToggle({
    createView: () => new ChatView({ ...deps, renderLines: (items, width, expanded) => renderChatRows(items, width, deps, { expanded }) }),
    matchesKey: (data, key) => data === key,
    liveOptions: opts.live,
    onClose: opts.onClose,
    imageModal: opts.imageModal,
  });
  const h = {
    chat,
    modals,
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
  return h;
}
