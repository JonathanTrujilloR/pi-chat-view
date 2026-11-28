// Runs of steps and how they are named. An agent often fires a dozen tool calls between two
// replies; drawn one per row they push the conversation off screen, so consecutive steps fold
// into one row that says what they were ("4 commands, 2 edits") and opens on demand.

import type { ChatItem, ChatToolCall } from "./items.ts";

type ToolItem = Extract<ChatItem, { kind: "tool" }>;

/**
 * Steps that never fold: handing work to another agent, and asking the person something. Both
 * are things the person needs to see happen, so each gets its own row and breaks the run around it.
 */
export function standsAlone(item: ChatItem): boolean {
  if (item.kind !== "tool") return false;
  return item.tool.kind === "task" || item.tool.kind === "question";
}

/** Tool calls and thinking are the material runs are made of. */
const foldable = (item: ChatItem) => (item.kind === "tool" || item.kind === "thinking") && !standsAlone(item);

/**
 * The items cut into groups: each group is either one item, or a run of `minRun` or more
 * consecutive foldable steps. Below three a fold saves a row or two and costs a keypress, and two
 * steps side by side still read fine, so shorter streaks stay as single items.
 */
export function groupRuns(items: readonly ChatItem[], minRun = 3): ChatItem[][] {
  const groups: ChatItem[][] = [];
  let start = 0;
  const closeStreak = (end: number) => {
    if (end - start >= minRun) groups.push(items.slice(start, end));
    else for (let k = start; k < end; k++) groups.push([items[k]!]);
  };
  for (let i = 0; i < items.length; i++) {
    if (foldable(items[i]!)) continue;
    closeStreak(i);
    groups.push([items[i]!]);
    start = i + 1;
  }
  closeStreak(items.length);
  return groups;
}

/** How many of a live run's newest steps stay visible; older ones collapse into one summary row. */
export const LIVE_TAIL = 6;

/** A run with a step still in flight is live, and live runs are shown open. */
export function isLive(items: readonly ChatItem[]): boolean {
  return items.some((item) => item.kind === "tool" && item.status === "running");
}

/** "1 edit", "3 edits". */
const count = (n: number, singular: string, pluralForm: string) => `${n} ${n === 1 ? singular : pluralForm}`;

/** Review steps are `other` calls, but common enough in Gentle sessions to be counted by name. */
const isReview = (call: ChatToolCall) => call.kind === "other" && call.badge?.label === "RDD";

/**
 * The phrases a run summary is built from, in the order they appear. Each phrase claims the
 * calls it counts; a call matches exactly one phrase.
 */
const TALLY: readonly { singular: string; plural: string; claims: (call: ChatToolCall) => boolean }[] = [
  { singular: "command", plural: "commands", claims: (c) => c.kind === "execute" },
  { singular: "edit", plural: "edits", claims: (c) => c.kind === "edit" },
  { singular: "read", plural: "reads", claims: (c) => c.kind === "read" },
  { singular: "search", plural: "searches", claims: (c) => c.kind === "search" || c.kind === "fetch" },
  { singular: "agent", plural: "agents", claims: (c) => c.kind === "task" },
  { singular: "rdd step", plural: "rdd steps", claims: isReview },
  { singular: "other step", plural: "other steps", claims: (c) => ["other", "question", "delete", "move"].includes(c.kind) && !isReview(c) },
];

/** A run as one phrase ("3 commands, 2 edits") plus how many of its calls failed or were refused. */
export function runSummary(items: readonly ChatItem[]): { summary: string; failed: number } {
  const calls = items.filter((item): item is ToolItem => item.kind === "tool");
  const phrases: string[] = [];
  for (const { singular, plural, claims } of TALLY) {
    const n = calls.filter((item) => claims(item.tool)).length;
    if (n > 0) phrases.push(count(n, singular, plural));
  }
  const failed = calls.filter((item) => item.status === "failed" || item.status === "denied").length;
  return { summary: phrases.join(", "), failed };
}

/**
 * A glyph followed by its gap. Terminals render ❀ wider than the single column Pi counts for it,
 * so it eats the following space; giving it two keeps a visible gap. Other glyphs get one.
 */
const withGap = (glyph: string) => glyph + (glyph === "❀" ? "  " : " ");

/** The marker beside a folded run with failures: "2 failed". */
export function failedLabel(n: number): string {
  return `${n} failed`;
}

/** The row standing in for a live run's hidden older steps: "4 earlier steps · 3 commands". */
export function earlierLabel(n: number, summary: string): string {
  return `${count(n, "earlier step", "earlier steps")} · ${summary}`;
}

/** A step in a few words. `mono` marks a machine subject (path, command, query) rather than prose. */
export interface StepLine {
  verb: string;
  subject: string;
  mono: boolean;
}

const firstLine = (text: string) => text.split("\n")[0] ?? "";
const machine = (verb: string, subject: string): StepLine => ({ verb, subject, mono: true });
const prose = (verb: string, subject: string): StepLine => ({ verb, subject, mono: false });

// `delete` and `move` share one variant (`kind: "delete" | "move"`), so match on overlap rather than equality.
type LineFor = { [K in ChatToolCall["kind"]]: (call: Extract<ChatToolCall, { kind: K }> | (ChatToolCall & { kind: K })) => StepLine };

const LINE_FOR: LineFor = {
  edit: (c) => machine("Edited", shortPath(c.path)),
  // A command the agent described is shown by its description: that is what the person can read.
  execute: (c) => (c.description ? prose("", c.description) : machine("$", firstLine(c.command))),
  read: (c) => machine("Read", shortPath(c.path)),
  search: (c) => machine("Searched", c.query),
  fetch: (c) => machine("Fetched", c.url),
  // Agent and tool names are the harness's own words, so they are shown untranslated.
  task: (c) => prose(`${c.agent ?? "Agent"}:`, c.summary),
  question: (c) => prose("❓ Question", firstLine(c.summary)),
  delete: (c) => machine("Deleted", shortPath(c.path)),
  move: (c) => machine("Moved", shortPath(c.path)),
  other: (c) => (c.badge !== undefined ? prose(withGap(c.badge.glyph) + c.badge.action, c.badge.subject) : prose(`${c.name}:`, firstLine(c.summary))),
};

export function stepLine(call: ChatToolCall): StepLine {
  return (LINE_FOR[call.kind] as (c: ChatToolCall) => StepLine)(call);
}

/** Where home folders live: Linux (/home/x, Fedora Atomic's /var/home/x), macOS (/Users/x), Windows (C:\Users\x). */
const HOME_PREFIXES = [/^(?:\/var\/home|\/home|\/Users)\/[^/]+/, /^[A-Za-z]:([\\/])Users\1[^\\/]+/];

/** A path with the user's home folder written as `~`, which is shorter and hides the account name. */
export function shortPath(p: string): string {
  return HOME_PREFIXES.reduce((path, home) => path.replace(home, "~"), p);
}
