package main

import (
	"encoding/json"
	"fmt"
	"log"
	"log/slog"
	"os"
	"time"

	"bank-bots/update-ynab/types"

	"github.com/jmoiron/sqlx"
	_ "github.com/lib/pq"
	"github.com/shopspring/decimal"
)

func init() {
	logger := slog.New(slog.NewTextHandler(os.Stderr, nil))
	slog.SetDefault(logger)
}

func main() {
	db, err := sqlx.Connect("postgres", os.Getenv("DATABASE_URL"))
	if err != nil {
		log.Fatalln(err)
	}

	config, err := loadConfig(db)
	if err != nil {
		log.Fatalln(err)
	}
	_ = config

	bankTxs, err := loadBankTxs(db)
	if err != nil {
		log.Fatalln(err)
	}
	log.Println("preparedBankTxs:", len(bankTxs))

	// // get first day of last month
	// year, month, _ := time.Now().Date()
	// startDate := time.Date(year, month-1, 1, 0, 0, 0, 0, time.UTC)

	// slog.Info(fmt.Sprintf("found %d bank txs", len(bankTxs)))
	// fmt.Println("first:", bankTxs[0])
	// fmt.Println("date:", bankTxs[0].Date.Format(time.DateOnly))
	// fmt.Println("startDate:", startDate)

	// // slog.Info(fmt.Sprintf("hello world. dburl = %s", dbUrl))
	// // slog.Error("some error")
	fmt.Println("bye")
}

type PreparedBankTx struct {
	PreparedKey string
	Date        string
	Description string
	Amount      decimal.Decimal
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

func loadBankTxs(db *sqlx.DB) ([]PreparedBankTx, error) {
	bankTxs := []types.BankTx{}
	sql := `
		select *
		from bank_txs
		where month = $1
		order by
			date asc, doc_no asc`
	err := db.Select(&bankTxs, sql, time.Now().Format("2006-01"))
	if err != nil {
		return nil, err
	}

	groups := map[string][]PreparedBankTx{}
	for _, bankTx := range bankTxs {
		preparedKey := fmt.Sprintf("%s_%s", bankTx.Date.Format("20060102"), bankTx.DocNo)
		slice, ok := groups[preparedKey]
		if !ok {
			slice = []PreparedBankTx{}
		}
		slice = append(slice, PreparedBankTx{
			PreparedKey: preparedKey,
			Date:        bankTx.Date.Format(time.DateOnly),
			Description: bankTx.Description,
			Amount:      bankTx.Amount,
		})
		groups[preparedKey] = slice
	}

	flattened := []PreparedBankTx{}
	for preparedKey, group := range groups {
		if len(group) > 1 {
			// need to handle this soon. particularly deciding on the description to use
			return nil, fmt.Errorf("preparedKey %s has more than one item", preparedKey)
		}
		flattened = append(flattened, group[0])
	}

	return flattened, nil
}
