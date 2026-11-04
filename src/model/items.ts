// Pi session entries as the blocks the chat draws.
//
// Ported from Collie's Pi reducer (bridge/journal/pi.ts) and chat items (web/src/lib/chat-items.ts),
// MIT. Collie reads the whole append-only log and tracks rewinds itself; here the input is
// `sessionManager.getBranch()`, which is already the active branch, so there is no chain to keep.
//
// Pure: no Pi, no TUI, no clock. Every rule in it is table-testable.

import { classifyToolCall, rddSummary, type ToolCall } from "./tool-call.ts";
import { isRecord, stripAnsi, textOf } from "./text.ts";

/** What became of a tool call. "denied" is not "failed": nothing went wrong, somebody said no. */
export type ChatToolStatus = "running" | "done" | "failed" | "denied";

/** One line of an edit's diff. `@` is a hunk header, or an empty separator between edits. */
export interface DiffLine {
  op: "+" | "-" | " " | "@";
  text: string;
}

/**
 * A call plus what it printed, on the kinds whose card can show output. `outputLines` is the whole
 * output's line count, present only when `output` was cut. `diff` and `write` are an edit's card:
 * what changed, and whether the call wrote a whole file rather than replacing text in it.
 */
/** An image block as Pi stored it, kept by reference so the base64 data is never copied. */
export interface ImageData {
  data: string;
  mimeType: string;
}

export type ChatToolCall = ToolCall & {
  output?: string;
  outputLines?: number;
  diff?: DiffLine[];
  write?: true;
  images?: number;
  imageData?: ImageData[];
  /** A question's chosen labels, one list per question in order (Gentle's `details.answers`). */
  chosen?: string[][];
  /** Why a question failed (never reached the person): the first line of its error. */
  failure?: string;
};

/** One block of the chat. `ts` is the entry's ISO timestamp. */
export type ChatItem =
  // `images`: how many images came with it. The chat marks them; Terminal draws them.
  // `imageData`: the drawable ones among them.
  | { id: string; ts?: string; kind: "user"; text: string; images?: number; imageData?: ImageData[] }
  // `partial`: still streaming; the view draws a cursor at its end until the flag goes.
  | { id: string; ts?: string; kind: "reply"; text: string; partial?: true }
  | { id: string; ts?: string; kind: "thinking"; text: string; partial?: true }
  // `title`: a notice with a heading of its own (a background job): folded to it, opened to the whole text.
  // `label`: the glyph and name the notice starts with ("❀  Agent result"), drawn in colour.
  | { id: string; ts?: string; kind: "notice"; text: string; title?: string; error?: true; label?: string }
  // `text` is the model's recap; the view decides whether to show it.
  | { id: string; ts?: string; kind: "compacted"; text?: string }
  // `ts` is when the call was made (its assistant message); `end` when its result was stored.
  | { id: string; ts?: string; end?: string; kind: "tool"; tool: ChatToolCall; status: ChatToolStatus };

/** The fields of a Pi session entry this module reads. */
export interface SessionEntryLike {
  type: string;
  id: string;
  parentId?: string | null;
  timestamp?: string;
  message?: unknown;
  summary?: unknown;
  customType?: unknown;
  content?: unknown;
  display?: unknown;
  details?: unknown;
  /** A `custom` entry's own data (extension state; only Gentle's stale agent result is drawn). */
  data?: unknown;
}

/**
 * Gentle's internal steps: bookkeeping between its harness and the model, not work the person follows.
 * They make no chat item, so they are neither drawn nor counted; Terminal still shows them.
 */
export const HIDDEN_TOOLS: ReadonlySet<string> = new Set([
  "gentle_odd_phase",
  "orchestrator_session_id",
  "orchestrator_list",
  "orchestrator_consult",
  "orchestrator_send_message",
  "job_list",
  "job_stop",
  "subagent_list_tasks",
  "subagent_list_agents",
  "subagent_status",
]);

/** True for a tool the chat leaves out: one of HIDDEN_TOOLS, or any other `orchestrator_*` tool. */
export function isHiddenTool(name: string): boolean {
  return HIDDEN_TOOLS.has(name) || name.startsWith("orchestrator_");
}

/** A Pi `AssistantMessage` mid-stream, as `message_update` carries it. */
export interface StreamingMessage {
  role?: string;
  content?: unknown;
  timestamp?: number;
}

export interface ItemsOptions {
  /** The assistant message still being written; appended with `partial` on its text. */
  streaming?: StreamingMessage;
  /**
   * Calls the live layer saw start and not end. When given, an unresolved call that is neither in
   * it nor in the newest assistant turn will never get a result (a crash, a reload) and is drawn
   * failed. Without it every unresolved call is running, as in Collie.
   */
  runningToolCallIds?: ReadonlySet<string>;
}

/** Most characters of tool output kept on an item: about the 200 lines the output card shows. */
export const MAX_OUTPUT_CHARS = 16000;

/** Most diff lines kept on an item. The card shows 40; the rest is only counted. */
const MAX_DIFF_LINES = 2000;

/** Kinds whose card can show what the call printed; edit, read and delete have nothing to print. */
const WITH_OUTPUT = new Set<ToolCall["kind"]>(["execute", "search", "fetch", "task", "other"]);

/**
 * Pi's own wording for a refused call, and only Pi's: an extension that blocks writes
 * `reason || "Tool execution was blocked"`. An extension's own reason is arbitrary prose and
 * degrades to a plain failure, as in Collie.
 */
const PI_BLOCKED = /^Tool execution was blocked/;

/** How Pi ends a failed `bash` result. Its absence on a non-error result means exit 0. */
const PI_EXIT_STATUS = /(?:^|\n)Command exited with code (\d+)\s*$/;

/** Stop reasons that end a turn badly. `stop` and `toolUse` are normal and stay silent. */
const STOPPED_BADLY = new Set(["error", "aborted"]);

type ToolItem = Extract<ChatItem, { kind: "tool" }>;

function tsOf(ms: unknown): string | undefined {
  return typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

/** One answer's labels: a string, a list of strings, OmO's `{ answers: [...] }`, or Gentle's `{ answer }`. */
function answerLabels(v: unknown): string[] {
  if (typeof v === "string") return v.trim() === "" ? [] : [v.trim()];
  if (Array.isArray(v)) return v.filter((l): l is string => typeof l === "string" && l.trim() !== "").map((l) => l.trim());
  if (!isRecord(v)) return [];
  // Gentle's multi-select answer is `{ kind: "multi", answer: null, selected: [...] }`.
  const picked = [...answerLabels(v.answer), ...answerLabels(v.selected)];
  return picked.length > 0 ? picked : answerLabels(v.answers);
}

/** Gentle's ask_user_question writes `{ questionIndex, question, kind, answer }` entries; put them in question order. */
function byQuestionIndex(answers: unknown[]): unknown[] {
  const indexed = answers.every((a) => isRecord(a) && typeof a.questionIndex === "number");
  if (!indexed) return answers;
  const ordered: unknown[] = [];
  for (const a of answers as Record<string, unknown>[]) ordered[a.questionIndex as number] = a;
  return ordered;
}

/**
 * The chosen labels of a question call, as Collie reads `details.answers`: a list per question in
 * question order, or an object keyed by the question's text. "Postgres · cache, queue", or
 * `undefined` when nothing was chosen.
 */
function chosenOf(call: Extract<ToolCall, { kind: "question" }>, details: unknown): string[][] | undefined {
  const answers = isRecord(details) ? details.answers : undefined;
  let lists: string[][] = [];
  if (Array.isArray(answers)) lists = Array.from(byQuestionIndex(answers), answerLabels);
  else if (isRecord(answers)) lists = call.questions.map((q) => answerLabels(answers[q.question]));
  return lists.some((l) => l.length > 0) ? lists : undefined;
}

const joinChosen = (lists: string[][]) => lists.map((l) => l.join(", ")).filter(Boolean).join(" · ");

const lines = (text: string) => text.replace(/\r\n?/g, "\n").split("\n");

/** A field holding text, under any of its spellings. */
function textField(o: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const k of keys) if (typeof o[k] === "string") return o[k] as string;
  return undefined;
}

/**
 * The diff an edit call asks for, from its own arguments: Pi's `edits[]` of `oldText` / `newText`,
 * a single `old_string` / `new_string` pair, or a `content` write (all added). The fallback when the
 * result carries no diff; context lines are unknown here, so there are none.
 */
function diffFromArgs(args: unknown): { diff: DiffLine[]; write?: true } | undefined {
  if (!isRecord(args)) return undefined;
  const pairs: Record<string, unknown>[] = Array.isArray(args.edits) ? args.edits.filter(isRecord) : [args];
  const diff: DiffLine[] = [];
  for (const e of pairs) {
    const before = textField(e, "oldText", "old_string", "oldString");
    const after = textField(e, "newText", "new_string", "newString");
    if (before === undefined && after === undefined) continue;
    if (diff.length > 0) diff.push({ op: "@", text: "" });
    if (before !== undefined && before !== "") for (const l of lines(before)) diff.push({ op: "-", text: l });
    if (after !== undefined && after !== "") for (const l of lines(after)) diff.push({ op: "+", text: l });
  }
  if (diff.length > 0) return { diff: diff.slice(0, MAX_DIFF_LINES) };
  const content = textField(args, "content");
  if (content === undefined) return undefined;
  return { diff: lines(content).slice(0, MAX_DIFF_LINES).map((text) => ({ op: "+", text })), write: true };
}

/**
 * The diff Pi stored on an edit result: `details.patch` (a unified patch) first, as Collie reads it,
 * else `details.diff` (Pi's display diff: each line a sign, then a line number and the text).
 */
function diffFromDetails(details: unknown): DiffLine[] | undefined {
  if (!isRecord(details)) return undefined;
  const out: DiffLine[] = [];
  if (typeof details.patch === "string" && details.patch.trim() !== "") {
    for (const l of lines(stripAnsi(details.patch))) {
      if (/^(---|\+\+\+|diff |index |\\ )/.test(l)) continue;
      if (l.startsWith("@@")) out.push({ op: "@", text: l });
      else if (l.startsWith("+") || l.startsWith("-")) out.push({ op: l[0] as "+" | "-", text: l.slice(1) });
      else if (l.startsWith(" ")) out.push({ op: " ", text: l.slice(1) });
    }
  } else if (typeof details.diff === "string" && details.diff.trim() !== "") {
    for (const l of lines(stripAnsi(details.diff))) {
      const op = l[0] === "+" || l[0] === "-" ? l[0] : " ";
      out.push({ op, text: l[0] === "+" || l[0] === "-" || l[0] === " " ? l.slice(1) : l });
    }
  }
  return out.length > 0 ? out.slice(0, MAX_DIFF_LINES) : undefined;
}

/** Fold a `toolResult` onto the call it answers. Mutates the item, which already sits in the list. */
/** How many image blocks a content value holds. */
function imageCount(content: unknown): number {
  return Array.isArray(content) ? content.filter((b) => isRecord(b) && b.type === "image").length : 0;
}

/** The image blocks of a content value that can be drawn: string data and MIME type. The blocks themselves. */
function imageBlocks(content: unknown): ImageData[] {
  if (!Array.isArray(content)) return [];
  return content.filter((b): b is ImageData => isRecord(b) && b.type === "image" && typeof b.data === "string" && b.data !== "" && typeof b.mimeType === "string");
}

function attach(item: ToolItem, text: string, isError: boolean, details?: unknown, content?: unknown): void {
  const images = imageCount(content);
  if (images > 0) item.tool.images = images;
  const data = imageBlocks(content);
  if (data.length > 0) item.tool.imageData = data;
  item.status = isError ? (PI_BLOCKED.test(text) ? "denied" : "failed") : "done";
  const call = item.tool;
  // Gentle's review card shows how the call came back; the step does too.
  if (call.kind === "other" && call.badge?.label === "RDD") {
    const parts = rddSummary(text);
    call.badge = parts === undefined ? { ...call.badge } : { ...call.badge, result: parts[0]!, summary: parts.join(" · ") };
  }
  if (call.kind === "execute") {
    const exit = PI_EXIT_STATUS.exec(text);
    if (exit !== null) call.exitCode = Number(exit[1]);
    else if (!isError) call.exitCode = 0;
  }
  if (call.kind === "question") {
    // The answer, from `details` when the tool recorded it, else the result's own words. A
    // dismissed or failed question has no answer to show; a failed one keeps why, in one line.
    if (isError) {
      const why = text.trim().split("\n")[0]?.trim();
      if (why) (call as ChatToolCall).failure = why.slice(0, 500);
      return;
    }
    const chosen = chosenOf(call, details);
    if (chosen !== undefined) (call as ChatToolCall).chosen = chosen;
    // ask_user_choice answers in its text: "User selected: 1. Porcentaje (value: porcentaje)" -> "Porcentaje".
    const picked = chosen === undefined ? /^User selected: (?:\d+\. )?(.+?)(?: \(value: [^)]*\))?$/.exec(text.trim())?.[1] : undefined;
    if (picked !== undefined) (call as ChatToolCall).chosen = call.questions.map((_q, i) => (i === 0 ? [picked] : []));
    const answer = chosen !== undefined ? joinChosen(chosen) : picked ?? (isRecord(details) && details.answers !== undefined ? undefined : text.trim());
    if (answer !== undefined && answer !== "") call.output = answer.slice(0, MAX_OUTPUT_CHARS);
    return;
  }
  if (call.kind === "edit") {
    const diff = diffFromDetails(details);
    if (diff !== undefined) call.diff = diff;
  }
  // A failure's text is why it failed, whatever the kind; a refusal is drawn by its status alone.
  if ((WITH_OUTPUT.has(call.kind) || item.status === "failed") && text.trim() !== "") {
    call.output = text.slice(0, MAX_OUTPUT_CHARS);
    if (text.length > MAX_OUTPUT_CHARS) call.outputLines = lines(text.trimEnd()).length;
  }
}

/** The one line a desk `!command` leaves: the command, plus how it ended when that was badly. */
function bashNotice(m: Record<string, unknown>): string | undefined {
  const command = typeof m.command === "string" ? m.command.trim() : "";
  if (command === "") return undefined;
  const line = `$ ${command.split("\n")[0]}`;
  if (m.cancelled === true) return `${line} · cancelled`;
  if (typeof m.exitCode === "number" && m.exitCode !== 0) return `${line} · exit ${m.exitCode}`;
  return line;
}

/**
 * A message an extension sent in the user's role, saying so in its own opening bracket: Gentle Agents' wake is
 * "[System-generated Gentle Agents notification, not written by the user] Subagent output was delivered…
 * [gentle-agents wake: <id>]". Returns the sender and sentence, or undefined for a message the user wrote.
 */
const SYSTEM_USER = /^\[System-generated (.+?) notification, not written by the user\]\s*/;

function systemNotice(text: string): string | undefined {
  const m = SYSTEM_USER.exec(text);
  if (m === null) return undefined;
  const body = text.slice(m[0].length).replace(/(\s*\[[^\]]*\])+\s*$/, "").trim();
  return body === "" ? m[1]! : `${m[1]} · ${body}`;
}

/**
 * The content blocks of a user or assistant message, one item per block. Ids are
 * `<prefix>:<block index>` except a tool call, which keeps its own id so a result can find it.
 */
function blockItems(
  content: unknown,
  prefix: string,
  ts: string | undefined,
  user: boolean,
  partial: boolean,
  calls: Map<string, ToolItem>,
  hidden?: Set<string>,
): ChatItem[] {
  const blocks: unknown[] = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : [];
  const grows = partial ? ({ partial: true } as const) : {};
  const items: ChatItem[] = [];
  blocks.forEach((b, i) => {
    if (!isRecord(b)) return;
    const id = `${prefix}:${i}`;
    if (b.type === "text" && typeof b.text === "string" && b.text.trim() !== "") {
      const text = stripAnsi(b.text);
      // An extension's wake-up sent in the user's role (Gentle Agents under claude-bridge) is not drawn: Gentle
      // hides it everywhere else, and the notice it follows already says what arrived.
      if (user && systemNotice(text) !== undefined) return;
      items.push(user ? { id, ts, kind: "user", text } : { id, ts, kind: "reply", text, ...grows });
    } else if (!user && b.type === "thinking" && typeof b.thinking === "string" && b.thinking.trim() !== "") {
      items.push({ id, ts, kind: "thinking", text: stripAnsi(b.thinking), ...grows });
    } else if (!user && b.type === "toolCall") {
      const name = typeof b.name === "string" ? b.name : "tool";
      if (isHiddenTool(name)) {
        // Remembered so its result attaches to nothing instead of turning into an orphan row.
        if (typeof b.id === "string") hidden?.add(b.id);
        return;
      }
      const item: ToolItem = { id: typeof b.id === "string" ? b.id : id, ts, kind: "tool", tool: classifyToolCall(name, b.arguments), status: "running" };
      if (item.tool.kind === "edit") {
        const asked = diffFromArgs(b.arguments);
        if (asked !== undefined) Object.assign(item.tool, asked);
      }
      if (typeof b.id === "string") calls.set(b.id, item);
      items.push(item);
    }
  });
  return items;
}

/**
 * What the reducer keeps between entries. A tool item is never changed in place: when its result
 * arrives it is replaced by an updated copy, so an item object, once handed out, keeps its content
 * and a renderer may cache by identity.
 */
interface ReducerState {
  items: ChatItem[];
  /** Calls without a result yet, by call id. */
  calls: Map<string, ToolItem>;
  /** Where each unresolved call sits in `items`. */
  at: Map<ToolItem, number>;
  /** Call ids of the newest assistant turn: still queued behind the one running, never stale. */
  newest: Set<string>;
  /** Call ids of hidden steps whose result has not come yet. */
  hidden: Set<string>;
}

const newState = (): ReducerState => ({ items: [], calls: new Map(), at: new Map(), newest: new Set(), hidden: new Set() });

/**
 * A displayed custom message as a notice, with the label Gentle's own renderer gives it: its review
 * preflight ("✿ Gentle AI · review preflight") and its agents' cards (extensions/gentle-agents.ts,
 * glyph ❀). Any other type is its text as it is. Empty text stays empty, so no notice is drawn.
 */
function customNotice(type: unknown, raw: string, details: unknown): string {
  const text = raw.trim();
  if (text === "") return raw;
  const ga = isRecord(details) && isRecord(details.gentleAgents) ? details.gentleAgents : undefined;
  const agent = typeof ga?.agent === "string" && ga.agent.trim() !== "" ? stripAnsi(ga.agent).trim() : undefined;
  switch (type) {
    case "gentle-pi.review-preflight":
      return `✿ Gentle AI · review preflight · ${text}`;
    case "gentle-agents.result":
      return agent === undefined ? `❀  Agent result · ${text}` : `❀  Agent result · ${agent} · ${text}`;
    case "gentle-agents.message":
      return `❀  ${agent ?? "Subagent"} message · ${text}`;
    case "gentle-agents.orchestrator-message":
      return `❀  Session message · ${text}`;
    case "gentle-agents.stale-result":
      return `❀  Stale agent result · ${text}`;
    default:
      return raw;
  }
}

/** The first line of Gentle's job notice (lib/background-jobs-tools.ts jobNoticeText). */
/** A monitor's progress notice: 'Monitor job-4 ("label") reported 1 new line:'. */
const MONITOR_PROGRESS = /^Monitor \S+ \("(.*)"\) reported (\d+ new lines?):$/;
const JOB_LINE = /^(Background job|Monitor) \S+ \("(.*)"\) (.+?)(?: after ((?:\d+[hms] ?)+))?(?:, \d+ events?)?\.$/;

/**
 * A background job's notice as Gentle's "⧗ Background job · <label>" card heads it: the label, how it
 * ended ("exited 1", "stopped") and after how long. From `details.gentleJobs` when stored, the notice's
 * own first line otherwise; a text of another shape keeps its first line as the heading.
 */
function jobNotice(text: string, details: unknown): { title: string; error: boolean } {
  const gj = isRecord(details) && isRecord(details.gentleJobs) ? details.gentleJobs : undefined;
  const first = text.split("\n")[0]!.trim();
  const progress = MONITOR_PROGRESS.exec(first);
  if (progress !== null) {
    const label = typeof gj?.label === "string" && gj.label.trim() !== "" ? stripAnsi(gj.label).trim() : progress[1]!;
    return { title: `⧗ Monitor · ${label} · ${progress[2]}`, error: false };
  }
  // Gentle puts the command on its own line; a notice with it on the first line is read up to its first sentence.
  const parsed = JOB_LINE.exec(first) ?? JOB_LINE.exec(first.replace(/^(.*?\.)\s+[A-Z][a-z]+:.*$/, "$1"));
  const noun = gj?.kind === "monitor" || parsed?.[1] === "Monitor" ? "Monitor" : "Background job";
  const label = typeof gj?.label === "string" && gj.label.trim() !== "" ? stripAnsi(gj.label).trim() : parsed?.[2];
  const code = typeof gj?.exitCode === "number" ? gj.exitCode : parsed !== null ? Number(/^exited with code (-?\d+)$/.exec(parsed[3]!)?.[1] ?? NaN) : NaN;
  const how = parsed === null ? undefined : Number.isFinite(code) ? `exited ${code}` : parsed[3]!.replace(/^was stopped by the user$/, "stopped");
  const outcome = how === undefined ? undefined : parsed?.[4] === undefined ? how : `${how} after ${parsed[4].trim()}`;
  const parts = [`⧗ ${noun}`, ...(label === undefined ? [] : [label]), ...(outcome === undefined ? [] : [outcome])];
  if (label === undefined && outcome === undefined) parts.push(first);
  return { title: parts.join(" · "), error: (Number.isFinite(code) && code !== 0) || gj?.status === "failed" };
}

/** The glyph and name a labelled notice starts with, the part drawn in colour; undefined for the others. */
function noticeLabel(type: unknown, text: string, details: unknown): string | undefined {
  const ga = isRecord(details) && isRecord(details.gentleAgents) ? details.gentleAgents : undefined;
  const agent = typeof ga?.agent === "string" && ga.agent.trim() !== "" ? stripAnsi(ga.agent).trim() : undefined;
  switch (type) {
    case "gentle-pi.review-preflight":
      return "✿ Gentle AI · review preflight";
    case "gentle-agents.result":
      return "❀  Agent result";
    case "gentle-agents.message":
      return `❀  ${agent ?? "Subagent"} message`;
    case "gentle-agents.orchestrator-message":
      return "❀  Session message";
    case "gentle-agents.stale-result":
      return "❀  Stale agent result";
    case "gentle-jobs.notice":
      return text.startsWith("⧗ Monitor") ? "⧗ Monitor" : "⧗ Background job";
    default:
      return undefined;
  }
}

/**
 * A pi-intercom message (index.ts sendMessage) as "✉ From <sender> · <body>": the sender from
 * `details.from` (name, else its id's first 8 characters) or the content's bold "**From X**"; the body
 * from `details.bodyText`, else the content after its delivery metadata. Reply instructions are left out.
 */
function intercomNotice(raw: string, details: unknown): { label: string; text: string } {
  const from = isRecord(details) && isRecord(details.from) ? details.from : undefined;
  const name = typeof from?.name === "string" && from.name.trim() !== "" ? from.name.trim() : typeof from?.id === "string" && from.id !== "" ? from.id.slice(0, 8) : /^\*\*From (.+?)\*\*/.exec(raw.trim())?.[1];
  const label = `✉ From ${stripAnsi(name ?? "intercom")}`;
  const parts = raw.trim().split(/\n\s*\n/);
  const body = isRecord(details) && typeof details.bodyText === "string" ? stripAnsi(details.bodyText).trim() : (parts.length > 2 ? parts.slice(parts.length >= 4 ? 3 : 2) : parts.slice(-1)).join("\n\n").trim();
  return { label, text: body === "" ? label : `${label} · ${body}` };
}

/** A displayed custom message as a notice item, or undefined when it has nothing to say. */
function noticeOf(id: string, ts: string | undefined, type: unknown, raw: string, details: unknown): ChatItem | undefined {
  if (raw.trim() === "") return undefined;
  if (type === "gentle-jobs.notice") {
    const { title, error } = jobNotice(raw.trim(), details);
    const label = noticeLabel(type, title, details)!;
    return error ? { id, ts, kind: "notice", text: raw.trim(), title, error: true, label } : { id, ts, kind: "notice", text: raw.trim(), title, label };
  }
  if (type === "intercom_message") return { id, ts, kind: "notice", ...intercomNotice(raw, details) };
  const label = noticeLabel(type, raw, details);
  const text = customNotice(type, raw, details);
  return label === undefined ? { id, ts, kind: "notice", text } : { id, ts, kind: "notice", text, label };
}

/**
 * Gentle's stale agent result (a `custom` entry, gentle-agents.ts appendEntry) as a folded notice, its
 * heading and two sentences built as Gentle's own entry renderer builds them.
 */
function staleResult(id: string, ts: string | undefined, raw: unknown): ChatItem {
  const data = isRecord(raw) ? raw : {};
  const text = (v: unknown, fallback: string) => (typeof v === "string" ? stripAnsi(v) : fallback);
  const taskId = text(data.taskId, "unknown");
  const agent = text(data.agent, "Subagent");
  const label = text(data.label, "");
  const status = typeof data.status === "string" ? stripAnsi(data.status).replace("_", " ") : "unknown";
  const age = typeof data.ageSeconds === "number" && Number.isFinite(data.ageSeconds) ? Math.max(0, Math.round(data.ageSeconds)) : 0;
  const ago = age < 90 ? `${age}s` : age < 3600 ? `${Math.round(age / 60)}m` : `${Math.round(age / 3600)}h`;
  return {
    id,
    ts,
    kind: "notice",
    label: "❀  Stale agent result",
    title: `❀  Stale agent result · ${agent} · task ${taskId}`,
    text: [
      `Subagent ${agent} (task ${taskId}, "${label}") ${status} about ${ago} ago, while the orchestrator was still busy.`,
      "Marked stale: the result was not replayed into the conversation. It stays available through subagent_status and subagent_result.",
    ].join("\n"),
  };
}

/** Fold one stored entry into the state. */
function reduce(state: ReducerState, entry: SessionEntryLike): void {
  const { items, calls, at } = state;
  const ts = entry.timestamp || undefined;

  if (entry.type === "compaction" || entry.type === "branch_summary") {
    // One marker per event, even with an empty recap: the context did change.
    const summary = typeof entry.summary === "string" ? stripAnsi(entry.summary) : "";
    items.push(summary.trim() !== "" ? { id: entry.id, ts, kind: "compacted", text: summary } : { id: entry.id, ts, kind: "compacted" });
    return;
  }

  // `display: false` is an extension talking to the model, not to the person.
  if (entry.type === "custom_message") {
    const notice = noticeOf(entry.id, ts, entry.customType, stripAnsi(textOf(entry.content)), entry.details);
    if (entry.display === true && notice !== undefined) items.push(notice);
    return;
  }

  if (entry.type === "custom" && entry.customType === "gentle-agents.stale-result") {
    items.push(staleResult(entry.id, ts, entry.data));
    return;
  }

  if (entry.type !== "message" || !isRecord(entry.message)) return;
  const m = entry.message;

  if (m.role === "toolResult") {
    const callId = typeof m.toolCallId === "string" ? m.toolCallId : "";
    // The result of a hidden step is as hidden as the step.
    if (state.hidden.delete(callId)) return;
    const text = stripAnsi(textOf(m.content));
    const isError = m.isError === true;
    const target = calls.get(callId);
    if (target !== undefined) {
      calls.delete(callId);
      const done: ToolItem = { ...target, tool: { ...target.tool } };
      attach(done, text, isError, m.details, m.content);
      if (ts !== undefined) done.end = ts;
      const i = at.get(target);
      at.delete(target);
      if (i !== undefined) items[i] = done;
    } else if (text.trim() !== "" || imageCount(m.content) > 0) {
      // An orphan result keeps its output visible rather than vanishing.
      const name = typeof m.toolName === "string" ? m.toolName : "result";
      const orphan: ToolItem = { id: entry.id, ts, kind: "tool", tool: { kind: "other", name, summary: "" }, status: "running" };
      attach(orphan, text, isError, undefined, m.content);
      if (ts !== undefined) orphan.end = ts;
      items.push(orphan);
    }
    return;
  }

  if (m.role === "bashExecution") {
    const text = bashNotice(m);
    if (text !== undefined) items.push({ id: entry.id, ts, kind: "notice", text });
    return;
  }

  // A `custom` role inside a message entry follows the same display rule as `custom_message`.
  if (m.role === "custom") {
    const notice = noticeOf(entry.id, ts, m.customType, stripAnsi(textOf(m.content)), m.details);
    if (m.display === true && notice !== undefined) items.push(notice);
    return;
  }
  if (m.role === "compactionSummary" || m.role === "branchSummary") {
    items.push({ id: entry.id, ts, kind: "compacted" });
    return;
  }
  if (m.role !== "user" && m.role !== "assistant") return; // `system` and unknown roles

  const turn = blockItems(m.content, entry.id, ts, m.role === "user", false, calls, state.hidden);
  const images = m.role === "user" ? imageCount(m.content) : 0;
  if (images > 0) {
    // On the turn's last text; a turn of images alone still gets its box.
    const last = turn.findLast((i): i is Extract<ChatItem, { kind: "user" }> => i.kind === "user");
    const user = last ?? { id: `${entry.id}:images`, ts, kind: "user" as const, text: "" };
    user.images = images;
    const data = imageBlocks(m.content);
    if (data.length > 0) user.imageData = data;
    if (last === undefined) turn.push(user);
  }
  for (const item of turn) {
    if (item.kind === "tool" && calls.get(item.id) === item) at.set(item, items.length);
    items.push(item);
  }
  if (m.role === "assistant") {
    state.newest = new Set(turn.filter((i) => i.kind === "tool").map((i) => i.id));
    // After the turn, under an id of its own: the harness wrote this, the model did not say it.
    const message = m.errorMessage;
    if (typeof m.stopReason === "string" && STOPPED_BADLY.has(m.stopReason) && typeof message === "string" && message.trim() !== "") {
      items.push({ id: `${entry.id}:stop`, ts, kind: "notice", text: stripAnsi(message).trim() });
    }
  }
}

/** A call that will never get a result, drawn failed. One copy per item, so its identity is stable too. */
const staleCopies = new WeakMap<ToolItem, ToolItem>();
function stale(item: ToolItem): ToolItem {
  let copy = staleCopies.get(item);
  if (copy === undefined) {
    copy = { ...item, status: "failed" };
    staleCopies.set(item, copy);
  }
  return copy;
}

/** The stored items plus what is live: the streaming message, and calls that will never end. Leaves `state` as it was. */
function finish(state: ReducerState, opts: ItemsOptions): ChatItem[] {
  const out = state.items.slice();
  const streaming = opts.streaming;
  const newest = new Set(state.newest);
  // Streaming calls only live in this output; the stored state never sees them.
  const calls = new Map(state.calls);
  if (streaming !== undefined && isRecord(streaming)) {
    // A copy of the hidden ids: streaming calls never reach the kept state.
    const turn = blockItems(streaming.content, "streaming", tsOf(streaming.timestamp), false, true, calls, new Set(state.hidden));
    out.push(...turn);
    for (const i of turn) if (i.kind === "tool") newest.add(i.id);
  }
  const running = opts.runningToolCallIds;
  if (running !== undefined) {
    for (const [id, item] of state.calls) {
      if (running.has(id) || newest.has(item.id)) continue;
      const i = state.at.get(item);
      if (i !== undefined) out[i] = stale(item);
    }
  }
  return out;
}

/**
 * The active branch as chat items.
 *
 * Mapping, as Collie's Pi reducer: `toolResult` attaches by `toolCallId`; `bashExecution` is a
 * notice; `custom_message` only when `display` is true; `compaction` / `branch_summary` are a
 * compaction marker; `system`, `model_change`, `usage`, `label`, `custom` and other bookkeeping
 * draw nothing; an assistant turn that stopped with `error` / `aborted` gets a notice after it.
 */
export function itemsFromEntries(entries: readonly SessionEntryLike[], opts: ItemsOptions = {}): ChatItem[] {
  const state = newState();
  for (const entry of entries) reduce(state, entry);
  return finish(state, opts);
}

/** `itemsFromEntries`, remembering the stored entries it already folded in. */
export interface ItemsBuilder {
  build(entries: readonly SessionEntryLike[], opts?: ItemsOptions): ChatItem[];
  /** Entries folded in by the last build without starting over (for tests and the bench). */
  readonly reused: number;
}

/**
 * Live rebuilds without re-reading the session. Stored entries never change and a branch is a path
 * from the root, so when the entry the last build ended on is still at the same place, every entry
 * before it is too: only the entries after it are new. Anything else (a `/tree` jump, a fork, a
 * new session) starts over. Output is exactly `itemsFromEntries(entries, opts)`.
 */
export function createItemsBuilder(): ItemsBuilder {
  let state = newState();
  let done = 0;
  let lastId: string | undefined;
  let firstId: string | undefined;
  let reused = 0;
  return {
    get reused() {
      return reused;
    },
    build(entries, opts = {}) {
      const continues = done > 0 && entries.length >= done && entries[0]?.id === firstId && entries[done - 1]?.id === lastId;
      if (!continues) {
        state = newState();
        done = 0;
      }
      reused = done;
      for (let i = done; i < entries.length; i++) reduce(state, entries[i]!);
      done = entries.length;
      firstId = entries[0]?.id;
      lastId = entries[done - 1]?.id;
      return finish(state, opts);
    },
  };
}
