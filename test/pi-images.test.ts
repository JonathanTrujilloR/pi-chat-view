import { test } from "node:test";
import assert from "node:assert/strict";

import { hideImages } from "../src/view/pi-images.ts";

/** A fake of Pi's ToolExecutionComponent: `showImages` plus `setShowImages`, counting calls. */
function card(show = true) {
  const c = { showImages: show, calls: [] as boolean[], setShowImages(v: boolean) { c.calls.push(v); c.showImages = v; } };
  return c;
}
const box = (...children: unknown[]) => ({ children });

test("hide walks nested children and switches only image cards still showing images", () => {
  const a = card(), b = card(), off = card(false);
  const text = { render: () => [] };
  const odd = { showImages: true }; // no method: left alone
  const root = box(text, box(a, box(b, off)), odd);
  const h = hideImages(root);
  assert.deepEqual([a.calls, b.calls, off.calls], [[false], [false], []]);
  assert.equal(odd.showImages, true);
  assert.equal(h.count, 2);
});

test("restore switches back only the cards it switched, once", () => {
  const a = card(), b = card(), off = card(false);
  const h = hideImages(box(a, b, off));
  b.setShowImages(true); // someone else turned it back on meanwhile
  h.restore();
  h.restore();
  assert.deepEqual(a.calls, [false, true]);
  assert.deepEqual(b.calls, [false, true], "already on: not touched again");
  assert.deepEqual(off.calls, []);
});

test("sweep catches cards added while Chat is open; after restore it does nothing", () => {
  const a = card();
  const root = box(a);
  const h = hideImages(root);
  const late = card();
  root.children.push(box(late));
  assert.equal(h.sweep(), 1);
  assert.deepEqual(late.calls, [false]);
  assert.equal(h.sweep(), 0);
  h.restore();
  assert.deepEqual(late.calls, [false, true]);
  const after = card();
  root.children.push(after);
  assert.equal(h.sweep(), 0);
  assert.deepEqual(after.calls, []);
});

test("a throwing setShowImages is skipped; the walk goes on", () => {
  const bad = { showImages: true, setShowImages() { throw new Error("boom"); } };
  const good = card();
  const h = hideImages(box(bad, good));
  assert.deepEqual(good.calls, [false]);
  assert.equal(h.count, 1);
  assert.doesNotThrow(() => h.restore());
});

test("cycles, getters that throw and odd roots are survived", () => {
  const a = card();
  const loop: { children: unknown[] } = { children: [] };
  loop.children.push(loop, a, null, 3, "x");
  const trap = Object.defineProperty({}, "children", { get() { throw new Error("no"); } });
  const h = hideImages(box(loop, trap));
  assert.deepEqual(a.calls, [false]);
  for (const root of [undefined, null, 1, "x", []]) assert.equal(hideImages(root).count, 0);
});

test("the walk is bounded in depth", () => {
  let deep: { children: unknown[] } = { children: [] };
  const bottom = card();
  deep.children.push(bottom);
  for (let i = 0; i < 100; i++) deep = { children: [deep] };
  hideImages(deep);
  assert.deepEqual(bottom.calls, [], "beyond the depth cap");
  const shallow = card();
  hideImages(box(box(box(shallow))));
  assert.deepEqual(shallow.calls, [false]);
});
