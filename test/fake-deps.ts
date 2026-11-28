// Plain-text stand-ins for Pi's theme and pi-tui's text helpers. Colours are drawn as zero-width
// tags (`<error>✗</error>`), so a test can see which token a piece got and still measure width.

import type { RenderDeps } from "../src/view/render.ts";

const TAG = /<\/?[a-zA-Z]+>/g;
// Kitty graphics (APC) sequences are zero width, as pi-tui measures them.
const APC = /\x1b_[^\x1b]*\x1b\\/g;

export const strip = (s: string): string => s.replace(APC, "").replace(TAG, "");

function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (const word of para.split(" ")) {
      let w = word;
      while (w.length > width) {
        if (line !== "") out.push(line), (line = "");
        out.push(w.slice(0, width));
        w = w.slice(width);
      }
      if (line === "") line = w;
      else if (line.length + 1 + w.length <= width) line += ` ${w}`;
      else out.push(line), (line = w);
    }
    out.push(line);
  }
  return out;
}

export const deps: RenderDeps = {
  markdown: (text, width) => wrap(text, width),
  fg: (token, text) => `<${token}>${text}</${token}>`,
  bg: (token, text) => `<${token}>${text}</${token}>`,
  bold: (text) => `<b>${text}</b>`,
  italic: (text) => `<i>${text}</i>`,
  visibleWidth: (text) => [...strip(text)].length,
  truncate: (text, width) => ([...strip(text)].length <= width ? text : [...strip(text)].slice(0, width).join("")),
  wrap,
};

/** The fakes a ChatView needs to select and copy: plain text is the tags stripped. */
export const viewDeps = { ...deps, plain: strip };
