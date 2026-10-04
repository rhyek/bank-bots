-- What the 5-character "city" field of a bank description stands for ("GUATE" -> Guatemala City,
-- GT), resolved once per distinct field by tx-payees. It lets a purchase at a physical business be
-- placed in the country its own description names, which a global chain's payee cannot say.

CREATE TABLE "place_field" (
	"field" text PRIMARY KEY NOT NULL,
	"country" text,
	"place" text,
	"data" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- Hand-appended (drizzle-kit can't model triggers). updated_at only: the table is not replicated.
CREATE OR REPLACE TRIGGER trg_set_updated_at BEFORE INSERT OR UPDATE ON "place_field"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
