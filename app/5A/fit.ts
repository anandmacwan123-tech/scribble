export type ImageRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export function containImageRect(
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number,
): ImageRect {
  if (
    sourceWidth <= 0 ||
    sourceHeight <= 0 ||
    targetWidth <= 0 ||
    targetHeight <= 0
  ) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }

  const scale = Math.min(
    targetWidth / sourceWidth,
    targetHeight / sourceHeight,
  );
  const width = sourceWidth * scale;
  const height = sourceHeight * scale;

  return {
    x: (targetWidth - width) / 2,
    y: (targetHeight - height) / 2,
    width,
    height,
  };
}
