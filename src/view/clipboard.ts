// Copying the chat's selected text, the way Pi copies its own.
//
// Pi's fullscreen TUI copies a selection with `copyTextToClipboard` (tui-alt-screen.js ~1236): its
// injected clipboard (native and platform tools) when the host gave one, else OSC 52, and it flashes
// "Copied!" itself. That method is internal, so it is duck typed; without it pi-tui's native
// clipboard, then a bare OSC 52 write, stand in.

/** The fields of pi-tui's TUI used to copy. */
export interface ClipboardHost {
  copyTextToClipboard?: unknown;
  terminal?: { write?: unknown };
}

/** pi-tui's `NativeClipboard`, as far as writing goes. */
export interface NativeClipboardLike {
  setText?(text: string): Promise<void>;
}

/** Which path copied the text: Pi's own (it showed "Copied!"), the native clipboard, OSC 52, or none. */
export type CopyPath = "pi" | "native" | "osc52";

/** UTF-8 text as base64, without Node's Buffer. */
function base64(text: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export async function copyToClipboard(text: string, host: ClipboardHost, native: NativeClipboardLike | undefined): Promise<CopyPath | undefined> {
  if (typeof host.copyTextToClipboard === "function") {
    try {
      if ((await host.copyTextToClipboard.call(host, text)) === true) return "pi";
    } catch {
      // Fall through to the next path.
    }
  }
  if (typeof native?.setText === "function") {
    try {
      await native.setText(text);
      return "native";
    } catch {
      // Fall through.
    }
  }
  const write = host.terminal?.write;
  if (typeof write === "function") {
    try {
      write.call(host.terminal, `\x1b]52;c;${base64(text)}\x07`);
      return "osc52";
    } catch {
      return undefined;
    }
  }
  return undefined;
}
