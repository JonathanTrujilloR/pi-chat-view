import { test } from "node:test";
import assert from "node:assert/strict";

import { GENTLE_SIDEBAR_STATE, gentleInsets } from "../src/view/gentle-insets.ts";

const header = (lines: string[]) => ({ render: () => lines });

function terminalWith(state: unknown): object {
  return { [GENTLE_SIDEBAR_STATE]: state };
}

const painting = {
  active: true,
  ownsHost: () => true,
  railColumns: 53,
  parts: new Map([["header", header(["✿ Gentle Shell · gpt", "───"])]]),
};

test("a painting header and rail reserve the top rows and the rail columns", () => {
  assert.deepEqual(gentleInsets(terminalWith(painting), 200, "fullscreen"), { top: 2, right: 53 });
});

test("without Gentle's state the chat keeps the whole area", () => {
  assert.deepEqual(gentleInsets({}, 200, "fullscreen"), { top: 0, right: 0 });
  assert.deepEqual(gentleInsets(undefined, 200, "fullscreen"), { top: 0, right: 0 });
});

test("regular mode has no fixed header or rail", () => {
  assert.deepEqual(gentleInsets(terminalWith(painting), 200, "regular"), { top: 0, right: 0 });
});

test("a rail that is not painting reserves no columns", () => {
  for (const state of [
    { ...painting, active: false },
    { ...painting, ownsHost: () => false },
    { ...painting, ownsHost: undefined },
    { ...painting, ownsHost: () => { throw new Error("boom"); } },
  ]) {
    assert.equal(gentleInsets(terminalWith(state), 200, "fullscreen").right, 0);
  }
});

test("a malformed rail width reserves no columns", () => {
  for (const railColumns of [undefined, "53", 0, -3, 2.5, 200, 400]) {
    assert.equal(gentleInsets(terminalWith({ ...painting, railColumns }), 200, "fullscreen").right, 0);
  }
});

test("a blank, missing or throwing header reserves no rows", () => {
  for (const parts of [
    new Map([["header", header(["   ", ""])]]),
    new Map(),
    undefined,
    new Map([["header", { render: () => { throw new Error("boom"); } }]]),
  ]) {
    assert.equal(gentleInsets(terminalWith({ ...painting, parts }), 200, "fullscreen").top, 0);
  }
});

test("the header is measured at the width Gentle paints it with", () => {
  let width = -1;
  const parts = new Map([["header", { render: (w: number) => ((width = w), ["x"]) }]]);
  gentleInsets(terminalWith({ ...painting, parts }), 200, "fullscreen");
  assert.equal(width, 198);
});
