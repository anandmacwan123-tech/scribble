export type MaskKind = "grid" | "slice";
export type SliceDirection = "horizontal" | "vertical";

export type MaskRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export const GRID_COLUMNS = 5;
export const GRID_ROWS = 10;
export const SLICE_COUNT = 50;
export const MASK_REGION_COUNT = GRID_COLUMNS * GRID_ROWS;

export function buildMaskRects(
  kind: MaskKind,
  width: number,
  height: number,
  sliceDirection: SliceDirection = "horizontal",
): MaskRect[] {
  if (width <= 0 || height <= 0) return [];

  if (kind === "slice") {
    if (sliceDirection === "vertical") {
      const sliceWidth = width / SLICE_COUNT;
      return Array.from({ length: SLICE_COUNT }, (_, slice) => ({
        x: slice * sliceWidth,
        y: 0,
        width: sliceWidth,
        height,
      }));
    }

    const sliceHeight = height / SLICE_COUNT;
    return Array.from({ length: SLICE_COUNT }, (_, slice) => ({
      x: 0,
      y: slice * sliceHeight,
      width,
      height: sliceHeight,
    }));
  }

  const cellWidth = width / GRID_COLUMNS;
  const cellHeight = height / GRID_ROWS;
  return Array.from({ length: MASK_REGION_COUNT }, (_, cell) => ({
    x: (cell % GRID_COLUMNS) * cellWidth,
    y: Math.floor(cell / GRID_COLUMNS) * cellHeight,
    width: cellWidth,
    height: cellHeight,
  }));
}
