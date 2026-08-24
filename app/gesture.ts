export type Point = { x: number; y: number };
export type CanvasBounds = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export const CANVAS_WIDTH = 842;
export const CANVAS_HEIGHT = 595;
export const MIN_POINT_GAP = 2.5;
export const MIN_STROKE_TRAVEL = 8;
export const FIVE_STAGE_COUNT = 5;

const HORIZONTAL_STAGE_TRAVEL = CANVAS_WIDTH * 0.075;
const VERTICAL_STAGE_TRAVEL = CANVAS_HEIGHT * 0.085;
const MIN_DIRECTION_DOMINANCE = 0.35;

type FiveDirection = "left" | "down" | "right";

const FIVE_DIRECTIONS: readonly FiveDirection[] = [
  "left",
  "down",
  "right",
  "down",
  "left",
];

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

/** Maps a client point through a centre-origin canvas zoom into A4 viewBox space. */
export function clientPointToCanvas(
  clientX: number,
  clientY: number,
  bounds: CanvasBounds,
  zoom: number,
): Point | null {
  if (
    !Number.isFinite(clientX) ||
    !Number.isFinite(clientY) ||
    !Number.isFinite(bounds.left) ||
    !Number.isFinite(bounds.top) ||
    !Number.isFinite(bounds.width) ||
    !Number.isFinite(bounds.height) ||
    !Number.isFinite(zoom) ||
    bounds.width <= 0 ||
    bounds.height <= 0 ||
    zoom <= 0
  ) {
    return null;
  }

  const centerX = bounds.left + bounds.width / 2;
  const centerY = bounds.top + bounds.height / 2;
  const normalizedX = 0.5 + (clientX - centerX) / (bounds.width * zoom);
  const normalizedY = 0.5 + (clientY - centerY) / (bounds.height * zoom);

  return {
    x: clamp(normalizedX * CANVAS_WIDTH, 0, CANVAS_WIDTH),
    y: clamp(normalizedY * CANVAS_HEIGHT, 0, CANVAS_HEIGHT),
  };
}

export function distance(a: Point, b: Point) {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

export function lengthOf(points: readonly Point[]) {
  let length = 0;
  for (let index = 1; index < points.length; index += 1) {
    length += distance(points[index - 1], points[index]);
  }
  return length;
}

export function isAccepted(points: readonly Point[]) {
  return points.length >= 2 && lengthOf(points) >= MIN_STROKE_TRAVEL;
}

export function hasReachedPrompt(
  points: readonly Point[],
  promptIndex: number,
) {
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

function projectedMovement(
  direction: FiveDirection,
  dx: number,
  dy: number,
) {
  if (direction === "left") {
    return { forward: -dx, lateral: Math.abs(dy) };
  }

  if (direction === "right") {
    return { forward: dx, lateral: Math.abs(dy) };
  }

  return { forward: dy, lateral: Math.abs(dx) };
}

function stageTravel(direction: FiveDirection) {
  return direction === "down"
    ? VERTICAL_STAGE_TRAVEL
    : HORIZONTAL_STAGE_TRAVEL;
}

/**
 * Returns how many ordered parts of a handwritten five have been found in a
 * single growing path. Small backtracks reduce progress, while off-axis motion
 * is tolerated so rounded and slightly diagonal fives still register.
 */
export function getFiveProgress(points: readonly Point[]) {
  if (points.length < 2) return 0;

  let stage = 0;
  let progress = 0;

  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    if (
      !Number.isFinite(previous.x) ||
      !Number.isFinite(previous.y) ||
      !Number.isFinite(current.x) ||
      !Number.isFinite(current.y)
    ) {
      return 0;
    }

    const direction = FIVE_DIRECTIONS[stage];
    const { forward, lateral } = projectedMovement(
      direction,
      current.x - previous.x,
      current.y - previous.y,
    );
    const followsAxis =
      Math.abs(forward) >= lateral * MIN_DIRECTION_DOMINANCE;

    if (followsAxis) {
      progress = Math.max(0, progress + forward);
    }

    if (progress < stageTravel(direction)) continue;

    stage += 1;
    progress = 0;
    if (stage === FIVE_STAGE_COUNT) return stage;
  }

  return stage;
}

/** True once the path contains a complete left, down, right, down, left five. */
export function hasDetectedFive(points: readonly Point[]) {
  return getFiveProgress(points) === FIVE_STAGE_COUNT;
}
