import assert from "node:assert/strict";
import test from "node:test";
import {
  CANVAS_HEIGHT,
  CANVAS_WIDTH,
  clientPointToCanvas,
} from "../app/gesture.ts";
import { redoStroke, undoStroke } from "../app/history.ts";

const canvasBounds = {
  left: 100,
  top: 50,
  width: CANVAS_WIDTH,
  height: CANVAS_HEIGHT,
};

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
