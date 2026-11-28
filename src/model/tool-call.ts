// Turning a raw tool call (a name and an untyped argument object) into something the chat can draw.
//
// Agents and harnesses spell the same few operations many ways: a shell is `bash`, `exec`,
// `run`...; a file write is `write`, `edit`, `apply_patch`... Rather than one branch per tool, each
// kind of work is a family: a list of names plus one reader for its arguments. A tool that belongs
// to no family is still drawn, as `other`, with its own name and a one-line summary. A few tool sets
// that ship their own look (Engram memory, Gentle's review and agent tools) get a badge instead.

import { hasText, isRecord, oneLine } from "./text.ts";

/** One question an agent asked the person, with the options it offered. */
export interface ToolQuestion {
  header?: string;
  question: string;
  multiple: boolean;
  options: readonly { label: string; description?: string }[];
}

/**
 * What a tool call did. The field after `kind` is what a person calls the step by (the path, the
 * command, the query), so a compact row needs only `kind` and that field.
 */
export type ToolCall =
  | { kind: "edit"; path: string }
  /** `exitCode` arrives with the result; it is absent while the command runs. */
  | { kind: "execute"; command: string; description?: string; exitCode?: number }
  /** `range` is [first line, last line]; absent when the whole file was read. */
  | { kind: "read"; path: string; range?: [number, number] }
  /** `where` is a path, a glob, or "web". */
  | { kind: "search"; query: string; where?: string }
  | { kind: "fetch"; url: string }
  | { kind: "delete" | "move"; path: string; to?: string }
  | { kind: "task"; agent?: string; summary: string }
  /** Recognised by the shape of its arguments (see {@link classifyToolCall}), whatever the tool is called. */
  | { kind: "question"; name: string; summary: string; questions: readonly ToolQuestion[] }
  /**
   * `badge` is set for tools that have a look of their own (Engram 🧠, review 🌹, codemode λ,
   * todos and agents ❀): the row reads "<glyph> <action> <subject>" and the open card is titled `label`.
   */
  | { kind: "other"; name: string; summary: string; badge?: ToolBadge };

/** How a badged tool is drawn: its glyph, its verb, what it acted on, and its card title. */
export interface ToolBadge {
  glyph: string;
  action: string;
  subject: string;
  label: string;
  /** The outcome in a word or two, when the tool reports one (review: "ready", "closed"). */
  result?: string;
  /** The full outcome line the tool's own card would show (review: "ready · start · fresh_target_ready"). */
  summary?: string;
  /** What the open card shows when there is more than the subject (codemode: the script). */
  body?: string;
}

type Args = Record<string, unknown>;

/**
 * The first of `keys` that holds words. A list of strings (an argv, several URLs) counts too and
 * is joined with spaces. Returns undefined, not "", so callers can chain fallbacks with `??`.
 */
function words(args: Args, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = args[key];
    if (hasText(value)) return value;
    if (Array.isArray(value)) {
      const joined = value.filter((part) => typeof part === "string").join(" ").trim();
      if (joined !== "") return joined;
    }
  }
  return undefined;
}

/** The first of `keys` that holds a finite number; numeric strings are accepted since some tools send them. */
function numeric(args: Args, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (hasText(value) && Number.isFinite(Number(value))) return Number(value);
  }
  return undefined;
}

/**
 * The object with its undefined fields removed. Optional fields on a call are either present
 * with a value or absent; tests compare shapes strictly, and the view checks `in`-style presence.
 */
function prune<T extends object>(obj: T): T {
  // Copied rather than `delete`d: deleting keys drops V8 objects into slow dictionary mode.
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as T;
}

// Argument spellings, most specific first. Tools disagree on these, so each list is the union seen in practice.
const PATH = ["file_path", "path", "filePath"];
const EDIT_PATH = ["file_path", "notebook_path", "path", "filePath"];

/** One kind of work: the tool names that do it and how its arguments are read. */
interface Family {
  names: readonly string[];
  read: (args: Args, lowerName: string, summary: string) => ToolCall;
}

const FAMILIES: readonly Family[] = [
  {
    names: ["edit", "multiedit", "write", "notebookedit", "apply_patch", "str_replace_editor", "patch", "edit_file", "write_file"],
    read: (a) => ({ kind: "edit", path: words(a, EDIT_PATH) ?? "" }),
  },
  {
    // bash_background is Gentle's detached shell; it is still a command the agent ran.
    names: ["bash", "shell", "execute", "exec", "run", "bashoutput", "exec_command", "bash_background"],
    read: (a) => prune({ kind: "execute", command: words(a, ["command", "cmd", "script"]) ?? "", description: words(a, ["description"]) }),
  },
  {
    // read_symbol / read_enclosing read part of a file by symbol; to a reader they are still reads.
    names: ["read", "read_file", "view", "read_symbol", "read_enclosing"],
    read: (a) => {
      const from = numeric(a, ["offset", "line", "startLine"]);
      const span = numeric(a, ["limit", "count"]);
      // A start with no length names no last line, so only a complete pair becomes a range.
      const range: [number, number] | undefined = from !== undefined && span !== undefined ? [from, from + span] : undefined;
      return prune({ kind: "read", path: words(a, PATH) ?? "", range });
    },
  },
  {
    names: ["grep", "glob", "find", "websearch", "web_search", "search", "list", "ls"],
    read: (a, lowerName) => {
      // What was looked for beats where it was looked: a grep has both a pattern and a path.
      const where = words(a, ["path", "glob", "include"]) ?? (lowerName.includes("web") ? "web" : undefined);
      const query = words(a, ["pattern", "query", "q"]);
      // A listing has only a place, and then the place is the subject.
      if (query === undefined) return { kind: "search", query: where ?? "" };
      return prune({ kind: "search", query, where });
    },
  },
  {
    names: ["webfetch", "web_fetch", "fetch", "fetch_content"],
    read: (a) => ({ kind: "fetch", url: words(a, ["url", "uri", "urls"]) ?? "" }),
  },
  {
    names: ["delete", "remove", "rm"],
    read: (a) => ({ kind: "delete", path: words(a, ["file_path", "path", "source", "from"]) ?? "" }),
  },
  {
    names: ["move", "rename"],
    read: (a) => prune({ kind: "move", path: words(a, ["file_path", "path", "source", "from"]) ?? "", to: words(a, ["to", "destination", "new_path"]) }),
  },
  {
    names: ["task", "agent", "subagent", "subagent_run"],
    // No placeholder for a missing agent name: the view supplies its own word.
    read: (a, _name, summary) =>
      prune({
        kind: "task",
        summary: oneLine(words(a, ["label", "description", "task"]) ?? summary),
        agent: words(a, ["subagent_type", "agent", "agent_type", "model"]),
      }),
  },
];

/** Every family by each of its names, lower-cased, so lookup is one map hit whatever the casing. */
const FAMILY_BY_NAME = new Map<string, Family>(FAMILIES.flatMap((family) => family.names.map((name) => [name, family] as const)));

// Caps on question input. They only guard against a runaway argument; no tool is expected near them.
const QUESTION_CAPS = { questions: 9, options: 20, question: 500, header: 80, label: 200, description: 500 } as const;

/** A trimmed, length-capped string, or undefined when there is nothing to show. */
function capped(v: unknown, max: number): string | undefined {
  return hasText(v) ? v.trim().slice(0, max) : undefined;
}

/** One offered option: a bare string, or an object with a label and maybe a description. */
function optionOf(raw: unknown): { label: string; description?: string } | undefined {
  const label = capped(isRecord(raw) ? raw.label : raw, QUESTION_CAPS.label);
  if (label === undefined) return undefined;
  const description = isRecord(raw) ? capped(raw.description, QUESTION_CAPS.description) : undefined;
  return description === undefined ? { label } : { label, description };
}

/** One question entry, or undefined when it lacks the text or the option list a person needs to answer. */
function questionOf(raw: unknown): ToolQuestion | undefined {
  if (!isRecord(raw) || !Array.isArray(raw.options)) return undefined;
  const question = capped(raw.question, QUESTION_CAPS.question);
  if (question === undefined) return undefined;
  const options = raw.options.slice(0, QUESTION_CAPS.options).flatMap((o) => optionOf(o) ?? []);
  const parsed: ToolQuestion = { question, multiple: raw.multiple === true || raw.multiSelect === true, options };
  const header = capped(raw.header, QUESTION_CAPS.header);
  if (header !== undefined) parsed.header = header;
  return parsed;
}

/**
 * The questions in a call's arguments, or undefined when it asks nothing answerable.
 *
 * Tools that ask the person are told apart by what they send, not by their name, since every
 * harness names its asking tool differently. Two shapes are read: a `questions` list, and a single
 * `question` with `options` at the top level (Gentle's ask_user_choice), taken as a list of one.
 * Broken entries are dropped; if none survive, the call is not a question.
 */
function questionsIn(args: Args): ToolQuestion[] | undefined {
  let entries: unknown[] | undefined;
  if (Array.isArray(args.questions)) entries = args.questions;
  else if (typeof args.question === "string" && Array.isArray(args.options)) entries = [args];
  const parsed = (entries ?? []).slice(0, QUESTION_CAPS.questions).flatMap((q) => questionOf(q) ?? []);
  return parsed.length > 0 ? parsed : undefined;
}

/** Argument names that usually carry the point of a call, in the order they are preferred. */
const SUMMARY_KEYS = ["file_path", "command", "pattern", "query", "url", "path", "label", "description", "task", "prompt"];

/**
 * A call's arguments as one short line, used for `other` rows and as a fallback summary.
 *
 * The key order matters: a grep has both `pattern` and `path`, and the pattern is the point. A
 * question's first question wins over everything; failing all the known keys, the first string
 * value stands in.
 */
export function summarizeInput(input: unknown): string {
  if (input === null || typeof input !== "object") return "";
  const values: unknown[] = Array.isArray(input) ? input : Object.values(input);
  const args: Args = isRecord(input) ? input : {};
  const firstQuestion = Array.isArray(args.questions) && isRecord(args.questions[0]) ? capped(args.questions[0].question, QUESTION_CAPS.question) : undefined;
  const pick = firstQuestion ?? words(args, SUMMARY_KEYS) ?? values.find(hasText);
  return pick === undefined ? "" : oneLine(pick);
}

/**
 * The structured form of a call, from its name and arguments only. What came back (exit code,
 * output) is added later by whoever holds the result.
 */
export function classifyToolCall(name: string, input: unknown, summary = summarizeInput(input)): ToolCall {
  const args: Args = isRecord(input) ? input : {};
  // Shape before name: an asking tool can be called anything, even `bash`.
  const questions = questionsIn(args);
  if (questions !== undefined) return { kind: "question", name, summary: oneLine(questions[0]!.question), questions };
  const lowerName = name.toLowerCase();
  const family = FAMILY_BY_NAME.get(lowerName);
  if (family !== undefined) return family.read(args, lowerName, summary);
  const badge = badgeFor(lowerName, args);
  return badge === undefined ? { kind: "other", name, summary } : { kind: "other", name, summary, badge };
}

// ---------------------------------------------------------------------------------------------
// Badged tool sets. Each recogniser looks at the lower-cased name and returns a badge or nothing.

type Recogniser = (lowerName: string, args: Args) => ToolBadge | undefined;

/** Engram memory tools, bare (`mem_save`) or behind an MCP prefix (`mcp__engram__mem_save`). */
const engram: Recogniser = (lowerName, args) => {
  const op = /(?:^|__)mem_([a-z][a-z_]*)$/.exec(lowerName)?.[1];
  if (op === undefined) return undefined;
  const rawId = args.id ?? args.observation_id;
  const ref = typeof rawId === "number" || hasText(rawId) ? `#${String(rawId).trim()}` : undefined;
  const title = words(args, ["title"]);
  const query = words(args, ["query"]);
  // Past-tense verbs read as a log of what the agent did with its memory.
  const known: Record<string, [string, string | undefined]> = {
    save: ["saved", title],
    update: ["updated", title ?? ref],
    search: ["searched", query],
    get_observation: ["read", ref],
    context: ["context", undefined],
    session_summary: ["session summary", undefined],
  };
  const [action, subject] = Object.hasOwn(known, op) ? known[op]! : [op.replace(/_/g, " "), title ?? query ?? ref];
  return { glyph: "🧠", action, subject: oneLine(subject ?? ""), label: "Engram" };
};

/** The lens a review capture runs (`artifactSubject.lens` inside its JSON collect binding), without its `review-` prefix. */
function lensOf(binding: unknown): string | undefined {
  if (typeof binding !== "string") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(binding);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  const subject = parsed.artifactSubject ?? parsed.artifact_subject;
  const lens = isRecord(subject) ? subject.lens : undefined;
  return typeof lens === "string" && lens !== "" ? lens.replace(/^review-/, "") : undefined;
}

/** Gentle's review tools, titled the way Gentle titles them: "rdd <operation>", "rdd capture · <lens>". */
const review: Recogniser = (lowerName, args) => {
  const match = /^gentle_review(?:_([a-z_]+))?$/.exec(lowerName);
  if (match === null) return undefined;
  const sub = match[1];
  let action: string;
  if (sub === undefined) {
    const op = words(args, ["operation"]);
    action = op === undefined ? "rdd" : `rdd ${oneLine(op.replaceAll("-", " "))}`;
  } else {
    const lenses = sub === "capture" ? [lensOf(args.collectBinding)] : sub === "capture_group" && Array.isArray(args.collectBindings) ? args.collectBindings.map(lensOf) : [];
    action = [`rdd ${sub.replace(/_/g, " ")}`, ...lenses.filter((l) => l !== undefined)].join(" · ");
  }
  return { glyph: "🌹", action, subject: "", label: "RDD" };
};

/** Gentle's codemode: the first line of the script on the row, the whole script in the open card. */
const codemode: Recogniser = (lowerName, args) => {
  if (lowerName !== "codemode") return undefined;
  const script = words(args, ["code"]) ?? "";
  const lines = script.split("\n");
  const firstLine = lines.find((l) => l.trim() !== "");
  const badge: ToolBadge = { glyph: "λ", action: "code", subject: firstLine === undefined ? "" : oneLine(firstLine), label: "Code" };
  if (firstLine !== undefined) {
    // Leading blank lines are noise in the card; the first real line keeps its indentation.
    badge.body = lines.slice(lines.findIndex((l) => l.trim() !== "")).join("\n").trimEnd();
  }
  return badge;
};

/** Gentle's todo tool: "❀ todo <action> <title>". */
const todo: Recogniser = (lowerName, args) => {
  if (lowerName !== "todo") return undefined;
  const action = words(args, ["action"]);
  return { glyph: "❀", action: action === undefined ? "todo" : `todo ${oneLine(action)}`, subject: oneLine(words(args, ["title"]) ?? ""), label: "Todos" };
};

/** Gentle's subagent housekeeping tools ("❀ agent result"). Starting an agent is a `task`, not one of these. */
const AGENT_OPS = new Set(["result", "status", "continue", "cancel", "send_message", "reply", "list_tasks", "list_agents"]);
const agentOps: Recogniser = (lowerName, args) => {
  const op = /^subagent_([a-z_]+)$/.exec(lowerName)?.[1];
  if (op === undefined || !AGENT_OPS.has(op)) return undefined;
  return { glyph: "❀", action: `agent ${op.replace(/_/g, " ")}`, subject: oneLine(words(args, ["task_id", "label", "agent"]) ?? ""), label: "Agents" };
};

const RECOGNISERS: readonly Recogniser[] = [engram, review, codemode, todo, agentOps];

function badgeFor(lowerName: string, args: Args): ToolBadge | undefined {
  for (const recognise of RECOGNISERS) {
    const badge = recognise(lowerName, args);
    if (badge !== undefined) return badge;
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Review results. Gentle's review tools answer with a JSON envelope; its own card shows a short
// line made of the first field found in each group below (top level first, then inside `result`).

const OUTCOME_FIELDS: readonly (readonly string[])[] = [
  ["status", "state"],
  ["outcome"],
  ["risk", "risk_tier", "riskLevel"],
  ["action", "provider_action"],
  ["next_transition.reason_code", "nextTransition.reasonCode", "next_transition", "nextTransition", "reason_code", "reasonCode", "diagnostics.error_code"],
  ["diagnostics.message", "diagnostics.stderr", "error.message", "error", "reasons.0.detail", "reason", "message"],
];

/** Digests are ids, not words; showing one would only add noise. */
const DIGEST = /^(?:sha256:)?[0-9a-f]{32,}$/i;

/**
 * The string at a dotted path into nested objects and arrays ("reasons.0.detail"), cut to its
 * first clause with exception class prefixes ("TypeError: ") dropped; undefined when absent.
 */
function clauseAt(root: Record<string, unknown>, path: string): string | undefined {
  let value: unknown = root;
  for (const step of path.split(".")) {
    if (Array.isArray(value)) value = value[Number(step)];
    else if (isRecord(value)) value = value[step];
    else return undefined;
  }
  if (typeof value !== "string") return undefined;
  const head = value.split("\n")[0]!.split("; ")[0]!;
  const text = head.replace(/(^|: )\w*Error: /g, "$1").replace(/\s+/g, " ").trim();
  return text === "" || DIGEST.test(text) ? undefined : text;
}

/**
 * A review result as the parts of its one-line summary (["ready", "start", "fresh_target_ready"]),
 * or undefined when it is not a JSON object or holds none of the fields.
 */
export function rddSummary(text: string): string[] | undefined {
  const body = text.trim();
  if (!body.startsWith("{")) return undefined;
  let envelope: unknown;
  try {
    envelope = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (!isRecord(envelope)) return undefined;
  const places = isRecord(envelope.result) ? [envelope, envelope.result] : [envelope];
  const parts: string[] = [];
  for (const group of OUTCOME_FIELDS) {
    let found: string | undefined;
    for (const place of places) {
      for (const path of group) {
        found = clauseAt(place, path);
        if (found !== undefined) break;
      }
      if (found !== undefined) break;
    }
    if (found === undefined) continue;
    const part = oneLine(found);
    if (!parts.includes(part)) parts.push(part);
  }
  return parts.length > 0 ? parts : undefined;
}

