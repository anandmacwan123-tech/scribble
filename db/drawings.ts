export type StoredDrawing = {
  id: string;
  svg: string;
  width: number;
  height: number;
};

export type DrawingMetadataRow = {
  id: string;
  width: number;
  height: number;
  created_at: number;
  updated_at: number;
};

export type DrawingRow = DrawingMetadataRow & {
  svg: string;
};

export type DrawingCursor = {
  createdAt: number;
  id: string;
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
       ON CONFLICT(id) DO NOTHING`,
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

export async function listDrawingMetadata(
  database: D1Database,
  limit: number,
  cursor?: DrawingCursor,
) {
  const statement = cursor
    ? database
        .prepare(
          `SELECT id, width, height, created_at, updated_at
           FROM drawings
           WHERE created_at < ? OR (created_at = ? AND id < ?)
           ORDER BY created_at DESC, id DESC
           LIMIT ?`,
        )
        .bind(cursor.createdAt, cursor.createdAt, cursor.id, limit)
    : database
        .prepare(
          `SELECT id, width, height, created_at, updated_at
           FROM drawings
           ORDER BY created_at DESC, id DESC
           LIMIT ?`,
        )
        .bind(limit);

  return (await statement.all<DrawingMetadataRow>()).results;
}

export function findDrawingById(database: D1Database, id: string) {
  return database
    .prepare(
      `SELECT id, svg, width, height, created_at, updated_at
       FROM drawings
       WHERE id = ?`,
    )
    .bind(id)
    .first<DrawingRow>();
}

export async function findDrawingsByIds(
  database: D1Database,
  ids: string[],
) {
  const placeholders = ids.map(() => "?").join(", ");
  return (
    await database
      .prepare(
        `SELECT id, svg, width, height, created_at, updated_at
         FROM drawings
         WHERE id IN (${placeholders})`,
      )
      .bind(...ids)
      .all<DrawingRow>()
  ).results;
}
