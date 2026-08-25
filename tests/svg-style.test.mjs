import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeStrokeColor,
  normalizeStrokeWidth,
  styleSvgStroke,
} from "../app/5A/style.ts";

test("styles every canonical SVG stroke with two-decimal width precision", () => {
  const svg = '<svg><path stroke="#171713" stroke-width="1"/><path stroke="#000" stroke-width="4.5"/></svg>';
  const styled = styleSvgStroke(svg, "#12abef", 3.456);

  assert.equal((styled.match(/stroke="#12ABEF"/g) ?? []).length, 2);
  assert.equal((styled.match(/stroke-width="3.46"/g) ?? []).length, 2);
});

test("clamps stroke width from 0.00px to 10.00px", () => {
  assert.equal(normalizeStrokeWidth(-2), 0);
  assert.equal(normalizeStrokeWidth(0.004), 0);
  assert.equal(normalizeStrokeWidth(4.567), 4.57);
  assert.equal(normalizeStrokeWidth(25), 10);
});

test("accepts six-digit hex colours and rejects invalid values", () => {
  assert.equal(normalizeStrokeColor("#abcdef"), "#ABCDEF");
  assert.equal(normalizeStrokeColor("red"), "#171713");
});
