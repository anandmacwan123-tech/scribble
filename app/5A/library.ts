export type LibraryMode = "default" | "edited";

export type DrawingCrop = {
  x: number;
  y: number;
  width: number;
  height: number;
  revision: number;
  updatedAt: string;
};

export type LibraryDrawing = {
  id: string;
  updatedAt: string;
  previewUrl: string;
  crop: DrawingCrop | null;
};

export function getLayerSourceKey(
  drawing: LibraryDrawing,
  library: LibraryMode,
) {
  if (library === "default" || !drawing.crop) {
    return `${drawing.id}:${drawing.updatedAt}:identity`;
  }
  const { x, y, width, height, revision } = drawing.crop;
  return `${drawing.id}:${drawing.updatedAt}:5E:${revision}:${x},${y},${width},${height}`;
}

export function getLibraryPreviewUrl(
  drawing: LibraryDrawing,
  library: LibraryMode,
  origin: string,
  sourceKey = getLayerSourceKey(drawing, library),
) {
  const url = new URL(drawing.previewUrl, origin);
  if (library === "edited" && drawing.crop) url.searchParams.set("crop", "1");
  url.searchParams.set("v", sourceKey);
  return url.toString();
}
