import assert from "node:assert/strict";
import test from "node:test";

import {
  GRID_TICK_MS,
  MAX_GRID_DWELL_MS,
  MIN_GRID_DWELL_MS,
  buildGridTimeline,
} from "../app/5A/grid.ts";

test("gives every grid cell an independent 300–600ms dwell", () => {
  const timeline = buildGridTimeline(["a", "b", "c", "d", "e"], 50, 12345);
  const minimumTicks = MIN_GRID_DWELL_MS / GRID_TICK_MS;
  const maximumTicks = MAX_GRID_DWELL_MS / GRID_TICK_MS;
  const firstChangeTicks = [];

  assert.ok(timeline.length > maximumTicks);
  assert.ok(timeline.every((frame) => frame.length === 50));

  for (let cell = 0; cell < 50; cell += 1) {
    let previousLayer = timeline[0][cell];
    let previousChangeTick = 0;

    for (let tick = 1; tick < timeline.length; tick += 1) {
      const nextLayer = timeline[tick][cell];
      if (nextLayer === previousLayer) continue;

      const dwellTicks = tick - previousChangeTick;
      assert.ok(dwellTicks >= minimumTicks && dwellTicks <= maximumTicks);
      if (previousChangeTick === 0) firstChangeTicks.push(tick);
      previousLayer = nextLayer;
      previousChangeTick = tick;
    }
  }

  assert.ok(new Set(firstChangeTicks).size > 1);
});

test("uses the seed to produce a fresh grid pattern", () => {
  const layers = ["a", "b", "c", "d"];
  assert.deepEqual(
    buildGridTimeline(layers, 3, 99),
    buildGridTimeline(layers, 3, 99),
  );
  assert.notDeepEqual(
    buildGridTimeline(layers, 3, 99),
    buildGridTimeline(layers, 3, 100),
  );
});
