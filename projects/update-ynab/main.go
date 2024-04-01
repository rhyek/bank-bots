package main

import (
	"encoding/json"
	"log/slog"
	"os"

	"bank-bots/update-ynab/banks"
	"bank-bots/update-ynab/types"
	"bank-bots/update-ynab/ynab"

	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/jmoiron/sqlx"
)

func init() {
	logger := slog.New(slog.NewTextHandler(os.Stderr, nil))
	slog.SetDefault(logger)
}

func main() {
	db, err := sqlx.Connect("pgx", os.Getenv("DATABASE_URL"))
	if err != nil {
		logFatal(err)
	}

	config, err := loadConfig(db)
	if err != nil {
		logFatal(err)
	}

	bankAccountsWithTxs, err := banks.LoadBankTxs(db)
	if err != nil {
		logFatal(err)
	}

	err = ynab.UpdateYnabTxs(config, bankAccountsWithTxs)
	if err != nil {
		logFatal(err)
	}

	slog.Info("done")
}

func logFatal(err error) {
	slog.Error(err.Error())
	os.Exit(1)
}

func loadConfig(db *sqlx.DB) (types.Config, error) {
	configJson := ""
	err := db.Get(&configJson, "select data from config where id = 'general'")
	if err != nil {
		return types.Config{}, err
	}
	config := types.Config{}
	err = json.Unmarshal([]byte(configJson), &config)
	if err != nil {
		return types.Config{}, err
	}
	return config, nil
}
