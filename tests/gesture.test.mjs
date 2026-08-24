import assert from "node:assert/strict";
import test from "node:test";
import { hasReachedPrompt } from "../app/gesture.ts";

function stagesReached(samples) {
  let active = [samples[0]];
  let stage = 0;

  for (const point of samples.slice(1)) {
    active = [...active, point];
    if (hasReachedPrompt(active, stage)) {
      stage += 1;
      active = [point];
    }
  }

  return stage;
}

test("one uninterrupted five reaches every prompt without pointer-up", () => {
  const samples = [
    { x: 700, y: 100 },
    { x: 620, y: 100 },
    { x: 620, y: 165 },
    { x: 700, y: 165 },
    { x: 700, y: 230 },
    { x: 620, y: 230 },
  ];

  assert.equal(stagesReached(samples), 5);
});

test("a long straight line cannot complete direction-specific prompts", () => {
  const samples = [
    { x: 760, y: 100 },
    { x: 680, y: 100 },
    { x: 600, y: 100 },
    { x: 520, y: 100 },
    { x: 440, y: 100 },
    { x: 360, y: 100 },
  ];

  assert.equal(stagesReached(samples), 1);
});

test("each prompt rejects motion in the opposite direction", () => {
  assert.equal(hasReachedPrompt([{ x: 100, y: 100 }, { x: 180, y: 100 }], 0), false);
  assert.equal(hasReachedPrompt([{ x: 100, y: 180 }, { x: 100, y: 100 }], 1), false);
  assert.equal(hasReachedPrompt([{ x: 180, y: 100 }, { x: 100, y: 100 }], 2), false);
  assert.equal(hasReachedPrompt([{ x: 100, y: 180 }, { x: 100, y: 100 }], 3), false);
  assert.equal(hasReachedPrompt([{ x: 100, y: 100 }, { x: 180, y: 100 }], 4), false);
});
