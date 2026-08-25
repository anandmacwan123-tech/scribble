export const DEFAULT_STROKE_COLOR = "#171713";
export const DEFAULT_STROKE_WIDTH = 1;
export const MIN_STROKE_WIDTH = 0;
export const MAX_STROKE_WIDTH = 10;

export function normalizeStrokeWidth(value: number) {
  if (!Number.isFinite(value)) return DEFAULT_STROKE_WIDTH;
  return Math.min(
    MAX_STROKE_WIDTH,
    Math.max(MIN_STROKE_WIDTH, Math.round(value * 100) / 100),
  );
}

export function normalizeStrokeColor(value: string) {
  return /^#[0-9a-f]{6}$/i.test(value)
    ? value.toUpperCase()
    : DEFAULT_STROKE_COLOR;
}

export function styleSvgStroke(
  svg: string,
  color: string,
  width: number,
) {
  const normalizedColor = normalizeStrokeColor(color);
  const normalizedWidth = normalizeStrokeWidth(width).toFixed(2);

  return svg
    .replace(/stroke="[^"]*"/gi, `stroke="${normalizedColor}"`)
    .replace(/stroke-width="[^"]*"/gi, `stroke-width="${normalizedWidth}"`);
}
