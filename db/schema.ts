import { pgTable, text, jsonb, bigint, index } from "drizzle-orm/pg-core";

// Generic document store mirroring the app's path-based data model
// (e.g. rooms/1234, rooms/1234/members/alice).
export const docs = pgTable(
  "docs",
  {
    path: text().primaryKey(),
    parent: text().notNull(),
    data: jsonb().notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (t) => [index("docs_parent_idx").on(t.parent)],
);
