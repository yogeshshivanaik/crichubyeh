CREATE TABLE "docs" (
	"path" text PRIMARY KEY,
	"parent" text NOT NULL,
	"data" jsonb NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "docs_parent_idx" ON "docs" ("parent");