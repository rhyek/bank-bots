CREATE TABLE "matcher_result" (
	"id" uuid PRIMARY KEY NOT NULL,
	"bank_tx_id" uuid NOT NULL,
	"type" text NOT NULL,
	"payee_id" text,
	"category_id" text,
	"source_tx_id" uuid,
	"matching_rule_id" uuid,
	"data" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "matcher_result" ADD CONSTRAINT "matcher_result_bank_tx_id_bank_tx_id_fk" FOREIGN KEY ("bank_tx_id") REFERENCES "public"."bank_tx"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matcher_result" ADD CONSTRAINT "matcher_result_payee_id_payee_id_fk" FOREIGN KEY ("payee_id") REFERENCES "public"."payee"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matcher_result" ADD CONSTRAINT "matcher_result_category_id_category_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."category"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matcher_result" ADD CONSTRAINT "matcher_result_source_tx_id_bank_tx_id_fk" FOREIGN KEY ("source_tx_id") REFERENCES "public"."bank_tx"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matcher_result" ADD CONSTRAINT "matcher_result_matching_rule_id_matching_rule_id_fk" FOREIGN KEY ("matching_rule_id") REFERENCES "public"."matching_rule"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "matcher_result_bank_tx_id_idx" ON "matcher_result" USING btree ("bank_tx_id");--> statement-breakpoint
-- Hand-appended (drizzle-kit can't model triggers). Same pair every replicated table gets: keep
-- updated_at correct for writes from any path, and notify the tx-payees replica so the skip-on-none
-- check sees a verdict without waiting for a restart.
CREATE OR REPLACE TRIGGER trg_set_updated_at BEFORE INSERT OR UPDATE ON "matcher_result"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
CREATE OR REPLACE TRIGGER trg_replica_notify AFTER INSERT OR UPDATE OR DELETE ON "matcher_result"
  FOR EACH ROW EXECUTE FUNCTION replica_notify();
