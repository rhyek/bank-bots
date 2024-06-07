package types

import (
	"time"
)

type PreparedBankTx struct {
	BankTx      DbBankTx
	Ref         string
	Date        time.Time
	DocNo       string
	Description string
	Amount      int64
}

type BankAccountWithTransactions struct {
	BankKey string
	Account struct {
		Number string
	}
	Transactions []PreparedBankTx
}
