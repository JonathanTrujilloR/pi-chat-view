// What a tool call came back with. A call is drawn the moment the model makes it; its result
// arrives later as a separate entry and fills in the status, output, exit code, diff or answer.

import type { ChatItem, ChatToolCall, DiffLine, ImageData } from "./items.ts";
import { rddSummary, type ToolCall } from "./tool-call.ts";
import { isRecord, splitLines, stripAnsi } from "./text.ts";

type ToolItem = Extract<ChatItem, { kind: "tool" }>;
type QuestionCall = Extract<ToolCall, { kind: "question" }> & ChatToolCall;

/** Output kept per call: about what the output card shows (200 lines). The rest is only counted. */
export const OUTPUT_LIMIT = 16000;

/** Diff lines kept per call. The card shows far fewer; keeping more only costs memory. */
const DIFF_LIMIT = 2000;

/** Kinds whose card has an output section. Edits, reads and deletes say nothing worth showing on success. */
const SHOWS_OUTPUT: ReadonlySet<ToolCall["kind"]> = new Set(["execute", "search", "fetch", "task", "other"]);

/**
 * Pi's fixed wording when an extension refuses a call without giving its own reason. Only that
 * wording means "denied"; a custom reason could say anything, so it counts as an ordinary failure.
 */
const REFUSED = /^Tool execution was blocked/;

/** The trailer Pi adds to a shell result that exited non-zero. */
const EXIT_TRAILER = /(?:^|\n)Command exited with code (\d+)\s*$/;

/** How many image blocks a content value carries. */
export function countImages(content: unknown): number {
  if (!Array.isArray(content)) return 0;
  let n = 0;
  for (const block of content) if (isRecord(block) && block.type === "image") n++;
  return n;
}

/** The image blocks that can actually be drawn (data and MIME type present), kept by reference to avoid copying base64. */
export function drawableImages(content: unknown): ImageData[] {
  if (!Array.isArray(content)) return [];
  return content.filter(
    (b): b is ImageData => isRecord(b) && b.type === "image" && typeof b.data === "string" && b.data !== "" && typeof b.mimeType === "string",
  );
}

// ---------------------------------------------------------------------------------------------
// Diffs

/** The first of `keys` holding a string, empty included: an empty `newText` is a deletion, not a missing field. */
function stringField(obj: Record<string, unknown>, keys: readonly string[]): string | undefined {
  const key = keys.find((k) => typeof obj[k] === "string");
  return key === undefined ? undefined : (obj[key] as string);
}

/**
 * The change an edit call asked for, read from its own arguments, for when the result brings no
 * diff of its own (or has not arrived). Handles a list of replacements, a single replacement, or a
 * whole-file write (every line added). Unchanged context is unknown here, so none is shown.
 */
export function requestedDiff(args: unknown): { diff: DiffLine[]; write?: true } | undefined {
  if (!isRecord(args)) return undefined;
  const replacements = Array.isArray(args.edits) ? args.edits.filter(isRecord) : [args];
  const out: DiffLine[] = [];
  for (const r of replacements) {
    const removed = stringField(r, ["oldText", "old_string", "oldString"]);
    const added = stringField(r, ["newText", "new_string", "newString"]);
    if (removed === undefined && added === undefined) continue;
    // A blank hunk header keeps separate replacements visibly apart.
    if (out.length > 0) out.push({ op: "@", text: "" });
    if (removed) out.push(...splitLines(removed).map((text) => ({ op: "-" as const, text })));
    if (added) out.push(...splitLines(added).map((text) => ({ op: "+" as const, text })));
  }
  if (out.length > 0) return { diff: out.slice(0, DIFF_LIMIT) };
  const whole = stringField(args, ["content"]);
  if (whole === undefined) return undefined;
  return { diff: splitLines(whole).slice(0, DIFF_LIMIT).map((text) => ({ op: "+", text })), write: true };
}

/** Lines of a unified patch that describe files rather than content. */
const PATCH_PREAMBLE = /^(---|\+\+\+|diff |index |\\ )/;

/** A unified patch as diff lines: hunk headers kept, file headers dropped. */
function fromPatch(patch: string): DiffLine[] {
  const out: DiffLine[] = [];
  for (const line of splitLines(patch)) {
    if (PATCH_PREAMBLE.test(line)) continue;
    const sign = line[0];
    if (line.startsWith("@@")) out.push({ op: "@", text: line });
    else if (sign === "+" || sign === "-" || sign === " ") out.push({ op: sign, text: line.slice(1) });
  }
  return out;
}

/** Pi's display diff: each line a sign (or none), then a line number and the text; unsigned lines are context. */
function fromDisplayDiff(diff: string): DiffLine[] {
  return splitLines(diff).map((line) => {
    const sign = line[0];
    if (sign === "+" || sign === "-") return { op: sign, text: line.slice(1) };
    return { op: " ", text: sign === " " ? line.slice(1) : line };
  });
}

/** The diff stored with an edit's result: a unified `patch` when there is one, else Pi's display `diff`. */
function storedDiff(details: unknown): DiffLine[] | undefined {
  if (!isRecord(details)) return undefined;
  let out: DiffLine[] = [];
  if (typeof details.patch === "string" && details.patch.trim() !== "") out = fromPatch(stripAnsi(details.patch));
  else if (typeof details.diff === "string" && details.diff.trim() !== "") out = fromDisplayDiff(stripAnsi(details.diff));
  return out.length > 0 ? out.slice(0, DIFF_LIMIT) : undefined;
}

// ---------------------------------------------------------------------------------------------
// Answers to questions

/**
 * The labels in one stored answer. Tools record answers as a string, a list of strings,
 * `{ answers: [...] }`, `{ answer }`, or (multi-select) `{ answer: null, selected: [...] }`.
 */
function labelsOf(answer: unknown): string[] {
  if (typeof answer === "string") return answer.trim() === "" ? [] : [answer.trim()];
  if (Array.isArray(answer)) return answer.flatMap((l) => (typeof l === "string" && l.trim() !== "" ? [l.trim()] : []));
  if (!isRecord(answer)) return [];
  const direct = labelsOf(answer.answer).concat(labelsOf(answer.selected));
  return direct.length > 0 ? direct : labelsOf(answer.answers);
}

/**
 * The person's picks, one list per question in question order, from `details.answers`. That is
 * either a list (possibly tagged with `questionIndex`, which then decides the order) or an object
 * keyed by question text. Undefined when nothing was picked at all.
 */
function picksFrom(call: QuestionCall, details: unknown): string[][] | undefined {
  const answers = isRecord(details) ? details.answers : undefined;
  let perQuestion: string[][] = [];
  if (Array.isArray(answers)) {
    const tagged = answers.every((a) => isRecord(a) && typeof a.questionIndex === "number");
    const slots: unknown[] = [];
    if (tagged) for (const a of answers as Record<string, unknown>[]) slots[a.questionIndex as number] = a;
    perQuestion = Array.from(tagged ? slots : answers, labelsOf);
  } else if (isRecord(answers)) {
    perQuestion = call.questions.map((q) => labelsOf(answers[q.question]));
  }
  return perQuestion.some((labels) => labels.length > 0) ? perQuestion : undefined;
}

/** A single-choice tool that answers in prose: "User selected: 1. Porcentaje (value: porcentaje)". */
const SELECTED_REPLY = /^User selected: (?:\d+\. )?(.+?)(?: \(value: [^)]*\))?$/;

/**
 * Fill in a question's outcome. A failed question never reached the person, so it keeps only why
 * (one line). Otherwise the picks come from `details`, else from the prose reply, and the output
 * line is the picks joined, or the reply itself when the tool stored no structured answer.
 */
function settleQuestion(call: QuestionCall, text: string, isError: boolean, details: unknown): void {
  if (isError) {
    const why = text.trim().split("\n")[0]?.trim();
    if (why) call.failure = why.slice(0, 500);
    return;
  }
  const picks = picksFrom(call, details);
  let answer: string | undefined;
  if (picks !== undefined) {
    call.chosen = picks;
    answer = picks.map((labels) => labels.join(", ")).filter((s) => s !== "").join(" · ");
  } else {
    const selected = SELECTED_REPLY.exec(text.trim())?.[1];
    if (selected !== undefined) {
      call.chosen = call.questions.map((_q, i) => (i === 0 ? [selected] : []));
      answer = selected;
    } else if (!(isRecord(details) && details.answers !== undefined)) {
      answer = text.trim();
    }
  }
  if (answer) call.output = answer.slice(0, OUTPUT_LIMIT);
}

// ---------------------------------------------------------------------------------------------

/**
 * Apply a result to its call. `item` must be a fresh copy (its `tool` copied too): items already
 * handed to the view are never changed, so the view can cache rows by object identity.
 */
export function applyResult(item: ToolItem, text: string, isError: boolean, details: unknown, content: unknown): void {
  const call = item.tool;
  const images = countImages(content);
  if (images > 0) call.images = images;
  const drawable = drawableImages(content);
  if (drawable.length > 0) call.imageData = drawable;

  if (!isError) item.status = "done";
  else item.status = REFUSED.test(text) ? "denied" : "failed";

  switch (call.kind) {
    case "question":
      settleQuestion(call, text, isError, details);
      return;
    case "execute": {
      const exit = EXIT_TRAILER.exec(text);
      // Pi only adds the trailer on failure, so a clean result with none means exit 0.
      if (exit !== null) call.exitCode = Number(exit[1]);
      else if (!isError) call.exitCode = 0;
      break;
    }
    case "edit": {
      const diff = storedDiff(details);
      if (diff !== undefined) call.diff = diff;
      break;
    }
    case "other":
      // Review tools report an outcome the row shows next to the step.
      if (call.badge?.label === "RDD") {
        const parts = rddSummary(text);
        call.badge = parts === undefined ? { ...call.badge } : { ...call.badge, result: parts[0]!, summary: parts.join(" · ") };
      }
      break;
  }

  // A failure's text explains it, whatever the kind; a refusal is told by its status alone.
  const keepOutput = SHOWS_OUTPUT.has(call.kind) || item.status === "failed";
  if (keepOutput && text.trim() !== "") {
    call.output = text.slice(0, OUTPUT_LIMIT);
    if (text.length > OUTPUT_LIMIT) call.outputLines = splitLines(text.trimEnd()).length;
  }
}
