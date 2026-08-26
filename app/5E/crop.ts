export const A4_WIDTH = 595;
export const A4_HEIGHT = 842;
export const MIN_ZOOM = 1;
export const MAX_ZOOM = 8;

export type CropRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

const PRECISION = 1_000;
const EPSILON = 1 / PRECISION;

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function round(value: number) {
  return Math.round(value * PRECISION) / PRECISION;
}

export function fullCrop(): CropRect {
  return { x: 0, y: 0, width: A4_WIDTH, height: A4_HEIGHT };
}

export function zoomForCrop(crop: CropRect) {
  return clamp(A4_WIDTH / crop.width, MIN_ZOOM, MAX_ZOOM);
}

export function cropAtZoom(
  zoom: number,
  centerX = A4_WIDTH / 2,
  centerY = A4_HEIGHT / 2,
): CropRect {
  const normalizedZoom = clamp(zoom, MIN_ZOOM, MAX_ZOOM);
  const width = A4_WIDTH / normalizedZoom;
  const height = A4_HEIGHT / normalizedZoom;
  const x = clamp(centerX - width / 2, 0, A4_WIDTH - width);
  const y = clamp(centerY - height / 2, 0, A4_HEIGHT - height);

  return {
    x: round(x),
    y: round(y),
    width: round(width),
    height: round(height),
  };
}

export function normalizeCrop(value: CropRect | null | undefined): CropRect {
  if (
    !value ||
    !Number.isFinite(value.x) ||
    !Number.isFinite(value.y) ||
    !Number.isFinite(value.width) ||
    !Number.isFinite(value.height) ||
    value.width <= 0 ||
    value.height <= 0
  ) {
    return fullCrop();
  }

  const zoom = clamp(
    Math.min(A4_WIDTH / value.width, A4_HEIGHT / value.height),
    MIN_ZOOM,
    MAX_ZOOM,
  );
  return cropAtZoom(
    zoom,
    value.x + value.width / 2,
    value.y + value.height / 2,
  );
}

export function setCropZoom(crop: CropRect, zoom: number): CropRect {
  return cropAtZoom(
    zoom,
    crop.x + crop.width / 2,
    crop.y + crop.height / 2,
  );
}

export function moveCrop(crop: CropRect, deltaX: number, deltaY: number) {
  return {
    ...crop,
    x: round(clamp(crop.x + deltaX, 0, A4_WIDTH - crop.width)),
    y: round(clamp(crop.y + deltaY, 0, A4_HEIGHT - crop.height)),
  };
}

export function cropsEqual(left: CropRect, right: CropRect) {
  return (
    Math.abs(left.x - right.x) <= EPSILON &&
    Math.abs(left.y - right.y) <= EPSILON &&
    Math.abs(left.width - right.width) <= EPSILON &&
    Math.abs(left.height - right.height) <= EPSILON
  );
}

export function isFullCrop(crop: CropRect) {
  return cropsEqual(crop, fullCrop());
}
