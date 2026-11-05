// Folding runs of steps, and one step in a few words. Ported from Collie's
// web/src/components/chat-cards.tsx (MIT); English strings from its i18n `en.ts`.

import type { ChatItem, ChatToolCall } from "./items.ts";

/**
 * A step that never folds: a subagent call and a question the agent put to the person. Folded in
 * with a dozen commands, both were out of sight, so each stands alone and splits the run around it.
 */
export function standsAlone(item: ChatItem): boolean {
  return item.kind === "tool" && (item.tool.kind === "task" || item.tool.kind === "question");
}

/**
 * Split the stream into single items and runs of consecutive tool and thinking items.
 *
 * `minRun` is where a run becomes a fold. Three by default: two steps side by side read as two
 * things that happened, and folding them buys a line and costs a keypress.
 */
export function groupRuns(items: readonly ChatItem[], minRun = 3): ChatItem[][] {
  const out: ChatItem[][] = [];
  let run: ChatItem[] = [];
  const flush = () => {
    if (run.length >= minRun) out.push(run);
    else for (const i of run) out.push([i]);
    run = [];
  };
  for (const item of items) {
    if (!standsAlone(item) && (item.kind === "tool" || item.kind === "thinking")) {
      run.push(item);
    } else {
      flush();
      out.push([item]);
    }
  }
  flush();
  return out;
}

/** A live run shows only its newest steps; the rest wait behind one summary row. */
export const LIVE_TAIL = 6;

/** True when a run has a step still running, which opens it. */
export function isLive(items: readonly ChatItem[]): boolean {
  return items.some((i) => i.kind === "tool" && i.status === "running");
}

/** "1 command" / "3 commands": a whole noun phrase per count. */
function plural(n: number, one: string, other: string): string {
  return `${n} ${n === 1 ? one : other}`;
}

/** What a step counts as in a summary: its kind, except Gentle's review steps, which are named. */
type Bucket = ChatToolCall["kind"] | "rdd";
const bucketOf = (call: ChatToolCall): Bucket => (call.kind === "other" && call.badge?.label === "RDD" ? "rdd" : call.kind);

/** Collie's summary parts, in its order: [kinds counted together, singular, plural]. */
const PARTS: readonly [readonly Bucket[], string, string][] = [
  [["execute"], "command", "commands"],
  [["edit"], "edit", "edits"],
  [["read"], "read", "reads"],
  [["search", "fetch"], "search", "searches"],
  [["task"], "agent", "agents"],
  [["rdd"], "rdd step", "rdd steps"],
  [["other", "question", "delete", "move"], "other step", "other steps"],
];

/** A run in one line ("3 commands, 2 edits") and how many of its steps failed or were denied. */
export function runSummary(items: readonly ChatItem[]): { summary: string; failed: number } {
  const tools = items.filter((i): i is Extract<ChatItem, { kind: "tool" }> => i.kind === "tool");
  const summary = PARTS.map(([kinds, one, other]) => [tools.filter((t) => kinds.includes(bucketOf(t.tool))).length, one, other] as const)
    .filter(([n]) => n > 0)
    .map(([n, one, other]) => plural(n, one, other))
    .join(", ");
  const failed = tools.filter((t) => t.status === "failed" || t.status === "denied").length;
  return { summary, failed };
}

/**
 * A glyph and the space after it. Terminal fonts draw ❀ (U+2740, one column to Pi) wider than one cell, so it
 * covers its space and reads "❀todo"; a second space keeps the gap visible. Other glyphs keep one space.
 */
const glyphGap = (glyph: string) => (glyph === "❀" ? `${glyph}  ` : `${glyph} `);

/** The badge beside a folded run: "2 failed". */
export function failedLabel(n: number): string {
  return `${n} failed`;
}

/** The row above a live run's tail: "4 earlier steps · 3 commands". */
export function earlierLabel(n: number, summary: string): string {
  return `${plural(n, "earlier step", "earlier steps")} · ${summary}`;
}

/** One step in a few words. `mono`: the subject is a path, command or query rather than prose. */
export interface StepLine {
  verb: string;
  subject: string;
  mono: boolean;
}

export function stepLine(call: ChatToolCall): StepLine {
  switch (call.kind) {
    case "edit":
      return { verb: "Edited", subject: shortPath(call.path), mono: true };
    case "execute":
      return call.description
        ? { verb: "", subject: call.description, mono: false }
        : { verb: "$", subject: call.command.split("\n")[0] ?? "", mono: true };
    case "read":
      return { verb: "Read", subject: shortPath(call.path), mono: true };
    case "search":
      return { verb: "Searched", subject: call.query, mono: true };
    case "fetch":
      return { verb: "Fetched", subject: call.url, mono: true };
    // An agent's name and a tool's own name are the harness's vocabulary, drawn as written.
    case "task":
      return { verb: `${call.agent ?? "Agent"}:`, subject: call.summary, mono: false };
    case "other":
      // Engram's tools read as Engram draws them: 🧠, its verb, what it saved or looked for.
      if (call.badge !== undefined) return { verb: `${glyphGap(call.badge.glyph)}${call.badge.action}`, subject: call.badge.subject, mono: false };
      return { verb: `${call.name}:`, subject: call.summary.split("\n")[0] ?? "", mono: false };
    case "question":
      return { verb: "❓ Question", subject: call.summary.split("\n")[0] ?? "", mono: false };
    case "delete":
      return { verb: "Deleted", subject: shortPath(call.path), mono: true };
    case "move":
      return { verb: "Moved", subject: shortPath(call.path), mono: true };
  }
}

/** A home directory folded to `~`: Linux (`/home/x`, `/var/home/x`), macOS (`/Users/x`), Windows (`C:\Users\x`). */
export function shortPath(p: string): string {
  return p.replace(/^(?:\/var\/home|\/home|\/Users)\/[^/]+/, "~").replace(/^[A-Za-z]:([\\/])Users\1[^\\/]+/, "~");
}
