CREATE TABLE "matching_rule" (
	"id" uuid PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"pattern" text NOT NULL,
	"priority" bigint NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bank_tx" ADD COLUMN "reconcile" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "matching_rule_label_unique" ON "matching_rule" USING btree ("label");--> statement-breakpoint
-- Backfill the flag from the old sentinel. doc_no keeps its 'RECONCILE' value on that row but stops
-- being load-bearing: reconciliation rows are identified by this flag from here on, and new ones can
-- carry a real document number.
UPDATE "bank_tx" SET "reconcile" = true WHERE "doc_no" = 'RECONCILE';--> statement-breakpoint
-- Hand-appended (drizzle-kit can't model triggers). Same pair every replicated table gets: keep
-- updated_at correct for writes from any path, and notify the ai-agent replica so rule edits apply
-- without restarting the agent.
CREATE OR REPLACE TRIGGER trg_set_updated_at BEFORE INSERT OR UPDATE ON "matching_rule"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
CREATE OR REPLACE TRIGGER trg_replica_notify AFTER INSERT OR UPDATE OR DELETE ON "matching_rule"
  FOR EACH ROW EXECUTE FUNCTION replica_notify();