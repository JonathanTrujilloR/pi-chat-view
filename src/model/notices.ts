// Notices: the rows that are neither the person, the model, nor a tool. Extensions post messages
// into the session (agent results, background job reports, messages from other sessions), the
// person runs `!commands`, and the harness reports a turn that died. Each gets one quiet row,
// worded the way the extension that posted it words it in Terminal, so both views agree.

import type { ChatItem } from "./items.ts";
import { hasText, isRecord, stripAnsi } from "./text.ts";

type Notice = Extract<ChatItem, { kind: "notice" }>;

/** A string field cleaned for display, or undefined when blank or not a string. */
function cleanField(v: unknown): string | undefined {
  return hasText(v) ? stripAnsi(v).trim() : undefined;
}

/** The agent a Gentle Agents message is about, from `details.gentleAgents.agent`. */
function agentIn(details: unknown): string | undefined {
  const meta = isRecord(details) ? details.gentleAgents : undefined;
  return isRecord(meta) ? cleanField(meta.agent) : undefined;
}

/**
 * Message types with a fixed heading. `head` is the coloured part of the row; `extra` is
 * anything said between the heading and the message itself.
 */
const HEADINGS: Record<string, (agent: string | undefined) => { head: string; extra?: string }> = {
  "gentle-pi.review-preflight": () => ({ head: "✿ Gentle AI · review preflight" }),
  "gentle-agents.result": (agent) => ({ head: "❀  Agent result", extra: agent }),
  "gentle-agents.message": (agent) => ({ head: `❀  ${agent ?? "Subagent"} message` }),
  "gentle-agents.orchestrator-message": () => ({ head: "❀  Session message" }),
  "gentle-agents.stale-result": () => ({ head: "❀  Stale agent result" }),
};

const JOB_NOTICE = "gentle-jobs.notice";
const INTERCOM = "intercom_message";

/** A monitor's progress line: 'Monitor job-4 ("label") reported 1 new line:'. */
const MONITOR_PROGRESS = /^Monitor \S+ \("(.*)"\) reported (\d+ new lines?):$/;
/** How a job or monitor ended: 'Background job job-2 ("build") exited with code 1 after 3s.' */
const JOB_ENDED = /^(Background job|Monitor) \S+ \("(.*)"\) (.+?)(?: after ((?:\d+[hms] ?)+))?(?:, \d+ events?)?\.$/;

/**
 * A background job's report as a heading, "⧗ Background job · <label> · exited 1 after 4s", and
 * whether it went wrong. Structured `details.gentleJobs` is trusted first; otherwise the first line
 * of the text is parsed. Text of an unknown shape keeps its first line as the heading.
 */
function jobHeading(text: string, details: unknown): { title: string; error: boolean } {
  const meta = isRecord(details) && isRecord(details.gentleJobs) ? details.gentleJobs : {};
  const metaLabel = cleanField(meta.label);
  const top = text.split("\n")[0]!.trim();

  const progress = MONITOR_PROGRESS.exec(top);
  if (progress !== null) return { title: `⧗ Monitor · ${metaLabel ?? progress[1]!} · ${progress[2]}`, error: false };

  // Some reports put the command right after the first sentence; retry with that first sentence alone.
  const ended = JOB_ENDED.exec(top) ?? JOB_ENDED.exec(top.replace(/^(.*?\.)\s+[A-Z][a-z]+:.*$/, "$1"));
  const noun = meta.kind === "monitor" || ended?.[1] === "Monitor" ? "Monitor" : "Background job";
  const label = metaLabel ?? ended?.[2];
  const parsedCode = ended === null ? undefined : /^exited with code (-?\d+)$/.exec(ended[3]!)?.[1];
  let code = parsedCode === undefined ? NaN : Number(parsedCode);
  if (typeof meta.exitCode === "number") code = meta.exitCode;
  const exited = Number.isFinite(code);

  let outcome: string | undefined;
  if (ended !== null) {
    outcome = exited ? `exited ${code}` : ended[3]!.replace(/^was stopped by the user$/, "stopped");
    if (ended[4] !== undefined) outcome += ` after ${ended[4].trim()}`;
  }
  const parts = [`⧗ ${noun}`];
  if (label !== undefined) parts.push(label);
  if (outcome !== undefined) parts.push(outcome);
  if (parts.length === 1) parts.push(top);
  return { title: parts.join(" · "), error: (exited && code !== 0) || meta.status === "failed" };
}

/**
 * A message from another Pi session (pi-intercom) as "✉ From <sender> · <body>". The sender is
 * the stored name, else a short id, else the bold "**From X**" line of the text. The body is the
 * stored body, else the text after its delivery header; reply instructions are left out.
 */
function intercom(raw: string, details: unknown): { label: string; text: string } {
  const d = isRecord(details) ? details : {};
  const from = isRecord(d.from) ? d.from : {};
  const shortId = typeof from.id === "string" && from.id !== "" ? from.id.slice(0, 8) : undefined;
  const sender = (hasText(from.name) ? from.name.trim() : undefined) ?? shortId ?? /^\*\*From (.+?)\*\*/.exec(raw.trim())?.[1] ?? "intercom";
  const label = `✉ From ${stripAnsi(sender)}`;
  let body: string;
  if (typeof d.bodyText === "string") body = stripAnsi(d.bodyText).trim();
  else {
    // Paragraphs: header, sometimes metadata, then the body, sometimes followed by how to reply.
    const paras = raw.trim().split(/\n\s*\n/);
    const bodyStart = Math.min(paras.length, 4) - 1;
    const kept = paras.length >= 3 ? paras.slice(bodyStart) : paras.slice(-1);
    body = kept.join("\n\n").trim();
  }
  return { label, text: body === "" ? label : `${label} · ${body}` };
}

/** A message an extension posted for the person, as a notice; undefined when there is nothing in it. */
export function postedNotice(id: string, ts: string | undefined, type: unknown, raw: string, details: unknown): Notice | undefined {
  const text = raw.trim();
  if (text === "") return undefined;
  if (type === JOB_NOTICE) {
    const { title, error } = jobHeading(text, details);
    const notice: Notice = { id, ts, kind: "notice", text, title, label: title.startsWith("⧗ Monitor") ? "⧗ Monitor" : "⧗ Background job" };
    if (error) notice.error = true;
    return notice;
  }
  if (type === INTERCOM) return { id, ts, kind: "notice", ...intercom(raw, details) };
  const heading = typeof type === "string" && Object.hasOwn(HEADINGS, type) ? HEADINGS[type]!(agentIn(details)) : undefined;
  // Unknown types are shown as they came, untrimmed: their layout is their own.
  if (heading === undefined) return { id, ts, kind: "notice", text: raw };
  const line = [heading.head, ...(heading.extra === undefined ? [] : [heading.extra]), text].join(" · ");
  return { id, ts, kind: "notice", text: line, label: heading.head };
}

/** "45s", "3m", "2h": an age as Gentle words it, rounded to the largest sensible unit. */
function roughAge(seconds: number): string {
  if (seconds < 90) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${Math.round(seconds / 3600)}h`;
}

/**
 * An agent result that came back after its session moved on. Gentle records it as a `custom`
 * entry rather than a message; it is shown folded, with the same two sentences Gentle prints.
 */
export function staleAgentResult(id: string, ts: string | undefined, data: unknown): Notice {
  const d = isRecord(data) ? data : {};
  const say = (v: unknown, otherwise: string) => (typeof v === "string" ? stripAnsi(v) : otherwise);
  const task = say(d.taskId, "unknown");
  const agent = say(d.agent, "Subagent");
  // Gentle replaces only the first underscore ("timed_out" → "timed out"); kept so the wording matches.
  const status = typeof d.status === "string" ? stripAnsi(d.status).replace("_", " ") : "unknown";
  const age = typeof d.ageSeconds === "number" && Number.isFinite(d.ageSeconds) ? Math.max(0, Math.round(d.ageSeconds)) : 0;
  const head = "❀  Stale agent result";
  return {
    id,
    ts,
    kind: "notice",
    label: head,
    title: `${head} · ${agent} · task ${task}`,
    text:
      `Subagent ${agent} (task ${task}, "${say(d.label, "")}") ${status} about ${roughAge(age)} ago, while the orchestrator was still busy.\n` +
      "Marked stale: the result was not replayed into the conversation. It stays available through subagent_status and subagent_result.",
  };
}

/** A `!command` the person ran: "$ <first line>", with "· cancelled" or "· exit N" when it ended badly. */
export function shellNotice(message: Record<string, unknown>): string | undefined {
  const command = typeof message.command === "string" ? message.command.trim() : "";
  if (command === "") return undefined;
  const head = `$ ${command.split("\n")[0]}`;
  if (message.cancelled === true) return `${head} · cancelled`;
  const code = message.exitCode;
  return typeof code === "number" && code !== 0 ? `${head} · exit ${code}` : head;
}

/**
 * True for a user-role message an extension wrote on its own behalf. Gentle Agents' wake-ups
 * open with "[System-generated <who> notification, not written by the user]"; the result notice
 * right before already says what arrived, so the wake-up itself is not drawn.
 */
export function isRelayedWake(text: string): boolean {
  return /^\[System-generated .+? notification, not written by the user\]/.test(text);
}
