export type StrokeHistory<T> = {
  strokes: T[];
  redoStrokes: T[];
};

export function undoStroke<T>(
  strokes: readonly T[],
  redoStrokes: readonly T[],
): StrokeHistory<T> | null {
  const removed = strokes.at(-1);
  if (removed === undefined) return null;

  return {
    strokes: strokes.slice(0, -1),
    redoStrokes: [...redoStrokes, removed],
  };
}

export function redoStroke<T>(
  strokes: readonly T[],
  redoStrokes: readonly T[],
): StrokeHistory<T> | null {
  const restored = redoStrokes.at(-1);
  if (restored === undefined) return null;

  return {
    strokes: [...strokes, restored],
    redoStrokes: redoStrokes.slice(0, -1),
  };
}
