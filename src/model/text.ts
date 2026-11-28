// String and value helpers the model shares. Session data is untyped JSON written by many tools,
// so every reader goes through these instead of trusting a field's type.

const ESC = String.fromCodePoint(0x1b);

/**
 * Terminal control sequences: CSI (ESC "[" params intermediates final) and the two-byte
 * ESC + 0x40..0x5F forms other than "[". Built from a string so the source holds no raw ESC.
 */
const CONTROL_SEQUENCE = new RegExp(`${ESC}(?:\\[[0-9;?]*[ -/]*[@-~]|[@-Z\\\\\\]^_])`, "g");

/** Text with terminal escapes removed. The chat paints its own colours; a leftover escape would break a row. */
export function stripAnsi(text: string): string {
  return text.replace(CONTROL_SEQUENCE, "");
}

/** Past this many characters a one-line summary stops being glanceable, so it is cut. */
const SUMMARY_LIMIT = 200;

/** Whitespace runs folded to single spaces, trimmed, and cut at SUMMARY_LIMIT with an ellipsis. */
export function oneLine(value: string): string {
  const flat = value.replace(/\s+/g, " ").trim();
  if (flat.length <= SUMMARY_LIMIT) return flat;
  return `${flat.slice(0, SUMMARY_LIMIT)}…`;
}

/** A plain object: not null, not an array, not a scalar. */
export function isRecord(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== "object") return false;
  return !Array.isArray(v);
}

/** True for a string with something other than whitespace in it. */
export function hasText(v: unknown): v is string {
  return typeof v === "string" && v.trim() !== "";
}

/**
 * The readable text of a message's content. Pi stores either a bare string or a list of typed
 * blocks; only `text` blocks count here, and empty ones are skipped so they add no blank lines.
 */
export function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (isRecord(block) && block.type === "text" && typeof block.text === "string" && block.text !== "") parts.push(block.text);
  }
  return parts.join("\n");
}

/** Text split into lines, whatever line endings it was written with. */
export function splitLines(text: string): string[] {
  return text.replace(/\r\n?/g, "\n").split("\n");
}
