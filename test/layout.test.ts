import { test } from "node:test";
import assert from "node:assert/strict";

import { chatHeight, measureBottom } from "../src/view/layout.ts";

const rows = (n: number) => ({ render: (_w: number) => Array.from({ length: n }, () => "x") });

test("chatHeight fullscreen: everything above the bottom region", () => {
  assert.equal(chatHeight({ mode: "fullscreen", termRows: 40, docRows: 5, bottomRows: 10 }), 30);
  assert.equal(chatHeight({ mode: "fullscreen", termRows: 40, docRows: 500, bottomRows: 10 }), 30);
});

test("chatHeight regular: a long transcript leaves termRows - bottomRows", () => {
  assert.equal(chatHeight({ mode: "regular", termRows: 40, docRows: 200, bottomRows: 12 }), 28);
});

test("chatHeight regular: a short transcript covers only the transcript rows", () => {
  // doc + bottom fit on screen: the bottom region starts right under the transcript.
  assert.equal(chatHeight({ mode: "regular", termRows: 40, docRows: 8, bottomRows: 12 }), 8);
  assert.equal(chatHeight({ mode: "regular", termRows: 40, docRows: 28, bottomRows: 12 }), 28);
});

test("chatHeight: fewer than 3 rows is 0 (overlay hidden)", () => {
  assert.equal(chatHeight({ mode: "fullscreen", termRows: 14, docRows: 0, bottomRows: 12 }), 0);
  assert.equal(chatHeight({ mode: "fullscreen", termRows: 15, docRows: 0, bottomRows: 12 }), 3);
  assert.equal(chatHeight({ mode: "regular", termRows: 40, docRows: 2, bottomRows: 12 }), 0);
  assert.equal(chatHeight({ mode: "fullscreen", termRows: 10, docRows: 0, bottomRows: 30 }), 0);
});

test("measureBottom sums every child after the transcript", () => {
  assert.equal(measureBottom([rows(100), rows(1), rows(0), rows(2), rows(4), rows(0), rows(3)], 80), 10);
  assert.equal(measureBottom([rows(100), rows(5)], 80), 5);
});

test("measureBottom passes the width to each child", () => {
  const seen: number[] = [];
  const spy = { render: (w: number) => (seen.push(w), ["a"]) };
  measureBottom([rows(1), spy, spy], 73);
  assert.deepEqual(seen, [73, 73]);
});

test("measureBottom fails closed on an unexpected layout", () => {
  assert.equal(measureBottom([rows(3)], 80), undefined);
  assert.equal(measureBottom([], 80), undefined);
  assert.equal(measureBottom(undefined, 80), undefined);
});
