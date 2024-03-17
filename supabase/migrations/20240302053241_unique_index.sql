alter table "public"."banco_industrial_gt_txs" add column "account_number" text not null;

alter table "public"."banco_industrial_gt_txs" alter column "amount" set data type numeric using "amount"::numeric;

alter table "public"."banco_industrial_gt_txs" disable row level security;

CREATE UNIQUE INDEX banco_industrial_gt_txs_account_number_month_date_descripti_idx ON public.banco_industrial_gt_txs USING btree (account_number, month, date, description, doc_no, amount);


