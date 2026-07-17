CREATE TABLE "bank_account" (
	"id" uuid PRIMARY KEY NOT NULL,
	"bank_key" text NOT NULL,
	"account_number" text NOT NULL,
	"type" text NOT NULL,
	"currency" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "category" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"group_id" text NOT NULL,
	"hidden" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "category_group" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"hidden" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payee" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bank_txs" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "config" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "bank_txs" ADD COLUMN "bank_account_id" uuid;--> statement-breakpoint
ALTER TABLE "bank_txs" ADD COLUMN "payee_id" text;--> statement-breakpoint
ALTER TABLE "bank_txs" ADD COLUMN "category_id" text;--> statement-breakpoint
ALTER TABLE "bank_txs" ADD COLUMN "transfer_bank_account_id" uuid;--> statement-breakpoint
ALTER TABLE "category" ADD CONSTRAINT "category_group_id_category_group_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."category_group"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bank_account_unique_cols" ON "bank_account" USING btree ("bank_key","account_number");--> statement-breakpoint
ALTER TABLE "bank_txs" ADD CONSTRAINT "bank_txs_bank_account_id_bank_account_id_fk" FOREIGN KEY ("bank_account_id") REFERENCES "public"."bank_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_txs" ADD CONSTRAINT "bank_txs_payee_id_payee_id_fk" FOREIGN KEY ("payee_id") REFERENCES "public"."payee"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_txs" ADD CONSTRAINT "bank_txs_category_id_category_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."category"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_txs" ADD CONSTRAINT "bank_txs_transfer_bank_account_id_bank_account_id_fk" FOREIGN KEY ("transfer_bank_account_id") REFERENCES "public"."bank_account"("id") ON DELETE no action ON UPDATE no action;