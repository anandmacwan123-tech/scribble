import assert from "node:assert/strict";
import test from "node:test";

import { buildGridTimeline } from "../app/5A/grid.ts";
import {
  buildMaskRects,
  MASK_REGION_COUNT,
  SLICE_COUNT,
} from "../app/5A/masks.ts";

test("gives every grid cell an independent 300–600ms dwell", () => {
  const minimumDwellMs = 300;
  const maximumDwellMs = 600;
  const timeline = buildGridTimeline(
    ["a", "b", "c", "d", "e"],
    50,
    12345,
    minimumDwellMs,
    maximumDwellMs,
  );
  const firstChangeTimes = [];

  assert.ok(timeline.length > 1);
  assert.ok(
    timeline.every(
      (frame) => frame.durationMs > 0 && frame.layerIndexes.length === 50,
    ),
  );

  for (let cell = 0; cell < 50; cell += 1) {
    let previousLayer = timeline[0].layerIndexes[cell];
    let previousChangeAt = 0;
    let elapsedMs = 0;

    for (let frame = 1; frame < timeline.length; frame += 1) {
      elapsedMs += timeline[frame - 1].durationMs;
      const nextLayer = timeline[frame].layerIndexes[cell];
      if (nextLayer === previousLayer) continue;

      const dwellMs = elapsedMs - previousChangeAt;
      assert.ok(dwellMs >= minimumDwellMs && dwellMs <= maximumDwellMs);
      if (previousChangeAt === 0) firstChangeTimes.push(elapsedMs);
      previousLayer = nextLayer;
      previousChangeAt = elapsedMs;
    }
  }

  assert.ok(new Set(firstChangeTimes).size > 1);
});

test("uses the seed to produce a fresh grid pattern", () => {
  const layers = ["a", "b", "c", "d"];
  assert.deepEqual(
    buildGridTimeline(layers, 3, 99, 450, 900),
    buildGridTimeline(layers, 3, 99, 450, 900),
  );
  assert.notDeepEqual(
    buildGridTimeline(layers, 3, 99, 450, 900),
    buildGridTimeline(layers, 3, 100, 450, 900),
  );
});

test("builds 50 full-width horizontal slice masks", () => {
  const width = 595;
  const height = 842;
  const slices = buildMaskRects("slice", width, height);

  assert.equal(SLICE_COUNT, 50);
  assert.equal(slices.length, SLICE_COUNT);
  assert.ok(
    slices.every(
      (slice) =>
        slice.x === 0 &&
        slice.width === width &&
        slice.height === height / SLICE_COUNT,
    ),
  );
  assert.equal(slices[0].y, 0);
  assert.equal(
    slices.at(-1).y + slices.at(-1).height,
    height,
  );
});

test("can switch Slice to 50 full-height vertical masks", () => {
  const width = 595;
  const height = 842;
  const slices = buildMaskRects("slice", width, height, "vertical");

  assert.equal(slices.length, SLICE_COUNT);
  assert.ok(
    slices.every(
      (slice) =>
        slice.y === 0 &&
        slice.height === height &&
        slice.width === width / SLICE_COUNT,
    ),
  );
  assert.equal(slices[0].x, 0);
  assert.equal(slices.at(-1).x + slices.at(-1).width, width);
});

test("keeps the grid and slice modes at 50 independently animated regions", () => {
  assert.equal(MASK_REGION_COUNT, 50);
  assert.equal(buildMaskRects("grid", 595, 842).length, 50);
  assert.equal(buildMaskRects("slice", 595, 842).length, 50);
});
