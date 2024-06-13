package main

import (
	"context"
	"encoding/json"
	"log/slog"
	"os"
	"time"

	"bank-bots/update-ynab/banks"
	"bank-bots/update-ynab/types"
	"bank-bots/update-ynab/ynab"

	"github.com/aws/aws-lambda-go/lambda"
	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/jmoiron/sqlx"
)

func main() {
	logger := slog.New(slog.NewTextHandler(os.Stderr, nil))
	slog.SetDefault(logger)

	if os.Getenv("AWS_LAMBDA_FUNCTION_NAME") != "" { // is lambda
		// https://docs.aws.amazon.com/lambda/latest/dg/golang-handler.html
		lambda.Start(func(ctx context.Context) (*string, error) {
			return work()
		})
	} else { // is console
		msg, err := work()
		if err != nil {
			slog.Error(err.Error())
			os.Exit(1)
		}
		slog.Info(*msg)
	}
}

func loadConfig(db *sqlx.DB) (*types.Config, error) {
	configJson := ""
	err := db.Get(&configJson, "select data from config where id = 'general'")
	if err != nil {
		return nil, err
	}
	config := &types.Config{}
	err = json.Unmarshal([]byte(configJson), config)
	if err != nil {
		return nil, err
	}
	return config, nil
}

func work() (*string, error) {
	slog.Info("starting ynab update")

	db, err := sqlx.Connect("pgx", os.Getenv("DATABASE_URL"))
	if err != nil {
		return nil, err
	}

	config, err := loadConfig(db)
	if err != nil {
		return nil, err
	}

	var fromMonth time.Time
	if time.Now().Day() <= 10 {
		year, month, day := time.Now().Date()
		fromMonth = time.Date(year, month-1, day, 0, 0, 0, 0, time.UTC)
	} else {
		fromMonth = time.Now()
	}

	bankAccountsWithTxs, err := banks.LoadBankTxs(db, fromMonth)
	if err != nil {
		return nil, err
	}

	err = ynab.UpdateYnabWithBankTxs(config, bankAccountsWithTxs, fromMonth)
	if err != nil {
		return nil, err
	}

	err = ynab.UpdateEmptyPayees(config)
	if err != nil {
		return nil, err
	}

	msg := "done"
	return &msg, nil
}
