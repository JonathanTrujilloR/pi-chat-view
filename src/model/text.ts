// Small string helpers shared by the model. Ported from Collie's bridge/journal/text.ts (MIT).

// CSI/SGR and two-character escapes. ESC is spliced in from its code point so the regex literal
// does not carry a raw control character.
const ESC = String.fromCodePoint(0x1b);
const ANSI_RE = new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]|${ESC}[@-Z\\\\-_]`, "g");

/** Strip terminal escapes. Session text is drawn by us, so a stray escape would corrupt the row. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

/** Longest one-line tool summary. Past this the line stops being a summary. */
const MAX_SUMMARY_CHARS = 200;

/** Collapse to a single capped line. */
export function oneLine(value: string): string {
  const line = value.replace(/\s+/g, " ").trim();
  return line.length > MAX_SUMMARY_CHARS ? `${line.slice(0, MAX_SUMMARY_CHARS)}…` : line;
}

/** A plain object, as opposed to null, an array or a scalar. */
export function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Flatten a Pi content value (a string or a block list) into its `text` blocks. */
export function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => (isRecord(b) && b.type === "text" && typeof b.text === "string" ? b.text : ""))
    .filter(Boolean)
    .join("\n");
}
