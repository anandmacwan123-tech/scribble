export type StoredDrawing = {
  id: string;
  svg: string;
  width: number;
  height: number;
};

export type BaseDrawingMetadataRow = {
  id: string;
  width: number;
  height: number;
  created_at: number;
  updated_at: number;
};

export type DrawingMetadataRow = BaseDrawingMetadataRow & {
  crop_x: number | null;
  crop_y: number | null;
  crop_width: number | null;
  crop_height: number | null;
  crop_revision: number | null;
  crop_updated_at: number | null;
};

export type DrawingRow = BaseDrawingMetadataRow & {
  svg: string;
};

export type DrawingCursor = {
  createdAt: number;
  id: string;
};

export type DrawingCropRow = {
  drawing_id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  revision: number;
  updated_at: number;
};

export type StoredDrawingCrop = Pick<
  DrawingCropRow,
  "x" | "y" | "width" | "height"
>;

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
          `SELECT d.id, d.width, d.height, d.created_at, d.updated_at,
                  c.x AS crop_x, c.y AS crop_y,
                  c.width AS crop_width, c.height AS crop_height,
                  c.revision AS crop_revision,
                  c.updated_at AS crop_updated_at
           FROM drawings d
           LEFT JOIN drawing_crops c ON c.drawing_id = d.id
           WHERE d.created_at < ? OR (d.created_at = ? AND d.id < ?)
           ORDER BY d.created_at DESC, d.id DESC
           LIMIT ?`,
        )
        .bind(cursor.createdAt, cursor.createdAt, cursor.id, limit)
    : database
        .prepare(
          `SELECT d.id, d.width, d.height, d.created_at, d.updated_at,
                  c.x AS crop_x, c.y AS crop_y,
                  c.width AS crop_width, c.height AS crop_height,
                  c.revision AS crop_revision,
                  c.updated_at AS crop_updated_at
           FROM drawings d
           LEFT JOIN drawing_crops c ON c.drawing_id = d.id
           ORDER BY d.created_at DESC, d.id DESC
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

export function drawingExistsById(database: D1Database, id: string) {
  return database
    .prepare("SELECT id FROM drawings WHERE id = ?")
    .bind(id)
    .first<{ id: string }>();
}

export function findDrawingCropById(database: D1Database, id: string) {
  return database
    .prepare(
      `SELECT drawing_id, x, y, width, height, revision, updated_at
       FROM drawing_crops
       WHERE drawing_id = ?`,
    )
    .bind(id)
    .first<DrawingCropRow>();
}

export function upsertDrawingCrop(
  database: D1Database,
  drawingId: string,
  crop: StoredDrawingCrop,
  expectedRevision: number,
  nextRevision: number,
) {
  const now = Math.floor(Date.now() / 1000);
  if (expectedRevision === 0) {
    return database
      .prepare(
        `INSERT INTO drawing_crops
           (drawing_id, x, y, width, height, revision, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(drawing_id) DO NOTHING
         RETURNING drawing_id, x, y, width, height, revision, updated_at`,
      )
      .bind(
        drawingId,
        crop.x,
        crop.y,
        crop.width,
        crop.height,
        nextRevision,
        now,
      )
      .first<DrawingCropRow>();
  }

  return database
    .prepare(
      `UPDATE drawing_crops
       SET x = ?, y = ?, width = ?, height = ?,
           revision = ?, updated_at = ?
       WHERE drawing_id = ? AND revision = ?
       RETURNING drawing_id, x, y, width, height, revision, updated_at`,
    )
    .bind(
      crop.x,
      crop.y,
      crop.width,
      crop.height,
      nextRevision,
      now,
      drawingId,
      expectedRevision,
    )
    .first<DrawingCropRow>();
}

export function deleteDrawingCrop(
  database: D1Database,
  drawingId: string,
  expectedRevision: number,
) {
  return database
    .prepare(
      `DELETE FROM drawing_crops
       WHERE drawing_id = ? AND revision = ?
       RETURNING drawing_id, x, y, width, height, revision, updated_at`,
    )
    .bind(drawingId, expectedRevision)
    .first<DrawingCropRow>();
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

export function deleteAllDrawings(database: D1Database) {
  return database.prepare("DELETE FROM drawings").run();
}
