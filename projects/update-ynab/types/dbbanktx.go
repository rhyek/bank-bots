package types

import (
	"time"

	"github.com/shopspring/decimal"
)

type DbBankTx struct {
	Id            string
	BankKey       string `db:"bank_key"`
	AccountNumber string `db:"account_number"`
	Month         string
	Date          time.Time
	DocNo         string `db:"doc_no"`
	Description   string
	Amount        decimal.Decimal
	Currency      string    `db:"currency"`
	CreatedAt     time.Time `db:"created_at"`
}
