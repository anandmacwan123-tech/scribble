import { desc, sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  real,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

export const drawings = sqliteTable(
  "drawings",
  {
    id: text("id").primaryKey(),
    svg: text("svg").notNull(),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch())`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch())`),
  },
  (table) => [
    index("drawings_created_at_id_idx").on(
      desc(table.createdAt),
      desc(table.id),
    ),
  ],
);

export const drawingCrops = sqliteTable(
  "drawing_crops",
  {
    drawingId: text("drawing_id")
      .primaryKey()
      .notNull()
      .references(() => drawings.id, { onDelete: "cascade" }),
    x: real("x").notNull(),
    y: real("y").notNull(),
    width: real("width").notNull(),
    height: real("height").notNull(),
    revision: integer("revision").notNull().default(1),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch())`),
  },
  (table) => [
    check("drawing_crops_x_check", sql`${table.x} >= 0`),
    check("drawing_crops_y_check", sql`${table.y} >= 0`),
    check("drawing_crops_width_check", sql`${table.width} >= 12`),
    check("drawing_crops_height_check", sql`${table.height} >= 16.981`),
    check("drawing_crops_revision_check", sql`${table.revision} >= 1`),
    check(
      "drawing_crops_x_bounds_check",
      sql`${table.x} + ${table.width} <= 595.001`,
    ),
    check(
      "drawing_crops_y_bounds_check",
      sql`${table.y} + ${table.height} <= 842.001`,
    ),
    check(
      "drawing_crops_ratio_check",
      sql`abs(${table.width} * 842.0 - ${table.height} * 595.0) <= 1.0`,
    ),
  ],
);
