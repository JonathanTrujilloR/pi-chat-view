// The session as chat items: the entries of Pi's active branch, read in order, become the blocks
// the chat draws (what the person said, replies, thinking, tool steps, notices, compaction marks).
//
// The input is `sessionManager.getBranch()`, a path from the root to the current leaf, so there
// are no rewinds or siblings to track: each entry is read once, in order.
//
// No Pi, TUI or clock in here, so every rule can be checked with plain data.

import { applyResult, countImages, drawableImages, OUTPUT_LIMIT, requestedDiff } from "./results.ts";
import { isRelayedWake, postedNotice, shellNotice, staleAgentResult } from "./notices.ts";
import { classifyToolCall, type ToolCall } from "./tool-call.ts";
import { isRecord, stripAnsi, textOf } from "./text.ts";

/** How a tool call ended. "denied" is not "failed": nothing broke, someone said no. */
export type ChatToolStatus = "running" | "done" | "failed" | "denied";

/** One diff line. `@` is a hunk header, or a blank divider between separate replacements. */
export interface DiffLine {
  op: "+" | "-" | " " | "@";
  text: string;
}

/** An image block as Pi stored it. Held by reference so its base64 is never copied. */
export interface ImageData {
  data: string;
  mimeType: string;
}

/**
 * A call plus what came back. `outputLines` counts the whole output and is set only when `output`
 * was cut short. `diff` and `write` feed an edit's card: the change, and whether it replaced the file.
 */
export type ChatToolCall = ToolCall & {
  output?: string;
  outputLines?: number;
  diff?: DiffLine[];
  write?: true;
  images?: number;
  imageData?: ImageData[];
  /** A question's picks: one list of labels per question, in question order. */
  chosen?: string[][];
  /** Why a question failed before reaching the person: the first line of its error. */
  failure?: string;
};

/** One block of the chat. `ts` is the ISO timestamp of the entry it came from. */
export type ChatItem =
  // `images`: how many images were attached (the chat marks them; Terminal draws them). `imageData`: the drawable ones.
  | { id: string; ts?: string; kind: "user"; text: string; images?: number; imageData?: ImageData[] }
  // `partial`: still streaming; the view shows a cursor at its end until it clears.
  | { id: string; ts?: string; kind: "reply"; text: string; partial?: true }
  | { id: string; ts?: string; kind: "thinking"; text: string; partial?: true }
  // `title`: a heading shown while folded (background jobs). `label`: the leading glyph and name, drawn in colour.
  | { id: string; ts?: string; kind: "notice"; text: string; title?: string; error?: true; label?: string }
  // `text`: the model's recap of what was compacted; the view decides whether to show it.
  | { id: string; ts?: string; kind: "compacted"; text?: string }
  // `ts`: when the call was made; `end`: when its result was stored.
  | { id: string; ts?: string; end?: string; kind: "tool"; tool: ChatToolCall; status: ChatToolStatus };

/** The fields of a Pi session entry read here. */
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
  /** A `custom` entry's own payload (only Gentle's stale agent result is drawn from it). */
  data?: unknown;
}

/**
 * Gentle's bookkeeping tools: traffic between the harness and the model, not work the person
 * follows. They produce no item, so they are neither drawn nor counted; Terminal still shows them.
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

/** True for a tool the chat leaves out: a listed one, or anything in the `orchestrator_` namespace. */
export function isHiddenTool(name: string): boolean {
  return HIDDEN_TOOLS.has(name) || name.startsWith("orchestrator_");
}

/** An assistant message mid-stream, as Pi's `message_update` event carries it. */
export interface StreamingMessage {
  role?: string;
  content?: unknown;
  timestamp?: number;
}

export interface ItemsOptions {
  /** The assistant message being written right now; its items are added with `partial` set. */
  streaming?: StreamingMessage;
  /**
   * Calls the live layer saw start and not finish. When given, an unanswered call that is not in
   * it and not part of the latest assistant turn will never be answered (the process died, Pi was
   * reloaded), so it is drawn failed. When absent, every unanswered call counts as running.
   */
  runningToolCallIds?: ReadonlySet<string>;
}

/** Characters of tool output kept on an item. */
export const MAX_OUTPUT_CHARS = OUTPUT_LIMIT;

type ToolItem = Extract<ChatItem, { kind: "tool" }>;

/** Stop reasons that mean the turn broke off. `stop` and `toolUse` are normal endings. */
const BROKEN_OFF = new Set(["error", "aborted"]);

/** What reading a message's blocks yields: the items, and the tool calls that can be answered by id. */
interface Blocks {
  items: ChatItem[];
  answerable: ToolItem[];
}

/**
 * A user or assistant message's content as items, one per meaningful block. Item ids are
 * `<base>:<block index>`, except tool calls, which keep the call id their result will quote.
 * Calls to hidden tools are skipped and their ids handed to `hide`, so the result is skipped too.
 */
function readBlocks(content: unknown, base: string, ts: string | undefined, fromUser: boolean, streaming: boolean, hide: (callId: string) => void): Blocks {
  const out: Blocks = { items: [], answerable: [] };
  let blocks: unknown[] = [];
  if (typeof content === "string") blocks = [{ type: "text", text: content }];
  else if (Array.isArray(content)) blocks = content;
  const live = streaming ? { partial: true as const } : {};

  blocks.forEach((block, index) => {
    if (!isRecord(block)) return;
    const id = `${base}:${index}`;
    switch (block.type) {
      case "text": {
        if (typeof block.text !== "string" || block.text.trim() === "") return;
        const text = stripAnsi(block.text);
        if (!fromUser) out.items.push({ id, ts, kind: "reply", text, ...live });
        // An extension's wake-up sent as the user is not something the person said.
        else if (!isRelayedWake(text)) out.items.push({ id, ts, kind: "user", text });
        return;
      }
      case "thinking":
        if (!fromUser && typeof block.thinking === "string" && block.thinking.trim() !== "") {
          out.items.push({ id, ts, kind: "thinking", text: stripAnsi(block.thinking), ...live });
        }
        return;
      case "toolCall": {
        if (fromUser) return;
        const name = typeof block.name === "string" ? block.name : "tool";
        const callId = typeof block.id === "string" ? block.id : undefined;
        if (isHiddenTool(name)) {
          if (callId !== undefined) hide(callId);
          return;
        }
        const item: ToolItem = { id: callId ?? id, ts, kind: "tool", tool: classifyToolCall(name, block.arguments), status: "running" };
        // Show the requested change right away; a diff in the result replaces it later.
        if (item.tool.kind === "edit") Object.assign(item.tool, requestedDiff(block.arguments));
        out.items.push(item);
        if (callId !== undefined) out.answerable.push(item);
        return;
      }
    }
  });
  return out;
}

/** A call waiting for its result, and where it sits in the item list. */
interface Pending {
  item: ToolItem;
  index: number;
}

/**
 * The items read so far and what is needed to keep reading. Items already in the list are never
 * modified: an answered call is swapped for an updated copy, so any object the view received keeps
 * its content and can be cached by identity.
 */
class Transcript {
  readonly items: ChatItem[] = [];
  /** Unanswered calls by call id. */
  readonly pending = new Map<string, Pending>();
  /** Ids of hidden calls whose result has not come yet. */
  readonly hidden = new Set<string>();
  /** Item ids of the latest assistant turn's calls: these may still be queued, so they are never stale. */
  latestTurn = new Set<string>();

  read(entry: SessionEntryLike): void {
    const ts = entry.timestamp || undefined;
    switch (entry.type) {
      case "compaction":
      case "branch_summary": {
        // One mark per compaction, recap or not: the model's context changed either way.
        const recap = typeof entry.summary === "string" ? stripAnsi(entry.summary) : "";
        this.items.push(recap.trim() !== "" ? { id: entry.id, ts, kind: "compacted", text: recap } : { id: entry.id, ts, kind: "compacted" });
        return;
      }
      case "custom_message":
        this.post(entry.id, ts, entry.customType, entry.content, entry.details, entry.display);
        return;
      case "custom":
        if (entry.customType === "gentle-agents.stale-result") this.items.push(staleAgentResult(entry.id, ts, entry.data));
        return;
      case "message":
        if (isRecord(entry.message)) this.readMessage(entry.id, ts, entry.message);
        return;
    }
  }

  /** A message an extension posted. `display: false` means it was meant for the model only. */
  private post(id: string, ts: string | undefined, type: unknown, content: unknown, details: unknown, display: unknown): void {
    if (display !== true) return;
    const notice = postedNotice(id, ts, type, stripAnsi(textOf(content)), details);
    if (notice !== undefined) this.items.push(notice);
  }

  private readMessage(id: string, ts: string | undefined, m: Record<string, unknown>): void {
    switch (m.role) {
      case "toolResult":
        this.answer(id, ts, m);
        return;
      case "bashExecution": {
        const text = shellNotice(m);
        if (text !== undefined) this.items.push({ id, ts, kind: "notice", text });
        return;
      }
      case "custom":
        this.post(id, ts, m.customType, m.content, m.details, m.display);
        return;
      case "compactionSummary":
      case "branchSummary":
        this.items.push({ id, ts, kind: "compacted" });
        return;
      case "user":
      case "assistant":
        this.readTurn(id, ts, m);
        return;
    }
  }

  private answer(id: string, ts: string | undefined, m: Record<string, unknown>): void {
    const callId = typeof m.toolCallId === "string" ? m.toolCallId : "";
    if (this.hidden.delete(callId)) return;
    const text = stripAnsi(textOf(m.content));
    const isError = m.isError === true;
    const waiting = this.pending.get(callId);
    if (waiting !== undefined) {
      this.pending.delete(callId);
      const answered: ToolItem = { ...waiting.item, tool: { ...waiting.item.tool } };
      applyResult(answered, text, isError, m.details, m.content);
      if (ts !== undefined) answered.end = ts;
      this.items[waiting.index] = answered;
      return;
    }
    // A result whose call is unknown still has something to show; dropping it would hide output.
    if (text.trim() === "" && countImages(m.content) === 0) return;
    const name = typeof m.toolName === "string" ? m.toolName : "result";
    const stray: ToolItem = { id, ts, kind: "tool", tool: { kind: "other", name, summary: "" }, status: "running" };
    applyResult(stray, text, isError, undefined, m.content);
    if (ts !== undefined) stray.end = ts;
    this.items.push(stray);
  }

  private readTurn(id: string, ts: string | undefined, m: Record<string, unknown>): void {
    const fromUser = m.role === "user";
    const { items, answerable } = readBlocks(m.content, id, ts, fromUser, false, (callId) => this.hidden.add(callId));
    if (fromUser) attachImages(items, id, ts, m.content);
    const offset = this.items.length;
    this.items.push(...items);
    for (const item of answerable) this.pending.set(item.id, { item, index: offset + items.indexOf(item) });
    if (fromUser) return;

    this.latestTurn = new Set(items.flatMap((i) => (i.kind === "tool" ? [i.id] : [])));
    // The harness, not the model, reports a broken-off turn; it gets its own id after the turn.
    if (typeof m.stopReason === "string" && BROKEN_OFF.has(m.stopReason) && typeof m.errorMessage === "string" && m.errorMessage.trim() !== "") {
      this.items.push({ id: `${id}:stop`, ts, kind: "notice", text: stripAnsi(m.errorMessage).trim() });
    }
  }

  /**
   * The items as the view should see them now: the stored ones, plus the message still streaming,
   * with calls that can no longer be answered marked failed. Does not change the transcript.
   */
  snapshot(opts: ItemsOptions): ChatItem[] {
    const out = this.items.slice();
    const unstaleable = new Set(this.latestTurn);
    const streaming = opts.streaming;
    if (isRecord(streaming)) {
      const stamp = typeof streaming.timestamp === "number" && Number.isFinite(streaming.timestamp) ? new Date(streaming.timestamp).toISOString() : undefined;
      // Streaming items exist only in this snapshot; their hidden calls are not remembered.
      const { items } = readBlocks(streaming.content, "streaming", stamp, false, true, () => {});
      out.push(...items);
      for (const item of items) if (item.kind === "tool") unstaleable.add(item.id);
    }
    const running = opts.runningToolCallIds;
    if (running === undefined) return out;
    for (const [callId, { item, index }] of this.pending) {
      if (!running.has(callId) && !unstaleable.has(item.id)) out[index] = abandoned(item);
    }
    return out;
  }
}

/**
 * Put a user message's image count (and drawable images) on its last text item, or on a new empty
 * item when the message was images alone, so the box that says "N images" always exists.
 */
function attachImages(items: ChatItem[], base: string, ts: string | undefined, content: unknown): void {
  const count = countImages(content);
  if (count === 0) return;
  let host = items.findLast((i): i is Extract<ChatItem, { kind: "user" }> => i.kind === "user");
  if (host === undefined) {
    host = { id: `${base}:images`, ts, kind: "user", text: "" };
    items.push(host);
  }
  host.images = count;
  const drawable = drawableImages(content);
  if (drawable.length > 0) host.imageData = drawable;
}

/** The failed copy of a call that will never be answered, made once per call so its identity is stable across renders. */
const abandonedCopies = new WeakMap<ToolItem, ToolItem>();
function abandoned(item: ToolItem): ToolItem {
  let copy = abandonedCopies.get(item);
  if (copy === undefined) {
    copy = { ...item, status: "failed" };
    abandonedCopies.set(item, copy);
  }
  return copy;
}

/**
 * The active branch as chat items.
 *
 * Tool results attach to their call by `toolCallId`; a `!command` becomes a notice; extension
 * messages show only when `display` is true; compactions and branch summaries leave a mark;
 * model changes, usage, labels and other bookkeeping draw nothing; an assistant turn that ended
 * in `error` or `aborted` is followed by a notice saying why.
 */
export function itemsFromEntries(entries: readonly SessionEntryLike[], opts: ItemsOptions = {}): ChatItem[] {
  const transcript = new Transcript();
  for (const entry of entries) transcript.read(entry);
  return transcript.snapshot(opts);
}

/** `itemsFromEntries` that remembers what it already read. */
export interface ItemsBuilder {
  build(entries: readonly SessionEntryLike[], opts?: ItemsOptions): ChatItem[];
  /** How many entries the last build took from the previous one instead of re-reading (for tests and the bench). */
  readonly reused: number;
}

/**
 * Rebuilds that read only what is new. Stored entries never change and a branch is a path from
 * the root, so if the branch still starts with the same entry and still has the last-read entry in
 * the same position, everything before it is unchanged and only later entries need reading. Any
 * other change (a jump in the tree, a fork, another session) reads from scratch. The result is
 * always identical to `itemsFromEntries(entries, opts)`.
 */
export function createItemsBuilder(): ItemsBuilder {
  let transcript = new Transcript();
  let read = 0;
  let head: string | undefined;
  let tail: string | undefined;
  let reused = 0;
  return {
    get reused() {
      return reused;
    },
    build(entries, opts = {}) {
      const extends_ = read > 0 && entries.length >= read && entries[0]?.id === head && entries[read - 1]?.id === tail;
      if (!extends_) {
        transcript = new Transcript();
        read = 0;
      }
      reused = read;
      for (const entry of entries.slice(read)) transcript.read(entry);
      read = entries.length;
      head = entries[0]?.id;
      tail = entries[read - 1]?.id;
      return transcript.snapshot(opts);
    },
  };
}
