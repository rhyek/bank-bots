CREATE TABLE "scrape_run" (
	"id" uuid PRIMARY KEY NOT NULL,
	"bank_key" text NOT NULL,
	"trigger" text NOT NULL,
	"status" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"months" text[] NOT NULL,
	"account" text,
	"dry_run" boolean DEFAULT false NOT NULL,
	"result" jsonb,
	"error" jsonb
);
--> statement-breakpoint
CREATE INDEX "scrape_run_bank_key_started_at_idx" ON "scrape_run" USING btree ("bank_key","started_at");