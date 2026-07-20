-- category_group is now replicated to tx-payees (the AI tier needs a category's group name, both to
-- avoid the manual "Events" group and to pass a real group_id to create_category).
--
-- Replication requires this pair: replica-sync uses max(updated_at) as its delta-sync watermark, so
-- a replicated table without it would re-pull the whole table on every boot. Migration 0007 gave the
-- other replicated tables the same columns and triggers; category_group was not replicated then.
ALTER TABLE "category_group" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "category_group" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
CREATE OR REPLACE TRIGGER trg_set_updated_at BEFORE INSERT OR UPDATE ON "category_group"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
CREATE OR REPLACE TRIGGER trg_replica_notify AFTER INSERT OR UPDATE OR DELETE ON "category_group"
  FOR EACH ROW EXECUTE FUNCTION replica_notify();
