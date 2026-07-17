ALTER TABLE "bank_tx" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "category" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "category" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "payee" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "payee" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
-- Hand-authored (drizzle-kit can't model triggers/functions). Keeps `updated_at` correct for writes
-- from any path (scrape-txs, raw db.execute, psql), and notifies the ai-agent replica in real time.
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE OR REPLACE TRIGGER trg_set_updated_at BEFORE INSERT OR UPDATE ON "payee"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
CREATE OR REPLACE TRIGGER trg_set_updated_at BEFORE INSERT OR UPDATE ON "category"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
CREATE OR REPLACE TRIGGER trg_set_updated_at BEFORE INSERT OR UPDATE ON "bank_tx"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
-- Emit {table, op, id} on the 'replica_events' channel for INSERT/UPDATE/DELETE. id-only payload:
-- the ai-agent listener reads the row from Postgres itself (avoids pg_notify's 8KB payload limit).
CREATE OR REPLACE FUNCTION replica_notify() RETURNS trigger AS $$
DECLARE
  rec_id text;
BEGIN
  IF (TG_OP = 'DELETE') THEN
    rec_id := OLD.id::text;
  ELSE
    rec_id := NEW.id::text;
  END IF;
  PERFORM pg_notify(
    'replica_events',
    json_build_object('table', TG_TABLE_NAME, 'op', lower(TG_OP), 'id', rec_id)::text
  );
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE OR REPLACE TRIGGER trg_replica_notify AFTER INSERT OR UPDATE OR DELETE ON "payee"
  FOR EACH ROW EXECUTE FUNCTION replica_notify();--> statement-breakpoint
CREATE OR REPLACE TRIGGER trg_replica_notify AFTER INSERT OR UPDATE OR DELETE ON "category"
  FOR EACH ROW EXECUTE FUNCTION replica_notify();--> statement-breakpoint
CREATE OR REPLACE TRIGGER trg_replica_notify AFTER INSERT OR UPDATE OR DELETE ON "bank_tx"
  FOR EACH ROW EXECUTE FUNCTION replica_notify();
