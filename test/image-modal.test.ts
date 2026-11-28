// S24: a click on an image drawn in the chat opens it large in a modal over the chat.

import { test } from "node:test";
import assert from "node:assert/strict";

import type { ChatItem } from "../src/model/items.ts";
import { ChatView, MARGIN } from "../src/view/chat-view.ts";
import { ImageModal, MODAL_HINT, type ImageModalDeps } from "../src/view/image-modal.ts";
import { renderChatRows, type ChatRows, type RenderDeps } from "../src/view/render.ts";
import { deps, strip } from "./fake-deps.ts";
import { harness } from "./controller-harness.ts";

const ESC = "\x1b";
const seq = (data: string) => `${ESC}_Ga=T,i=${data};${ESC}\\`;
const hasImage = (l: string) => l.includes(`${ESC}_G`);
const png = (data: string) => ({ data, mimeType: "image/png" });

// --- The renderer carries the image on its span ---

test("a drawn image's span carries its data; a marker has no span", () => {
  const d: RenderDeps = { ...deps, image: (data) => (data === "B" ? undefined : [seq(data), "", ""]) };
  const user = { id: "u", kind: "user", text: "look", images: 2, imageData: [png("A"), png("B")] } as ChatItem;
  const r = renderChatRows([user], 40, d);
  assert.deepEqual([...r.images!.entries()].map(([k, s]) => [k, s.image]), [[2, png("A")]]);
  const card = { id: "r1", kind: "tool", status: "done", tool: { kind: "read", path: "s.png", images: 1, imageData: [png("C")] } } as ChatItem;
  const c = renderChatRows([card], 40, d, { expanded: () => true });
  assert.deepEqual([...c.images!.values()].map((s) => s.image), [png("C")]);
});

// --- Clicks in the chat ---

/** Ten numbered lines, an image on lines 4-6 with fallback FB / f1 / f2. */
const spanned = (image: { data: string; mimeType: string } | null = png("IMG")): ChatRows => {
  const lines = Array.from({ length: 10 }, (_, i) => `L${i}`);
  lines[4] = seq("IMG");
  lines[5] = "";
  lines[6] = "";
  return { lines, targets: [], images: new Map([[4, { rows: 3, fallback: ["FB", "f1", "f2"], image: image ?? undefined }]]) };
};
const viewOf = (rows: ChatRows, height = 6) => {
  const v = new ChatView({ ...deps, renderLines: () => rows });
  v.targetHeight = height;
  v.render(30);
  return v;
};
const mouse = (type: string, y: number, x = MARGIN + 1, button = "left") => ({ type, button, x, y });
const shown = (v: ChatView) => v.render(30).slice(1).map((l) => (hasImage(l) ? "IMG" : strip(l).trim()));

test("a left press on any row of a drawn image opens it; its release and click are swallowed", () => {
  const v = viewOf(spanned());
  const opened: unknown[] = [];
  v.onImage = (image) => void opened.push(image);
  v.scrollBy(-2); // window L3..L7: the image on screen rows 2-4
  assert.deepEqual(shown(v), ["L3", "IMG", "", "", "L7"]);
  for (const y of [2, 3, 4]) {
    assert.deepEqual(v.handleMouse(mouse("press", y)), { handled: true });
    assert.deepEqual(v.handleMouse(mouse("release", y)), { handled: true });
    assert.deepEqual(v.handleMouse(mouse("click", y)), { handled: true });
    assert.equal(v.hasSelection(), false, "no selection started");
  }
  assert.deepEqual(opened, [png("IMG"), png("IMG"), png("IMG")]);
});

test("not on other rows, nor in the margins, nor a marker, nor with the right button", () => {
  const v = viewOf(spanned());
  const opened: unknown[] = [];
  v.onImage = (image) => void opened.push(image);
  v.scrollBy(-2);
  v.render(30);
  // A text row starts a selection as before.
  assert.deepEqual(v.handleMouse(mouse("press", 1)), { handled: true, capture: true });
  v.handleMouse(mouse("release", 1));
  // Margins.
  assert.deepEqual(v.handleMouse(mouse("press", 3, 0)), { handled: true });
  v.handleMouse(mouse("release", 3, 0));
  assert.deepEqual(v.handleMouse(mouse("press", 3, 30 - 1)), { handled: true });
  v.handleMouse(mouse("release", 3, 30 - 1));
  // Right button.
  assert.equal(v.handleMouse(mouse("press", 3, MARGIN + 1, "right")), undefined);
  // Cut at the bottom: the marker shows, and it is no image.
  v.scrollBy(-2); // window L1..L5
  assert.deepEqual(shown(v), ["L1", "L2", "L3", "FB", "f1"]);
  assert.deepEqual(v.handleMouse(mouse("press", 4)), { handled: true, capture: true });
  v.handleMouse(mouse("release", 4));
  assert.deepEqual(opened, []);
  // A span without image data (or no onImage) is not clickable either.
  const w = viewOf(spanned(null));
  w.onImage = (image) => void opened.push(image);
  w.scrollBy(-2);
  w.render(30);
  assert.deepEqual(w.handleMouse(mouse("press", 3)), { handled: true, capture: true });
  const x = viewOf(spanned());
  x.scrollBy(-2);
  x.render(30);
  assert.deepEqual(x.handleMouse(mouse("press", 3)), { handled: true, capture: true });
  assert.deepEqual(opened, []);
});

test("while a modal is open the chat's images stand down, and a press on the chat closes the modal", () => {
  const v = viewOf(spanned());
  const opened: unknown[] = [];
  let closes = 0;
  v.onImage = (image) => void opened.push(image);
  v.scrollBy(-2);
  assert.deepEqual(shown(v), ["L3", "IMG", "", "", "L7"]);
  v.modalClose = () => void closes++;
  assert.deepEqual(shown(v), ["L3", "FB", "f1", "f2", "L7"]);
  assert.ok(!v.render(30).some(hasImage));
  for (const l of v.render(30)) assert.equal(deps.visibleWidth(l), 30);
  // A press anywhere closes it; that gesture's release and click do nothing more.
  assert.deepEqual(v.handleMouse(mouse("press", 3)), { handled: true });
  assert.equal(closes, 1);
  v.modalClose = undefined; // the controller clears it on close
  assert.deepEqual(v.handleMouse(mouse("release", 3)), { handled: true });
  assert.deepEqual(v.handleMouse(mouse("click", 3)), { handled: true });
  assert.deepEqual(opened, []);
  assert.equal(v.hasSelection(), false);
  // Closed: drawn again, exactly as before.
  assert.deepEqual(shown(v), ["L3", "IMG", "", "", "L7"]);
});

test("the release and click of the press that opened the modal never close it", () => {
  const v = viewOf(spanned());
  let closes = 0;
  v.onImage = () => {
    v.modalClose = () => void closes++;
  };
  v.scrollBy(-2);
  v.render(30);
  v.handleMouse(mouse("press", 2));
  assert.deepEqual(v.handleMouse(mouse("release", 2)), { handled: true });
  assert.deepEqual(v.handleMouse(mouse("click", 2)), { handled: true });
  assert.equal(closes, 0);
});

test("swallowClick: after the modal closes on its own press, that release and click are not the chat's", () => {
  const v = viewOf(spanned());
  v.scrollBy(-2);
  v.render(30);
  v.swallowClick();
  assert.deepEqual(v.handleMouse(mouse("release", 1)), { handled: true });
  assert.deepEqual(v.handleMouse(mouse("click", 1)), { handled: true });
  assert.equal(v.hasSelection(), false);
  // The next gesture is the chat's again.
  assert.deepEqual(v.handleMouse(mouse("press", 1)), { handled: true, capture: true });
});

// --- The modal component ---

function modalDeps(result: "ok" | "none" | "wide" = "ok") {
  const calls: [string, string, number, number][] = [];
  const d: ImageModalDeps = {
    ...deps,
    image: (data, mime, maxW, maxH) => {
      calls.push([data, mime, maxW, maxH]);
      if (result === "none") return undefined;
      if (result === "wide") return { rows: ["x".repeat(maxW + 1)] };
      const rows = Math.min(maxH, 6);
      return { rows: [seq(data), ...Array.from({ length: rows - 1 }, () => "")], columns: Math.min(maxW, 20), size: { widthPx: 800, heightPx: 600 } };
    },
  };
  return { d, calls };
}

const modalOf = (d: ImageModalDeps, height: number, onClose: (mouse: boolean) => void = () => {}) =>
  new ImageModal(png("A"), d, { matchesKey: (data, key) => data === key, height: () => height, close: onClose });

test("modal: title, the image as large as fits, and the hint; every line exactly the width", () => {
  const { d, calls } = modalDeps();
  const m = modalOf(d, 12);
  const lines = m.render(40);
  assert.deepEqual(calls, [["A", "image/png", 40, 10]], "the whole width, the height minus title and hint");
  assert.equal(lines.length, 8);
  assert.match(strip(lines[0]!), /image\/png · 800×600/);
  assert.ok(hasImage(lines[1]!));
  // Centred: (40 - 20) / 2 columns before the image.
  assert.ok(lines[1]!.startsWith(" ".repeat(10) + ESC), JSON.stringify(lines[1]));
  assert.equal(strip(lines[7]!).trim(), MODAL_HINT);
  assert.ok(lines[7]!.includes(`<dim>${MODAL_HINT}</dim>`));
  for (const l of lines) assert.equal(deps.visibleWidth(l), 40);
  // A short terminal: the image gets what is left and the modal never exceeds the height.
  const small = modalDeps();
  const s = modalOf(small.d, 5).render(30);
  assert.deepEqual(small.calls[0], ["A", "image/png", 30, 3]);
  assert.ok(s.length <= 5);
  for (const l of s) assert.equal(deps.visibleWidth(l), 30);
  assert.equal(MODAL_HINT, "esc · click · alt+c to close");
});

test("modal: a narrow width truncates title and hint; an image that cannot be drawn says so", () => {
  const { d } = modalDeps();
  for (const l of modalOf(d, 12).render(10)) assert.ok(deps.visibleWidth(l) <= 10);
  for (const how of ["none", "wide"] as const) {
    const lines = modalOf(modalDeps(how).d, 12).render(40);
    assert.equal(lines.length, 3, how);
    assert.ok(!lines.some(hasImage));
    for (const l of lines) assert.equal(deps.visibleWidth(l), 40);
  }
});

test("modal: Esc, alt+c and q close it; any press or click of its own closes it; other keys do not", () => {
  const { d } = modalDeps();
  const closed: boolean[] = [];
  const m = modalOf(d, 12, (viaMouse) => void closed.push(viaMouse));
  m.handleInput("a");
  m.handleInput("enter");
  assert.deepEqual(closed, []);
  for (const key of ["escape", "alt+c", "q"]) m.handleInput(key);
  assert.deepEqual(closed, [false, false, false]);
  // The opening gesture's release and click land here first: ignored.
  assert.equal(m.handleMouse({ type: "release", button: "left", x: 1, y: 1 }), undefined);
  assert.equal(m.handleMouse({ type: "click", button: "left", x: 1, y: 1 }), undefined);
  assert.deepEqual(m.handleMouse({ type: "press", button: "right", x: 1, y: 1 }), { handled: true });
  assert.deepEqual(closed, [false, false, false, true]);
});

// --- The controller ---

function openChatWithImage() {
  const { d } = modalDeps();
  const h = harness({ imageModal: () => d });
  h.ctx.sessionManager.getBranch = () => [
    { type: "message", id: "u1", message: { role: "user", content: [{ type: "text", text: "look" }, { type: "image", data: "A", mimeType: "image/png" }] } },
  ];
  h.chat.toggle(h.ctx);
  return h;
}

test("controller: onImage opens one focused, centred modal sized to the terminal minus a margin", () => {
  const h = openChatWithImage();
  const v = h.view!;
  assert.equal(typeof v.onImage, "function");
  const before = h.renders;
  v.onImage!(png("A"));
  assert.equal(h.modals.length, 1);
  const o = h.modals[0]!.options.overlayOptions();
  assert.equal(o.nonCapturing, undefined, "focused: it takes the keyboard");
  assert.equal(o.anchor, "center");
  assert.deepEqual([o.width, o.maxHeight], [76, 36]);
  assert.equal(h.modals[0]!.unfocused, 0);
  assert.equal((o.visible as () => boolean)(), true);
  assert.ok(h.modals[0]!.component instanceof ImageModal);
  assert.equal(typeof v.modalClose, "function", "the chat's images stand down");
  assert.ok(h.renders > before);
  // Only one at a time.
  v.onImage!(png("A"));
  assert.equal(h.modals.length, 1);
  // Resize: the modal follows.
  h.tui.terminal.columns = 60;
  h.tui.terminal.rows = 20;
  assert.deepEqual([o.width, o.maxHeight], [56, 16]);
});

for (const [how, act] of [
  ["Esc", (m: ImageModal) => m.handleInput("escape")],
  ["alt+c", (m: ImageModal) => m.handleInput("alt+c")],
  ["q", (m: ImageModal) => m.handleInput("q")],
  ["a click", (m: ImageModal) => m.handleMouse({ type: "press", button: "left", x: 3, y: 3 })],
] as const) {
  test(`controller: ${how} closes the modal, clears the flag and redraws; the chat stays open`, () => {
    const h = openChatWithImage();
    h.view!.onImage!(png("A"));
    const call = h.modals[0]!;
    const o = call.options.overlayOptions();
    const before = h.renders;
    act(call.component as ImageModal);
    assert.equal(call.done, 1);
    assert.equal(h.view!.modalClose, undefined);
    assert.equal((o.visible as () => boolean)(), false);
    assert.ok(h.renders > before);
    assert.equal(h.chat.isOpen(), true);
    // Closed twice is still closed once; a new click opens a new one.
    act(call.component as ImageModal);
    assert.equal(call.done, 1);
    h.view!.onImage!(png("A"));
    assert.equal(h.modals.length, 2);
  });
}

test("controller: while the modal is open Esc, alt+c and q reaching the chat's key listener close only the modal", () => {
  const h = openChatWithImage();
  const onKey = h.handlers[0]!;
  for (const key of ["escape", "alt+c", "q"]) {
    h.view!.onImage!(png("A"));
    const call = h.modals.at(-1)!;
    assert.deepEqual(onKey(key), { consume: true });
    assert.equal(call.done, 1, key);
    assert.equal(h.chat.isOpen(), true);
  }
  assert.equal(onKey("q"), undefined, "no modal: q is Pi's");
});

test("controller: closing the chat (alt+c, session_shutdown) closes the modal too", () => {
  for (const close of [(h: ReturnType<typeof openChatWithImage>) => h.chat.toggle(h.ctx), (h: ReturnType<typeof openChatWithImage>) => h.chat.close()]) {
    const h = openChatWithImage();
    h.view!.onImage!(png("A"));
    close(h);
    assert.equal(h.modals[0]!.done, 1);
    assert.equal(h.chat.isOpen(), false);
    assert.equal(h.view!.modalClose, undefined);
  }
});

test("controller: without the modal dep, images are not clickable", () => {
  const h = harness();
  h.chat.toggle(h.ctx);
  assert.equal(h.view!.onImage, undefined);
});
