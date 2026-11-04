// Chat view for Pi / Gentle Shell: the session as a Collie-style chat over the transcript rows,
// toggled with Terminal. Gentle's input box, widgets and footer stay where they are.
//
// Install: pi install git:github.com/JonathanTrujilloR/pi-chat-view

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";

import { createChatToggle, type ContextLike } from "./src/view/controller.ts";
import { createLiveFeed, LIVE_EVENTS, liveOptions, type LiveEvent } from "./src/view/live.ts";
import { createPiChatView, isPlainContainer, piNativeClipboard } from "./src/view/pi-deps.ts";

export default function chatView(pi: ExtensionAPI): void {
  // `chat` and `live` refer to each other: the feed rebuilds the open chat, the chat reads the feed.
  const live = createLiveFeed({ isOpen: () => chat.isOpen(), refresh: () => chat.refresh() });
  const chat = createChatToggle({
    createView: (theme) => createPiChatView(theme as Theme),
    matchesKey: (data, key) => matchesKey(data, key as Parameters<typeof matchesKey>[1]),
    liveOptions: (branch) => liveOptions(live.state, branch),
    onClose: () => live.stop(),
    nativeClipboard: piNativeClipboard,
    isContainer: isPlainContainer,
  });
  // SAFETY: ContextLike is a narrow structural slice of ExtensionContext (mode, sessionManager.getBranch,
  // ui.notify/onTerminalInput/custom); only the parameter shapes of `custom` differ, and the controller
  // passes Pi exactly what Pi's own signature accepts.
  const toggle = (ctx: ExtensionContext) => chat.toggle(ctx as unknown as ContextLike);

  pi.registerCommand("chat", {
    description: "Toggle Chat ⇄ Terminal",
    handler: async (_args: string, ctx: ExtensionCommandContext) => toggle(ctx),
  });
  pi.registerShortcut("alt+c", {
    description: "Toggle Chat ⇄ Terminal",
    handler: (ctx: ExtensionContext) => toggle(ctx),
  });
  // Registered once; the feed tracks streaming and running calls even while Chat is closed, so
  // opening mid-turn is right, and only rebuilds while it is open.
  for (const type of LIVE_EVENTS) {
    // SAFETY: every Pi event is an object with a string `type`; LiveEvent reads only `type`,
    // `message` and `toolCallId`, each checked at runtime by the live state.
    pi.on(type as "turn_end", (event: { type: string }) => live.onEvent(event as LiveEvent));
  }
  pi.on("session_shutdown", () => {
    chat.close();
    live.stop();
    live.state.reset();
  });
}
