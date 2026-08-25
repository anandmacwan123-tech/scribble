import assert from "node:assert/strict";
import test from "node:test";

import { containImageRect } from "../app/5A/fit.ts";

test("keeps an A4 portrait image at its native aspect ratio", () => {
  assert.deepEqual(containImageRect(595, 842, 595, 842), {
    x: 0,
    y: 0,
    width: 595,
    height: 842,
  });
});

test("contains non-A4 uploads without stretching or cropping", () => {
  const landscape = containImageRect(1200, 800, 595, 842);
  assert.equal(landscape.width / landscape.height, 1200 / 800);
  assert.equal(landscape.width, 595);
  assert.ok(landscape.y > 0);

  const portrait = containImageRect(800, 1200, 595, 842);
  assert.ok(
    Math.abs(portrait.width / portrait.height - 800 / 1200) < Number.EPSILON,
  );
  assert.equal(portrait.height, 842);
  assert.ok(portrait.x > 0);
});
