package types

import "time"

type PreparedBankTx struct {
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
	Transactions      []PreparedBankTx
	TransactionsByKey map[string][]PreparedBankTx
}
