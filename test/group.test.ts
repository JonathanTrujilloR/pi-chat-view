import { test } from "node:test";
import assert from "node:assert/strict";

import type { ChatItem, ChatToolCall, ChatToolStatus } from "../src/model/items.ts";
import { earlierLabel, groupRuns, LIVE_TAIL, runSummary, shortPath, standsAlone, stepLine } from "../src/model/group.ts";

let n = 0;
function tool(t: ChatToolCall, status: ChatToolStatus = "done"): ChatItem {
  return { id: `t${++n}`, kind: "tool", tool: t, status };
}
const cmd = (status?: ChatToolStatus) => tool({ kind: "execute", command: "ls" }, status);
const edit = () => tool({ kind: "edit", path: "a.ts" });
const think = (): ChatItem => ({ id: `th${++n}`, kind: "thinking", text: "hmm" });
const reply = (): ChatItem => ({ id: `r${++n}`, kind: "reply", text: "ok" });
const task = () => tool({ kind: "task", agent: "explore", summary: "look" });
const question = () => tool({ kind: "question", name: "ask", summary: "Q?", questions: [] });
const shape = (groups: ChatItem[][]) => groups.map((g) => g.length);

test("groupRuns: minRun boundaries — 2 stay single, 3 fold", () => {
  assert.deepEqual(shape(groupRuns([cmd(), cmd()])), [1, 1]);
  assert.deepEqual(shape(groupRuns([cmd(), cmd(), cmd()])), [3]);
  assert.deepEqual(shape(groupRuns([cmd(), reply(), cmd(), cmd(), cmd()])), [1, 1, 3]);
  assert.deepEqual(shape(groupRuns([cmd(), cmd()], 1)), [2]);
  assert.deepEqual(shape(groupRuns([])), []);
});

test("groupRuns: thinking joins runs; tasks and questions stand alone and split runs", () => {
  assert.deepEqual(shape(groupRuns([think(), cmd(), edit()])), [3]);
  assert.deepEqual(shape(groupRuns([cmd(), cmd(), task(), cmd(), cmd(), cmd()])), [1, 1, 1, 3]);
  assert.deepEqual(shape(groupRuns([cmd(), cmd(), cmd(), question(), cmd()])), [3, 1, 1]);
  assert.equal(standsAlone(task()), true);
  assert.equal(standsAlone(question()), true);
  assert.equal(standsAlone(cmd()), false);
  assert.equal(standsAlone(reply()), false);
});

test("LIVE_TAIL is 6", () => assert.equal(LIVE_TAIL, 6));

test("runSummary: plurals per kind, in Collie's order, and failed counts denied", () => {
  const cases: [ChatItem[], { summary: string; failed: number }][] = [
    [[cmd(), cmd(), cmd(), edit(), edit()], { summary: "3 commands, 2 edits", failed: 0 }],
    [[cmd(), edit(), think()], { summary: "1 command, 1 edit", failed: 0 }],
    [
      [
        tool({ kind: "read", path: "a" }),
        tool({ kind: "search", query: "q" }),
        tool({ kind: "fetch", url: "u" }),
        task(),
        tool({ kind: "other", name: "x", summary: "" }),
        tool({ kind: "delete", path: "p" }),
      ],
      { summary: "1 read, 2 searches, 1 agent, 2 other steps", failed: 0 },
    ],
    [[cmd("failed"), cmd("denied"), cmd("running")], { summary: "3 commands", failed: 2 }],
  ];
  for (const [items, want] of cases) assert.deepEqual(runSummary(items), want);
});

test("earlierLabel: singular and plural", () => {
  assert.equal(earlierLabel(1, "2 commands"), "1 earlier step · 2 commands");
  assert.equal(earlierLabel(4, "2 commands"), "4 earlier steps · 2 commands");
});

test("stepLine per kind", () => {
  const home = "/home/someone";
  const cases: [ChatToolCall, { verb: string; subject: string; mono: boolean }][] = [
    [{ kind: "execute", command: "npm test\n--watch" }, { verb: "$", subject: "npm test", mono: true }],
    [{ kind: "execute", command: "npm test", description: "Run tests" }, { verb: "", subject: "Run tests", mono: false }],
    [{ kind: "edit", path: `${home}/x/a.ts` }, { verb: "Edited", subject: "~/x/a.ts", mono: true }],
    [{ kind: "read", path: "src/b.ts" }, { verb: "Read", subject: "src/b.ts", mono: true }],
    [{ kind: "search", query: "TODO" }, { verb: "Searched", subject: "TODO", mono: true }],
    [{ kind: "fetch", url: "https://x.dev" }, { verb: "Fetched", subject: "https://x.dev", mono: true }],
    [{ kind: "task", agent: "explore", summary: "look around" }, { verb: "explore:", subject: "look around", mono: false }],
    [{ kind: "task", summary: "look around" }, { verb: "Agent:", subject: "look around", mono: false }],
    [{ kind: "question", name: "ask_user_question", summary: "Which?", questions: [] }, { verb: "❓ Question", subject: "Which?", mono: false }],
    [{ kind: "other", name: "mcp_x", summary: "one\ntwo" }, { verb: "mcp_x:", subject: "one", mono: false }],
    [{ kind: "delete", path: "a" }, { verb: "Deleted", subject: "a", mono: true }],
    [{ kind: "move", path: "a", to: "b" }, { verb: "Moved", subject: "a", mono: true }],
  ];
  for (const [call, want] of cases) assert.deepEqual(stepLine(call), want, call.kind);
});

test("shortPath folds a home directory to ~", () => {
  assert.equal(shortPath("/home/jk/Code/a.ts"), "~/Code/a.ts");
  assert.equal(shortPath("/var/home/jk/a"), "~/a");
  assert.equal(shortPath("src/a.ts"), "src/a.ts");
});

test("shortPath: home folders on macOS and Windows become ~ too", () => {
  assert.equal(shortPath("/Users/ana/Code/a.ts"), "~/Code/a.ts");
  assert.equal(shortPath("C:\\Users\\ana\\Code\\a.ts"), "~\\Code\\a.ts");
  assert.equal(shortPath("c:/Users/ana/Code/a.ts"), "~/Code/a.ts");
  assert.equal(shortPath("/home/ana/x"), "~/x");
  // Not a home folder: unchanged.
  assert.equal(shortPath("/opt/Users/ana/a.ts"), "/opt/Users/ana/a.ts");
  assert.equal(shortPath("D:\\Projects\\a.ts"), "D:\\Projects\\a.ts");
});
