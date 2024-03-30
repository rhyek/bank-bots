package types

import (
	"time"

	"github.com/shopspring/decimal"
)

type BankTx struct {
	Id            string
	BankKey       string `db:"bank_key"`
	AccountNumber string `db:"account_number"`
	Month         string
	Date          time.Time
	DocNo         string `db:"doc_no"`
	Description   string
	Amount        decimal.Decimal
	CreatedAt     time.Time `db:"created_at"`
}
