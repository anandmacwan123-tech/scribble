export type Point = { x: number; y: number };

export const CANVAS_WIDTH = 842;
export const CANVAS_HEIGHT = 595;
export const MIN_POINT_GAP = 2.5;
export const MIN_STROKE_TRAVEL = 8;

const HORIZONTAL_STAGE_TRAVEL = CANVAS_WIDTH * 0.075;
const VERTICAL_STAGE_TRAVEL = CANVAS_HEIGHT * 0.085;

export function distance(a: Point, b: Point) {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

export function lengthOf(points: Point[]) {
  let length = 0;
  for (let index = 1; index < points.length; index += 1) {
    length += distance(points[index - 1], points[index]);
  }
  return length;
}

export function isAccepted(points: Point[]) {
  return points.length >= 2 && lengthOf(points) >= MIN_STROKE_TRAVEL;
}

export function hasReachedPrompt(points: Point[], promptIndex: number) {
  if (!isAccepted(points)) return false;

  const last = points[points.length - 1];
  // Measure from the furthest point so a slight overshoot at each turn does
  // not force the person to lift and restart the gesture.
  let minX = last.x;
  let maxX = last.x;
  let minY = last.y;
  for (const point of points) {
    minX = Math.min(minX, point.x);
    maxX = Math.max(maxX, point.x);
    minY = Math.min(minY, point.y);
  }

  switch (promptIndex) {
    case 0:
    case 4:
      return maxX - last.x >= HORIZONTAL_STAGE_TRAVEL;
    case 1:
    case 3:
      return last.y - minY >= VERTICAL_STAGE_TRAVEL;
    case 2:
      return last.x - minX >= HORIZONTAL_STAGE_TRAVEL;
    default:
      return false;
  }
}
