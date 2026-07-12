// Command backfill pushes the full history of a SINGLE bank account into YNAB, scoped so it
// cannot touch any other account's existing YNAB data. This complements the normal update-ynab
// run, which only syncs the current/previous month. Configure via env vars:
//
//	BACKFILL_FROM_MONTH      YYYY-MM to start from (e.g. 2026-03)
//	BACKFILL_BANK_KEY        bank key of the account (e.g. bacGt)
//	BACKFILL_ACCOUNT_NUMBER  the account number to backfill
//	DATABASE_URL             Postgres connection string
package main

import (
	"encoding/json"
	"log/slog"
	"os"
	"time"

	"bank-bots/update-ynab/banks"
	"bank-bots/update-ynab/types"
	"bank-bots/update-ynab/ynab"

	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/jmoiron/sqlx"
)

func main() {
	slog.SetDefault(slog.New(slog.NewTextHandler(os.Stderr, nil)))

	fromStr := os.Getenv("BACKFILL_FROM_MONTH")
	bankKey := os.Getenv("BACKFILL_BANK_KEY")
	accountNumber := os.Getenv("BACKFILL_ACCOUNT_NUMBER")
	if fromStr == "" || bankKey == "" || accountNumber == "" {
		slog.Error("BACKFILL_FROM_MONTH, BACKFILL_BANK_KEY and BACKFILL_ACCOUNT_NUMBER are required")
		os.Exit(1)
	}
	fromMonth, err := time.Parse("2006-01", fromStr)
	if err != nil {
		slog.Error("invalid BACKFILL_FROM_MONTH (want YYYY-MM)", "err", err)
		os.Exit(1)
	}

	db, err := sqlx.Connect("pgx", os.Getenv("DATABASE_URL"))
	if err != nil {
		panic(err)
	}
	var configJson string
	if err := db.Get(&configJson, "select data from config where id = 'general'"); err != nil {
		panic(err)
	}
	config := &types.Config{}
	if err := json.Unmarshal([]byte(configJson), config); err != nil {
		panic(err)
	}

	all, err := banks.LoadBankTxs(db, fromMonth)
	if err != nil {
		panic(err)
	}
	var only []types.BankAccountWithTransactions
	for _, ba := range all {
		if ba.BankKey == bankKey && ba.Account.Number == accountNumber {
			only = append(only, ba)
		}
	}
	if len(only) == 0 {
		slog.Error("no matching account with transactions found", "bankKey", bankKey, "account", accountNumber)
		os.Exit(1)
	}

	slog.Info("backfilling single account into YNAB",
		"bankKey", bankKey, "account", accountNumber,
		"fromMonth", fromMonth.Format("2006-01"), "txs", len(only[0].Transactions))
	if err := ynab.UpdateYnabWithBankTxs(config, only, fromMonth); err != nil {
		panic(err)
	}
	slog.Info("backfill done")
}
