import assert from "node:assert/strict";
import test from "node:test";
import {
  CANVAS_HEIGHT,
  CANVAS_WIDTH,
  FIVE_STAGE_COUNT,
  clientPointToCanvas,
  getFiveProgress,
  hasDetectedFive,
  hasReachedPrompt,
} from "../app/gesture.ts";
import { redoStroke, undoStroke } from "../app/history.ts";

const canvasBounds = {
  left: 100,
  top: 50,
  width: CANVAS_WIDTH,
  height: CANVAS_HEIGHT,
};

const canonicalFive = [
  { x: 500, y: 100 },
  { x: 430, y: 100 },
  { x: 430, y: 190 },
  { x: 500, y: 190 },
  { x: 500, y: 280 },
  { x: 430, y: 280 },
];

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

function assertPointClose(actual, expected) {
  assert.ok(actual);
  assert.ok(Math.abs(actual.x - expected.x) < 1e-9);
  assert.ok(Math.abs(actual.y - expected.y) < 1e-9);
}

test("maps equivalent 1x and centre-origin 2x client points identically", () => {
  const canvasPoint = { x: 420, y: 560 };
  const centerX = canvasBounds.left + canvasBounds.width / 2;
  const centerY = canvasBounds.top + canvasBounds.height / 2;
  const atOne = clientPointToCanvas(
    canvasBounds.left + canvasPoint.x,
    canvasBounds.top + canvasPoint.y,
    canvasBounds,
    1,
  );
  const atTwo = clientPointToCanvas(
    centerX + (canvasPoint.x - CANVAS_WIDTH / 2) * 2,
    centerY + (canvasPoint.y - CANVAS_HEIGHT / 2) * 2,
    canvasBounds,
    2,
  );

  assertPointClose(atOne, canvasPoint);
  assertPointClose(atTwo, canvasPoint);
});

test("maps zoomed corners and clamps points outside the canvas", () => {
  const centerX = canvasBounds.left + canvasBounds.width / 2;
  const centerY = canvasBounds.top + canvasBounds.height / 2;

  assert.deepEqual(
    clientPointToCanvas(
      centerX - canvasBounds.width,
      centerY - canvasBounds.height,
      canvasBounds,
      2,
    ),
    { x: 0, y: 0 },
  );
  assert.deepEqual(
    clientPointToCanvas(
      centerX + canvasBounds.width,
      centerY + canvasBounds.height,
      canvasBounds,
      2,
    ),
    { x: CANVAS_WIDTH, y: CANVAS_HEIGHT },
  );
  assert.deepEqual(
    clientPointToCanvas(-10_000, 10_000, canvasBounds, 1),
    { x: 0, y: CANVAS_HEIGHT },
  );
});

test("rejects invalid canvas bounds, zoom and client coordinates", () => {
  assert.equal(
    clientPointToCanvas(200, 200, { ...canvasBounds, width: 0 }, 1),
    null,
  );
  assert.equal(
    clientPointToCanvas(200, 200, { ...canvasBounds, height: -1 }, 1),
    null,
  );
  assert.equal(clientPointToCanvas(200, 200, canvasBounds, 0), null);
  assert.equal(clientPointToCanvas(200, 200, canvasBounds, Number.NaN), null);
  assert.equal(
    clientPointToCanvas(Number.POSITIVE_INFINITY, 200, canvasBounds, 1),
    null,
  );
});

test("one uninterrupted five reaches every prompt without pointer-up", () => {
  assert.equal(stagesReached(canonicalFive), 5);
  assert.equal(getFiveProgress(canonicalFive), FIVE_STAGE_COUNT);
  assert.equal(hasDetectedFive(canonicalFive), true);
});

test("detects a modestly diagonal five with small backtracks", () => {
  const noisyFive = [
    { x: 480, y: 90 },
    { x: 460, y: 95 },
    { x: 465, y: 92 },
    { x: 405, y: 105 },
    { x: 400, y: 132 },
    { x: 405, y: 127 },
    { x: 395, y: 188 },
    { x: 430, y: 194 },
    { x: 425, y: 191 },
    { x: 495, y: 204 },
    { x: 504, y: 234 },
    { x: 500, y: 229 },
    { x: 482, y: 298 },
    { x: 448, y: 309 },
    { x: 454, y: 305 },
    { x: 375, y: 322 },
  ];

  assert.equal(hasDetectedFive(noisyFive), true);
});

test("detection stays true as the same path keeps growing", () => {
  const continuedPath = [
    ...canonicalFive,
    { x: 470, y: 320 },
    { x: 520, y: 265 },
    { x: 490, y: 240 },
  ];

  assert.equal(hasDetectedFive(canonicalFive), true);
  assert.equal(hasDetectedFive(continuedPath), true);
});

test("a long straight line cannot complete direction-specific prompts", () => {
  const samples = [
    { x: 560, y: 100 },
    { x: 480, y: 100 },
    { x: 400, y: 100 },
    { x: 320, y: 100 },
    { x: 240, y: 100 },
    { x: 160, y: 100 },
  ];

  assert.equal(stagesReached(samples), 1);
  assert.equal(hasDetectedFive(samples), false);
});

test("rejects vertical, diagonal and tiny non-five marks", () => {
  const verticalLine = [
    { x: 400, y: 50 },
    { x: 400, y: 150 },
    { x: 400, y: 300 },
    { x: 400, y: 500 },
  ];
  const diagonalLine = [
    { x: 550, y: 80 },
    { x: 470, y: 145 },
    { x: 390, y: 210 },
    { x: 310, y: 275 },
    { x: 230, y: 340 },
  ];
  const tinyFive = canonicalFive.map(({ x, y }) => ({
    x: 300 + (x - 500) * 0.1,
    y: 250 + (y - 100) * 0.1,
  }));

  assert.equal(hasDetectedFive(verticalLine), false);
  assert.equal(hasDetectedFive(diagonalLine), false);
  assert.equal(hasDetectedFive(tinyFive), false);
});

test("does not report a partial five", () => {
  assert.equal(getFiveProgress(canonicalFive.slice(0, -1)), 4);
  assert.equal(hasDetectedFive(canonicalFive.slice(0, -1)), false);
});

test("each prompt rejects motion in the opposite direction", () => {
  assert.equal(hasReachedPrompt([{ x: 100, y: 100 }, { x: 180, y: 100 }], 0), false);
  assert.equal(hasReachedPrompt([{ x: 100, y: 180 }, { x: 100, y: 100 }], 1), false);
  assert.equal(hasReachedPrompt([{ x: 180, y: 100 }, { x: 100, y: 100 }], 2), false);
  assert.equal(hasReachedPrompt([{ x: 100, y: 180 }, { x: 100, y: 100 }], 3), false);
  assert.equal(hasReachedPrompt([{ x: 100, y: 100 }, { x: 180, y: 100 }], 4), false);
});

test("undo and redo preserve stroke order through a complete history cycle", () => {
  const a = [{ x: 1, y: 1 }];
  const b = [{ x: 2, y: 2 }];

  const undoB = undoStroke([a, b], []);
  assert.deepEqual(undoB, { strokes: [a], redoStrokes: [b] });

  const undoA = undoStroke(undoB.strokes, undoB.redoStrokes);
  assert.deepEqual(undoA, { strokes: [], redoStrokes: [b, a] });

  const redoA = redoStroke(undoA.strokes, undoA.redoStrokes);
  assert.deepEqual(redoA, { strokes: [a], redoStrokes: [b] });

  const redoB = redoStroke(redoA.strokes, redoA.redoStrokes);
  assert.deepEqual(redoB, { strokes: [a, b], redoStrokes: [] });
  assert.equal(undoStroke([], []), null);
  assert.equal(redoStroke([a], []), null);
});
