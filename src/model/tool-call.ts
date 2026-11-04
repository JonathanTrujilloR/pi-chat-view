// The structured form of a tool call. Ported from Collie's bridge/journal/tool-call.ts (MIT).
//
// Nine kinds cover every tool vocabulary Collie has met: each harness has a read, a shell, a grep
// and an edit under some spelling. A tool outside the nine is not an error, it is `other`, and still
// carries its name and a one-line summary.

import { isRecord, oneLine } from "./text.ts";

/** One question an agent put to the person. Field names follow opencode's `question` tool. */
export interface ToolQuestion {
  header?: string;
  question: string;
  multiple: boolean;
  options: readonly { label: string; description?: string }[];
}

/**
 * What a tool call did. Every branch's first field is the one a person names the call by (the
 * path, the command, the query), so a row can be drawn from `kind` plus one field.
 */
export type ToolCall =
  | { kind: "edit"; path: string }
  /** `exitCode` is filled from the result, absent while running. */
  | { kind: "execute"; command: string; description?: string; exitCode?: number }
  /** `range` is [firstLine, lastLine], absent for a whole-file read. */
  | { kind: "read"; path: string; range?: [number, number] }
  /** `where` is the path, the glob, or "web". */
  | { kind: "search"; query: string; where?: string }
  | { kind: "fetch"; url: string }
  | { kind: "delete" | "move"; path: string; to?: string }
  | { kind: "task"; agent?: string; summary: string }
  /** Keyed on the input's shape (see {@link classifyToolCall}), never on the tool's name. */
  | { kind: "question"; name: string; summary: string; questions: readonly ToolQuestion[] }
  /**
   * `badge`: a tool of a family that draws itself its own way (Engram 🧠, RDD 🌹, Gentle's codemode λ,
   * todos and agents ❀): the row reads "<glyph> <action> <subject>", the open card is titled `label`.
   */
  | { kind: "other"; name: string; summary: string; badge?: ToolBadge };

/** How a tool of a known family is drawn: glyph, its own verb, what it acted on, and its card's title. */
export interface ToolBadge {
  glyph: string;
  action: string;
  subject: string;
  label: string;
  /** What the call came back with, in one word or two, when the family says it (RDD: "ready", "closed"). */
  result?: string;
  /** The whole of that, as the family's own card says it (RDD: "ready · start · fresh_target_ready"). */
  summary?: string;
  /** What the open card shows when it is more than the subject (codemode: the script). */
  body?: string;
}

/**
 * The tool names each kind answers to, lower-cased. Collie's table plus Pi's `find` and
 * Gentle's `subagent_run`; matching a lower-cased name keeps one table for every harness.
 */
const NAMES: Record<string, ToolCall["kind"]> = {
  // edit
  edit: "edit",
  multiedit: "edit",
  write: "edit",
  notebookedit: "edit",
  apply_patch: "edit",
  str_replace_editor: "edit",
  patch: "edit",
  edit_file: "edit",
  write_file: "edit",
  // execute
  bash: "execute",
  shell: "execute",
  execute: "execute",
  exec: "execute",
  run: "execute",
  bashoutput: "execute",
  exec_command: "execute",
  // Gentle's background shell (bash_background) and its symbol reads (read_symbol, read_enclosing).
  bash_background: "execute",
  // read
  read: "read",
  read_file: "read",
  view: "read",
  read_symbol: "read",
  read_enclosing: "read",
  // search
  grep: "search",
  glob: "search",
  find: "search",
  websearch: "search",
  web_search: "search",
  search: "search",
  list: "search",
  ls: "search",
  // fetch
  webfetch: "fetch",
  web_fetch: "fetch",
  fetch: "fetch",
  fetch_content: "fetch",
  // delete / move
  delete: "delete",
  remove: "delete",
  rm: "delete",
  move: "move",
  rename: "move",
  // task
  task: "task",
  agent: "task",
  subagent: "task",
  subagent_run: "task",
};

type Obj = Record<string, unknown>;

/** A non-blank string field, or an argv array joined; `undefined` so a caller can `??` past it. */
function str(o: Obj, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string" && v.trim() !== "") return v;
    if (Array.isArray(v)) {
      const joined = v.filter((x): x is string => typeof x === "string").join(" ").trim();
      if (joined !== "") return joined;
    }
  }
  return undefined;
}

/** A number field. A numeric string still counts. */
function num(o: Obj, ...keys: string[]): number | undefined {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  }
  return undefined;
}

// Guards against a runaway input, not limits any harness sets.
const MAX_QUESTIONS = 9;
const MAX_OPTIONS = 20;
const MAX_QUESTION_CHARS = 500;
const MAX_HEADER_CHARS = 80;
const MAX_LABEL_CHARS = 200;
const MAX_DESCRIPTION_CHARS = 500;

/** A non-blank trimmed string, capped, or `undefined`. */
function text(v: unknown, max: number): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v.trim().slice(0, max) : undefined;
}

/**
 * Read an input's question list, or `undefined` when it holds nothing a person could answer.
 *
 * The shape is the rule, not the tool name: an entry needs a string `question` and an `options`
 * array of strings or `{label, description}`. Malformed entries are dropped, and a list with
 * nothing valid left is not a question at all.
 *
 * Extension of Collie's rule: a single top-level `question` + `options` (Gentle's
 * `ask_user_choice`) is read as a one-entry list, still by shape.
 */
function readQuestions(o: Obj): ToolQuestion[] | undefined {
  const list: unknown[] | undefined = Array.isArray(o.questions)
    ? o.questions
    : typeof o.question === "string" && Array.isArray(o.options)
      ? [o]
      : undefined;
  if (list === undefined || list.length === 0) return undefined;
  const questions: ToolQuestion[] = [];
  for (const q of list.slice(0, MAX_QUESTIONS)) {
    if (!isRecord(q) || !Array.isArray(q.options)) continue;
    const question = text(q.question, MAX_QUESTION_CHARS);
    if (question === undefined) continue;
    const options: { label: string; description?: string }[] = [];
    for (const opt of q.options.slice(0, MAX_OPTIONS)) {
      const label = text(isRecord(opt) ? opt.label : opt, MAX_LABEL_CHARS);
      if (label === undefined) continue;
      const entry: { label: string; description?: string } = { label };
      const description = isRecord(opt) ? text(opt.description, MAX_DESCRIPTION_CHARS) : undefined;
      if (description !== undefined) entry.description = description;
      options.push(entry);
    }
    const parsed: ToolQuestion = { question, multiple: q.multiple === true || q.multiSelect === true, options };
    const header = text(q.header, MAX_HEADER_CHARS);
    if (header !== undefined) parsed.header = header;
    questions.push(parsed);
  }
  return questions.length > 0 ? questions : undefined;
}

/**
 * Collapse a tool call's input into one readable line, for `other` and as a fallback summary.
 *
 * Order is load-bearing: a grep carries both `pattern` and `path`, and the pattern is what was
 * searched for. An unknown tool falls back to its first string value.
 */
export function summarizeInput(input: unknown): string {
  if (input === null || typeof input !== "object") return "";
  const named: Obj = Array.isArray(input) ? {} : (input as Obj);
  const values: unknown[] = Array.isArray(input) ? input : Object.values(input);
  const first = Array.isArray(named.questions) ? named.questions[0] : undefined;
  const asked = isRecord(first) ? text(first.question, MAX_QUESTION_CHARS) : undefined;
  const chosen =
    asked ??
    str(named, "file_path", "command", "pattern", "query", "url", "path", "label", "description", "task", "prompt") ??
    values.find((v): v is string => typeof v === "string" && v.trim() !== "");
  return chosen === undefined ? "" : oneLine(chosen);
}

/**
 * Classify a tool call from its name and input alone. Results (exit codes, output) are folded in
 * by the caller, because the input only says what was asked for.
 */
export function classifyToolCall(name: string, input: unknown, summary = summarizeInput(input)): ToolCall {
  const o: Obj = isRecord(input) ? input : {};
  // A question is recognised by its input, so it outranks the name table.
  const questions = readQuestions(o);
  if (questions !== undefined) {
    return { kind: "question", name, summary: oneLine(questions[0]?.question ?? summary), questions };
  }
  const kind: ToolCall["kind"] | undefined = Object.hasOwn(NAMES, name.toLowerCase()) ? NAMES[name.toLowerCase()] : undefined;
  switch (kind) {
    case "edit":
      return { kind: "edit", path: str(o, "file_path", "notebook_path", "path", "filePath") ?? "" };
    case "execute": {
      // Optional fields are assigned, never set to `undefined`: absent means absent.
      const call: ToolCall = { kind: "execute", command: str(o, "command", "cmd", "script") ?? "" };
      const description = str(o, "description");
      if (description !== undefined) call.description = description;
      return call;
    }
    case "read": {
      const offset = num(o, "offset", "line", "startLine");
      const limit = num(o, "limit", "count");
      const call: ToolCall = { kind: "read", path: str(o, "file_path", "path", "filePath") ?? "" };
      // `offset` alone has no last line to name, so only a full pair is a range.
      if (offset !== undefined && limit !== undefined) call.range = [offset, offset + limit];
      return call;
    }
    case "search": {
      // `pattern` outranks `path`. Pi's `ls` has only a path, which then is what was looked at.
      const query = str(o, "pattern", "query", "q");
      const where = str(o, "path", "glob", "include") ?? (name.toLowerCase().includes("web") ? "web" : undefined);
      if (query === undefined) return { kind: "search", query: where ?? "" };
      const call: ToolCall = { kind: "search", query };
      if (where !== undefined) call.where = where;
      return call;
    }
    case "fetch":
      return { kind: "fetch", url: str(o, "url", "uri", "urls") ?? "" };
    case "delete":
    case "move": {
      const call: ToolCall = { kind, path: str(o, "file_path", "path", "source", "from") ?? "" };
      const to = str(o, "to", "destination", "new_path");
      if (to !== undefined) call.to = to;
      return call;
    }
    case "task": {
      // No word stands in for a missing agent name; the view draws plain "Agent".
      const call: ToolCall = { kind: "task", summary: oneLine(str(o, "label", "description", "task") ?? summary) };
      const agent = str(o, "subagent_type", "agent", "agent_type") ?? str(o, "model");
      if (agent !== undefined) call.agent = agent;
      return call;
    }
    default: {
      const badge = badgeOf(name, o);
      return badge === undefined ? { kind: "other", name, summary } : { kind: "other", name, summary, badge };
    }
  }
}

/** The badge of a tool from a family the chat draws its own way, or undefined. */
function badgeOf(name: string, o: Obj): ToolBadge | undefined {
  const engram = engramAction(name, o);
  if (engram !== undefined) return { glyph: "🧠", ...engram, label: "Engram" };
  const rdd = rddAction(name, o);
  if (rdd !== undefined) return { glyph: "🌹", ...rdd, label: "RDD" };
  return gentleAction(name.toLowerCase(), o);
}

/** Agent tools Gentle draws as "❀ agent <action>" (subagent_run is a task and draws as one). */
const AGENT_TOOLS = new Set(["result", "status", "continue", "cancel", "send_message", "reply", "list_tasks", "list_agents"]);

/**
 * Gentle's own tools, titled as its cards are: codemode "λ Code" (lib/codemode-renderer.ts), todo "❀"
 * (lib/shell-todo.ts TODO_GLYPH), and the subagent tools "❀ agent <action>" (extensions/gentle-agents.ts).
 */
function gentleAction(name: string, o: Obj): ToolBadge | undefined {
  if (name === "codemode") {
    const code = str(o, "code") ?? "";
    const first = code.split("\n").find((l) => l.trim() !== "");
    const badge: ToolBadge = { glyph: "λ", action: "code", subject: first === undefined ? "" : oneLine(first), label: "Code" };
    if (code.trim() !== "") badge.body = code.replace(/^\s*\n/, "").trimEnd();
    return badge;
  }
  if (name === "todo") {
    const action = str(o, "action");
    return { glyph: "❀", action: action === undefined ? "todo" : `todo ${oneLine(action)}`, subject: oneLine(str(o, "title") ?? ""), label: "Todos" };
  }
  const tail = /^subagent_([a-z_]+)$/.exec(name)?.[1];
  if (tail === undefined || !AGENT_TOOLS.has(tail)) return undefined;
  return { glyph: "❀", action: `agent ${tail.replace(/_/g, " ")}`, subject: oneLine(str(o, "task_id", "label", "agent") ?? ""), label: "Agents" };
}

/** The lens a review capture runs, from its collect binding (JSON, `artifactSubject.lens`), as Gentle reads it. */
function bindingLens(binding: unknown): string | undefined {
  if (typeof binding !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(binding);
    const subject = isRecord(parsed) ? (parsed.artifactSubject ?? parsed.artifact_subject) : undefined;
    const lens = isRecord(subject) ? subject.lens : undefined;
    return typeof lens === "string" && lens !== "" ? lens.replace(/^review-/, "") : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Gentle's review tools, titled as its own cards are (extensions/gentle-ai.ts renderCall, then
 * lib/gentle-ai-renderer.ts callTitle): `rdd <operation, dashes as spaces>`, `rdd scope`,
 * `rdd capture · <lens>`, `rdd capture group · <lens> · <lens>`.
 */
function rddAction(name: string, o: Obj): { action: string; subject: string } | undefined {
  const tail = /^gentle_review(?:_([a-z_]+))?$/.exec(name.toLowerCase());
  if (tail === null) return undefined;
  const withLenses = (op: string, lenses: (string | undefined)[]) => {
    const named = lenses.filter((l): l is string => l !== undefined);
    return named.length === 0 ? op : `${op} · ${named.join(" · ")}`;
  };
  switch (tail[1]) {
    case undefined: {
      const op = str(o, "operation");
      return { action: op === undefined ? "rdd" : `rdd ${oneLine(op.replaceAll("-", " "))}`, subject: "" };
    }
    case "capture":
      return { action: withLenses("rdd capture", [bindingLens(o.collectBinding)]), subject: "" };
    case "capture_group":
      return { action: withLenses("rdd capture group", Array.isArray(o.collectBindings) ? o.collectBindings.map(bindingLens) : []), subject: "" };
    default:
      return { action: `rdd ${tail[1].replace(/_/g, " ")}`, subject: "" };
  }
}

// Gentle's result summary (lib/gentle-ai-renderer.ts summarizeJsonEnvelope): the first present field of
// each group, at the top level then inside `result`. The chat shows its first part only.
const RDD_SUMMARY_FIELDS: readonly (readonly string[])[] = [
  ["status", "state"],
  ["outcome"],
  ["risk", "risk_tier", "riskLevel"],
  ["action", "provider_action"],
  ["next_transition.reason_code", "nextTransition.reasonCode", "next_transition", "nextTransition", "reason_code", "reasonCode", "diagnostics.error_code"],
  ["diagnostics.message", "diagnostics.stderr", "error.message", "error", "reasons.0.detail", "reason", "message"],
];
const HASH = /^(?:sha256:)?[0-9a-f]{32,}$/i;

function fieldAt(source: unknown, path: string): unknown {
  let value = source;
  for (const key of path.split(".")) {
    if (Array.isArray(value)) value = value[Number(key)];
    else if (isRecord(value)) value = value[key];
    else return undefined;
  }
  return value;
}

function summaryValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const clause = value.split("\n")[0]!.split("; ")[0]!.replace(/(^|: )\w*Error: /g, "$1").replace(/\s+/g, " ").trim();
  return clause !== "" && !HASH.test(clause) ? clause : undefined;
}

/** The first segment of Gentle's summary of a review result ("ready · start · …" → "ready"). */
export function rddResult(text: string): string | undefined {
  return rddSummary(text)?.[0];
}

/**
 * Gentle's one-line summary of a review result as its segments ("ready", "start", "fresh_target_ready"),
 * or undefined when the result is not a JSON envelope or names none of its fields (Gentle then says "N fields").
 */
export function rddSummary(text: string): string[] | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return undefined;
  let envelope: unknown;
  try {
    envelope = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (!isRecord(envelope)) return undefined;
  const scopes = isRecord(envelope.result) ? [envelope, envelope.result] : [envelope];
  const parts: string[] = [];
  for (const group of RDD_SUMMARY_FIELDS) {
    const found = scopes.flatMap((scope) => group.map((path) => summaryValue(fieldAt(scope, path)))).find((p) => p !== undefined);
    if (found !== undefined && !parts.includes(oneLine(found))) parts.push(oneLine(found));
  }
  return parts.length > 0 ? parts : undefined;
}

/**
 * An Engram tool (`mem_save`, or namespaced like `mcp__engram__mem_save`) as an action and its subject:
 * the title, the query, or `#id`. Undefined for any other tool.
 */
function engramAction(name: string, o: Obj): { action: string; subject: string } | undefined {
  const tail = /(?:^|__)mem_([a-z][a-z_]*)$/.exec(name.toLowerCase())?.[1];
  if (tail === undefined) return undefined;
  const id = o.id ?? o.observation_id;
  const ref = typeof id === "number" || (typeof id === "string" && id.trim() !== "") ? `#${String(id).trim()}` : undefined;
  const pick = (...v: (string | undefined)[]) => oneLine(v.find((x) => x !== undefined) ?? "");
  switch (tail) {
    case "save":
      return { action: "saved", subject: pick(str(o, "title")) };
    case "update":
      return { action: "updated", subject: pick(str(o, "title"), ref) };
    case "search":
      return { action: "searched", subject: pick(str(o, "query")) };
    case "get_observation":
      return { action: "read", subject: pick(ref) };
    case "context":
      return { action: "context", subject: "" };
    case "session_summary":
      return { action: "session summary", subject: "" };
    default:
      return { action: tail.replace(/_/g, " "), subject: pick(str(o, "title", "query"), ref) };
  }
}
