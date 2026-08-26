import assert from "node:assert/strict";
import test from "node:test";

import {
  A4_HEIGHT,
  A4_WIDTH,
  cropAtZoom,
  fullCrop,
  isFullCrop,
  moveCrop,
  normalizeCrop,
  setCropZoom,
  zoomForCrop,
} from "../app/5E/crop.ts";

test("uses the uncropped A4 sheet as the default", () => {
  assert.deepEqual(fullCrop(), {
    x: 0,
    y: 0,
    width: A4_WIDTH,
    height: A4_HEIGHT,
  });
  assert.deepEqual(normalizeCrop(null), fullCrop());
  assert.equal(isFullCrop(fullCrop()), true);
  assert.equal(zoomForCrop(fullCrop()), 1);
});

test("zooms around the current crop center without changing A4 ratio", () => {
  const crop = cropAtZoom(2);
  assert.equal(crop.width, A4_WIDTH / 2);
  assert.equal(crop.height, A4_HEIGHT / 2);
  assert.equal(crop.x, A4_WIDTH / 4);
  assert.equal(crop.y, A4_HEIGHT / 4);
  assert.equal(crop.width / crop.height, A4_WIDTH / A4_HEIGHT);

  const zoomed = setCropZoom(crop, 4);
  assert.equal(zoomForCrop(zoomed), 4);
  assert.ok(Math.abs(zoomed.x + zoomed.width / 2 - A4_WIDTH / 2) < 0.001);
  assert.ok(Math.abs(zoomed.y + zoomed.height / 2 - A4_HEIGHT / 2) < 0.001);
});

test("clamps crop panning to the original A4 bounds", () => {
  const crop = cropAtZoom(3);
  const topLeft = moveCrop(crop, -10_000, -10_000);
  assert.equal(topLeft.x, 0);
  assert.equal(topLeft.y, 0);

  const bottomRight = moveCrop(crop, 10_000, 10_000);
  assert.ok(Math.abs(bottomRight.x - (A4_WIDTH - crop.width)) < 0.001);
  assert.ok(Math.abs(bottomRight.y - (A4_HEIGHT - crop.height)) < 0.001);
});

test("normalizes persisted crops to a bounded fixed-ratio viewport", () => {
  const crop = normalizeCrop({ x: 530, y: 780, width: 100, height: 100 });
  assert.ok(crop.x >= 0 && crop.x + crop.width <= A4_WIDTH);
  assert.ok(crop.y >= 0 && crop.y + crop.height <= A4_HEIGHT);
  assert.ok(Math.abs(crop.width / crop.height - A4_WIDTH / A4_HEIGHT) < 0.00001);

  assert.deepEqual(
    normalizeCrop({ x: 0, y: 0, width: Number.NaN, height: 10 }),
    fullCrop(),
  );
});
