export type Point = { x: number; y: number };
export type CanvasBounds = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export const CANVAS_WIDTH = 595;
export const CANVAS_HEIGHT = 842;
export const MIN_POINT_GAP = 2.5;
export const MIN_STROKE_TRAVEL = 8;

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
