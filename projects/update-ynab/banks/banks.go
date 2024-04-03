package banks

import (
	"fmt"
	"log/slog"
	"slices"
	"time"

	"bank-bots/update-ynab/types"

	"github.com/jmoiron/sqlx"
	"github.com/shopspring/decimal"
)

type dbBankTx struct {
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

func LoadBankTxs(db *sqlx.DB) ([]types.BankAccountWithTransactions, error) {
	var fromMonth time.Time
	if time.Now().Day() <= 5 {
		year, month, day := time.Now().Date()
		fromMonth = time.Date(year, month-1, day, 0, 0, 0, 0, time.UTC)
	} else {
		fromMonth = time.Now()
	}

	slog.Info("loading bank txs", slog.String("fromMonth", fromMonth.Format("2006-01")))

	bankTxs := []dbBankTx{}
	sql := `
		select *
		from bank_txs
		where month >= $1
		order by bank_key asc, account_number asc, date asc, doc_no asc`
	err := db.Select(&bankTxs, sql, fromMonth.Format("2006-01"))
	if err != nil {
		return nil, err
	}

	bankAccountsWithTxs := map[string]types.BankAccountWithTransactions{}
	for _, bankTx := range bankTxs {
		bankAccountKey := fmt.Sprintf("%s_%s", bankTx.BankKey, bankTx.AccountNumber)
		bankAccount, ok := bankAccountsWithTxs[bankAccountKey]
		if !ok {
			bankAccount = types.BankAccountWithTransactions{
				BankKey: bankTx.BankKey,
				Account: struct{ Number string }{
					Number: bankTx.AccountNumber,
				},
				TransactionsByKey: map[string][]types.PreparedBankTx{},
			}
			bankAccountsWithTxs[bankAccountKey] = bankAccount
		}

		ref := fmt.Sprintf("%s_%s", bankTx.Date.Format("20060102"), bankTx.DocNo)
		slice, ok := bankAccount.TransactionsByKey[ref]
		if !ok {
			slice = []types.PreparedBankTx{}

		}
		slice = append(slice, types.PreparedBankTx{
			Ref:         ref,
			Date:        bankTx.Date,
			DocNo:       bankTx.DocNo,
			Description: bankTx.Description,
			Amount:      bankTx.Amount.Mul(decimal.NewFromInt(1_000)).IntPart(),
		})
		bankAccount.TransactionsByKey[ref] = slice
	}

	bankAccounts := []types.BankAccountWithTransactions{}
	for _, bankAccount := range bankAccountsWithTxs {
		for txKey, slice := range bankAccount.TransactionsByKey {
			if len(slice) > 1 {
				// need to handle this soon. particularly deciding on the description to use
				return nil, fmt.Errorf("preparedKey %s has more than one item", txKey)
			} else {
				bankAccount.Transactions = append(bankAccount.Transactions, slice[0])
			}
		}
		slices.SortFunc(bankAccount.Transactions, func(a, b types.PreparedBankTx) int {
			return a.Date.Compare(b.Date)
		})
		bankAccounts = append(bankAccounts, bankAccount)
	}

	slog.Info("printing found bank txs:")
	for _, bankAccount := range bankAccounts {
		for _, bankTx := range bankAccount.Transactions {
			slog.Info(fmt.Sprintf("account: %s, date: %s, doc_no: %s, amount: %d", bankAccount.Account.Number,
				bankTx.Date.Format("2006-01-02"), bankTx.DocNo, bankTx.Amount))
		}
	}

	return bankAccounts, nil
}
