// Colour on folded titles; intercom messages.

import { test } from "node:test";
import assert from "node:assert/strict";

import { itemsFromEntries, type ChatItem, type SessionEntryLike } from "../src/model/items.ts";
import { COLOR_TITLES, noticeKey, renderChatRows } from "../src/view/render.ts";
import { deps, strip } from "./fake-deps.ts";

const custom = (customType: string, content: string, details?: unknown): SessionEntryLike =>
  ({ type: "custom_message", id: "n1", customType, content, display: true, details }) as SessionEntryLike;
const notice = (e: SessionEntryLike) => itemsFromEntries([e])[0] as Extract<ChatItem, { kind: "notice" }>;
const rows = (e: SessionEntryLike, width = 80, open = false) =>
  renderChatRows(itemsFromEntries([e]), width, deps, { expanded: (k) => open && k === noticeKey("n1") });

test("COLOR_TITLES is on", () => assert.equal(COLOR_TITLES, true));

test("labelled notices carry their label; text stays the visible text", () => {
  const n = notice(custom("gentle-agents.result", "Done.", { gentleAgents: { agent: "explore" } }));
  assert.equal(n.text, "❀  Agent result · explore · Done.");
  assert.equal(n.label, "❀  Agent result");
  assert.equal(notice(custom("gentle-agents.message", "hi", { gentleAgents: { agent: "review" } })).label, "❀  review message");
  assert.equal(notice(custom("gentle-agents.orchestrator-message", "hi")).label, "❀  Session message");
  assert.equal(notice(custom("gentle-pi.review-preflight", "on")).label, "✿ Gentle AI · review preflight");
  assert.equal(notice(custom("gentle-jobs.notice", 'Background job job-1 ("t") exited with code 0 after 3s.')).label, "⧗ Background job");
  assert.equal(notice(custom("gentle-jobs.notice", 'Monitor job-2 ("w") reported 1 new line:\nx')).label, "⧗ Monitor");
  assert.equal(notice(custom("x", "plain")).label, undefined);
});

test("a short labelled notice: centred, label in accent, the rest dim", () => {
  const r = rows(custom("gentle-agents.result", "Done.", { gentleAgents: { agent: "explore" } }));
  assert.equal(strip(r.lines[0]!).trim(), "❀  Agent result · explore · Done.");
  assert.match(r.lines[0]!, /<accent>❀ {2}Agent result<\/accent><dim> · explore · Done\.<\/dim>/);
});

test("folded and opened rows colour the label; errors stay all red", () => {
  const long = custom("gentle-agents.result", "word ".repeat(40), { gentleAgents: { agent: "explore" } });
  const folded = rows(long, 50).lines[0]!;
  assert.match(folded, /^<dim>› <\/dim><accent>❀ {2}Agent result<\/accent><dim> · explore · word/);
  assert.match(rows(long, 50, true).lines[0]!, /^<dim>⌄ <\/dim><accent>❀ {2}Agent result<\/accent>/);
  const ok = rows(custom("gentle-jobs.notice", 'Background job job-1 ("t") exited with code 0 after 3s.', { gentleJobs: { label: "t", exitCode: 0, status: "exited" } })).lines[0]!;
  assert.match(ok, /^<dim>› <\/dim><accent>⧗ Background job<\/accent><dim> · t · exited 0 after 3s<\/dim>$/);
  const bad = rows(custom("gentle-jobs.notice", 'Background job job-1 ("t") exited with code 1 after 3s.', { gentleJobs: { label: "t", exitCode: 1, status: "exited" } })).lines[0]!;
  assert.equal(bad, "<error>› ⧗ Background job · t · exited 1 after 3s</error>");
  const stale = renderChatRows(itemsFromEntries([{ type: "custom", id: "st", customType: "gentle-agents.stale-result", data: { agent: "a", taskId: "t" } } as SessionEntryLike]), 80, deps).lines[0]!;
  assert.match(stale, /<accent>❀ {2}Stale agent result<\/accent><dim> · a · task t<\/dim>/);
  for (const width of [5, 12, 30]) for (const l of rows(long, width).lines) assert.ok(deps.visibleWidth(l) <= width, JSON.stringify(strip(l)));
});

const INTERCOM = '**From planner** (/home/me/proj)\n\nTo reply, use the intercom tool: intercom({...})\n\n_delivered 10:02 · steer_\n\nPlease check the tests.\nThen push.';

test("intercom: '✉ From <sender>' and the body only", () => {
  const withDetails = notice(custom("intercom_message", INTERCOM, { from: { id: "abcdef123456", name: "planner", cwd: "/x" }, bodyText: "Please check the tests.\nThen push." }));
  assert.equal(withDetails.label, "✉ From planner");
  assert.equal(withDetails.text, "✉ From planner · Please check the tests.\nThen push.");
  assert.equal(notice(custom("intercom_message", INTERCOM, { from: { id: "abcdef123456", name: "" }, bodyText: "hi" })).text, "✉ From abcdef12 · hi");
  const parsed = notice(custom("intercom_message", '**From worker** (/p)\n\n_meta_\n\nBody here.'));
  assert.equal(parsed.text, "✉ From worker · Body here.");
  const short = rows(custom("intercom_message", "x", { from: { name: "p" }, bodyText: "ok" })).lines[0]!;
  assert.equal(strip(short).trim(), "✉ From p · ok");
  assert.match(short, /<accent>✉ From p<\/accent>/);
  assert.ok(!rows(custom("intercom_message", INTERCOM, { from: { name: "planner" }, bodyText: "Please check the tests.\nThen push." }), 80, true).lines.map(strip).join("\n").includes("delivered"));
});
