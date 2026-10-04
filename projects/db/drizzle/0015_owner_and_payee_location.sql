-- Location for payees and transactions (docs/superpowers/specs/2026-10-04-owner-and-payee-location-design.md).
--
-- payee.country/location/location_kind say where a business is; bank_tx.country/location say where
-- the owner was when the purchase happened. owner_day_location holds one resolved row per calendar
-- day, which transactions look up; payee_location_result is the audit log of payee decisions.
-- Everything added here is nullable or a new table, so existing rows and the scraper are unaffected.

CREATE TABLE "owner_day_location" (
	"date" date PRIMARY KEY NOT NULL,
	"country" text,
	"location" text,
	"basis" text NOT NULL,
	"confidence" text NOT NULL,
	"provisional" boolean NOT NULL,
	"data" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payee_location_result" (
	"id" uuid PRIMARY KEY NOT NULL,
	"payee_id" text NOT NULL,
	"kind" text NOT NULL,
	"country" text,
	"location" text,
	"data" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bank_tx" ADD COLUMN "country" text;--> statement-breakpoint
ALTER TABLE "bank_tx" ADD COLUMN "location" text;--> statement-breakpoint
ALTER TABLE "payee" ADD COLUMN "country" text;--> statement-breakpoint
ALTER TABLE "payee" ADD COLUMN "location" text;--> statement-breakpoint
ALTER TABLE "payee" ADD COLUMN "location_kind" text;--> statement-breakpoint
ALTER TABLE "payee_location_result" ADD CONSTRAINT "payee_location_result_payee_id_payee_id_fk" FOREIGN KEY ("payee_id") REFERENCES "public"."payee"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payee_location_result_payee_id_idx" ON "payee_location_result" USING btree ("payee_id");--> statement-breakpoint
-- Hand-appended (drizzle-kit can't model triggers). Only the updated_at half of the usual pair:
-- neither table is replicated to tx-payees' SQLite, so there is nothing for replica_notify to tell.
-- The day resolver's "resolved more than 24 hours ago" test reads owner_day_location.updated_at.
CREATE OR REPLACE TRIGGER trg_set_updated_at BEFORE INSERT OR UPDATE ON "owner_day_location"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
CREATE OR REPLACE TRIGGER trg_set_updated_at BEFORE INSERT OR UPDATE ON "payee_location_result"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
