export type StoredDrawing = {
  id: string;
  svg: string;
  width: number;
  height: number;
};

export async function upsertDrawing(
  database: D1Database,
  drawing: StoredDrawing,
) {
  const now = Math.floor(Date.now() / 1000);
  return database
    .prepare(
      `INSERT INTO drawings (id, svg, width, height, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         svg = excluded.svg,
         width = excluded.width,
         height = excluded.height,
         updated_at = excluded.updated_at`,
    )
    .bind(
      drawing.id,
      drawing.svg,
      drawing.width,
      drawing.height,
      now,
      now,
    )
    .run();
}
