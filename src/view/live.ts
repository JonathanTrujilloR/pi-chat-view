// Live updates: what is streaming and running right now, and a throttled rebuild while Chat is open.
//
// Pure: events come in as plain objects and timers are injected, so the rules are testable with a
// hand-moved clock. `index.ts` feeds it Pi's events.

import { isRecord } from "../model/text.ts";
import type { ItemsOptions, SessionEntryLike, StreamingMessage } from "../model/items.ts";

/** Events that change what the chat draws. `tool_execution_update` is not one: output is not shown. */
export const LIVE_EVENTS = [
  "message_update",
  "message_end",
  "tool_execution_start",
  "tool_execution_end",
  "turn_end",
  "agent_settled",
  "session_tree",
  "session_compact",
  "session_start",
] as const;

const REBUILDS = new Set<string>(LIVE_EVENTS);

/** The fields of a Pi event read here. */
export interface LiveEvent {
  type: string;
  message?: unknown;
  toolCallId?: unknown;
}

export interface LiveState {
  /** The assistant message still being written, as the last `message_update` carried it. */
  readonly streaming: StreamingMessage | undefined;
  /** Tool calls that started and have not ended. */
  readonly running: ReadonlySet<string>;
  apply(event: LiveEvent): void;
  reset(): void;
}

export function createLiveState(): LiveState {
  let streaming: StreamingMessage | undefined;
  const running = new Set<string>();
  return {
    get streaming() {
      return streaming;
    },
    running,
    apply(event) {
      const id = typeof event.toolCallId === "string" ? event.toolCallId : undefined;
      switch (event.type) {
        case "message_update":
          if (isRecord(event.message) && event.message.role === "assistant") streaming = event.message as StreamingMessage;
          break;
        case "message_end":
          if (isRecord(event.message) && event.message.role === "assistant") streaming = undefined;
          break;
        case "tool_execution_start":
          if (id !== undefined) running.add(id);
          break;
        case "tool_execution_end":
          if (id !== undefined) running.delete(id);
          break;
        // Nothing streams or runs once the agent has settled, or in a new session.
        case "agent_settled":
        case "session_start":
          streaming = undefined;
          running.clear();
          break;
      }
    },
    reset() {
      streaming = undefined;
      running.clear();
    },
  };
}

/**
 * The live state as `itemsFromEntries` options for this branch. A streaming message Pi already
 * stored (same assistant timestamp) is dropped, so it is never drawn twice. It belongs to the turn
 * in progress, so only the entries after the latest user message are looked at, newest first: the
 * cost is that turn's, not the session's.
 */
export function liveOptions(state: LiveState, branch: readonly SessionEntryLike[]): ItemsOptions {
  const opts: ItemsOptions = { runningToolCallIds: new Set(state.running) };
  const streaming = state.streaming;
  if (streaming === undefined) return opts;
  let stored = false;
  if (streaming.timestamp !== undefined) {
    for (let i = branch.length - 1; i >= 0; i--) {
      const m = branch[i]!.message;
      if (branch[i]!.type !== "message" || !isRecord(m)) continue;
      if (m.role === "user") break;
      if (m.role === "assistant" && m.timestamp === streaming.timestamp) {
        stored = true;
        break;
      }
    }
  }
  if (!stored) opts.streaming = streaming;
  return opts;
}

/** Whatever `setTimeout` hands back; only ever passed back to `clearTimeout`. */
export type TimerId = number | ReturnType<typeof setTimeout>;

export interface Timers {
  now(): number;
  setTimeout(fn: () => void, ms: number): TimerId;
  clearTimeout(id: TimerId): void;
}

const realTimers: Timers = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const t = setTimeout(fn, ms);
    // Node hands back a Timeout; a rebuild must never keep Pi's process alive on exit.
    // SAFETY: Node returns a Timeout object with unref(), browsers a number; both shapes are checked below.
    const handle = t as unknown as { unref?: () => void } | number;
    if (typeof handle === "object" && typeof handle.unref === "function") handle.unref();
    return t;
  },
  clearTimeout: (id) => clearTimeout(id),
};

export interface Throttle {
  /** Run soon: never synchronously, at most once per interval, and always after the last call. */
  schedule(): void;
  cancel(): void;
}

/**
 * Trailing throttle. Always deferred, even the first run, so an event handler that fires before
 * Pi has stored its entry still sees the stored branch when the rebuild runs.
 */
export function createThrottle(fn: () => void, intervalMs: number, timers: Timers): Throttle {
  let timer: TimerId | undefined;
  let pending = false;
  let last = -Infinity;
  return {
    schedule() {
      if (pending) return;
      pending = true;
      timer = timers.setTimeout(() => {
        pending = false;
        timer = undefined;
        last = timers.now();
        fn();
      }, Math.max(0, last + intervalMs - timers.now()));
    },
    cancel() {
      if (timer !== undefined) timers.clearTimeout(timer);
      pending = false;
      timer = undefined;
    },
  };
}

/** Rebuilds at most this often while streaming: smooth enough to read, cheap enough to ignore. */
const LIVE_INTERVAL_MS = 80;

export interface LiveFeedDeps {
  isOpen(): boolean;
  refresh(): void;
  timers?: Timers;
  intervalMs?: number;
}

export interface LiveFeed {
  readonly state: LiveState;
  /** Every Pi event of interest. Tracked always; rebuilds only while Chat is open. */
  onEvent(event: LiveEvent): void;
  /** Drop a pending rebuild: Chat closed or the session ended. */
  stop(): void;
}

export function createLiveFeed(deps: LiveFeedDeps): LiveFeed {
  const state = createLiveState();
  const throttle = createThrottle(
    () => {
      if (deps.isOpen()) deps.refresh();
    },
    deps.intervalMs ?? LIVE_INTERVAL_MS,
    deps.timers ?? realTimers,
  );
  return {
    state,
    onEvent(event) {
      state.apply(event);
      if (deps.isOpen() && REBUILDS.has(event.type)) throttle.schedule();
    },
    stop: () => throttle.cancel(),
  };
}
