// A synthetic Pi session, shaped like a real one: no user data, deterministic.
//
// Each turn: a user message (every 10th with an image), an assistant message with a thought and
// 3-6 tool calls (bash / read / edit), their results (~40-line outputs), then a reply of ~15
// Markdown lines with a code block.

import type { SessionEntryLike } from "../src/model/items.ts";

const PNG = "iVBORw0KGgo" + "A".repeat(2000);

function output(turn: number, call: number): string {
  return Array.from({ length: 40 }, (_, i) => `out ${turn}.${call} line ${i}: some value ${(i * 7919) % 1000} here`).join("\n");
}

function reply(turn: number): string {
  return [
    `## Turn ${turn}`,
    "",
    `I looked at the **files** and changed \`src/a${turn}.ts\`. The fix is small:`,
    "",
    "```ts",
    `export function f${turn}(x: number): number {`,
    "  return x * 2 + 1;",
    "}",
    "```",
    "",
    "- first point about the change",
    "- second point, a bit longer so it wraps on a narrow terminal width somewhere",
    "- third point",
    "",
    "That is all for now; tests pass.",
  ].join("\n");
}

const iso = (s: number) => new Date(Date.UTC(2026, 9, 1, 0, 0, 0) + s * 1000).toISOString();

export function syntheticSession(turns: number): SessionEntryLike[] {
  const out: SessionEntryLike[] = [];
  let parent: string | null = null;
  let t = 0;
  const push = (id: string, message: Record<string, unknown>) => {
    out.push({ type: "message", id, parentId: parent, timestamp: iso(t++), message });
    parent = id;
  };
  for (let turn = 0; turn < turns; turn++) {
    const user: unknown[] = [{ type: "text", text: `Please look at module ${turn} and fix what is broken in it.` }];
    if (turn % 10 === 0) user.push({ type: "image", data: PNG, mimeType: "image/png" });
    push(`u${turn}`, { role: "user", content: user, timestamp: t });
    const n = 3 + (turn % 4);
    const calls = Array.from({ length: n }, (_, c) => {
      const id = `c${turn}.${c}`;
      if (c % 3 === 0) return { type: "toolCall", id, name: "bash", arguments: { command: `npm test -- --grep m${turn}` } };
      if (c % 3 === 1) return { type: "toolCall", id, name: "read", arguments: { path: `src/m${turn}/file${c}.ts` } };
      return { type: "toolCall", id, name: "edit", arguments: { path: `src/m${turn}/file${c}.ts`, edits: [{ oldText: "a\nb\nc", newText: "a\nB\nc" }] } };
    });
    push(`a${turn}`, {
      role: "assistant",
      content: [{ type: "thinking", thinking: `I should check module ${turn} first.\nThen the tests.` }, ...calls],
      stopReason: "toolUse",
      timestamp: t,
    });
    for (const c of calls) {
      push(`r${c.id}`, { role: "toolResult", toolCallId: c.id, toolName: c.name, content: [{ type: "text", text: output(turn, n) }], isError: false, timestamp: t });
    }
    push(`f${turn}`, { role: "assistant", content: [{ type: "text", text: reply(turn) }], stopReason: "stop", timestamp: t });
  }
  return out;
}

/** The message a `message_update` carries mid-reply: `chars` characters of the next reply so far. */
export function streamingReply(turn: number, chars: number) {
  return { role: "assistant", content: [{ type: "text", text: reply(turn).slice(0, chars) }], timestamp: 9_000_000 + turn };
}
