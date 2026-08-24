import { desc, sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

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
