package banks

import (
	"bank-bots/update-ynab/types"
	"fmt"
	"log/slog"
	"slices"
	"time"

	"github.com/jmoiron/sqlx"
	"github.com/shopspring/decimal"
)

func LoadBankTxs(db *sqlx.DB) ([]types.BankAccountWithTransactions, error) {
	var fromMonth time.Time
	if time.Now().Day() <= 10 {
		year, month, day := time.Now().Date()
		fromMonth = time.Date(year, month-1, day, 0, 0, 0, 0, time.UTC)
	} else {
		fromMonth = time.Now()
	}

	slog.Info("loading bank txs", slog.String("fromMonth", fromMonth.Format("2006-01")))

	bankTxs := []types.DbBankTx{}
	sql := `
		select *
		from bank_txs
		where month >= $1
		order by bank_key asc, account_number asc, date asc, doc_no asc`
	err := db.Select(&bankTxs, sql, fromMonth.Format("2006-01"))
	if err != nil {
		return nil, err
	}

	bankAccountsWithTxs := map[string]*types.BankAccountWithTransactions{}
	for _, bankTx := range bankTxs {
		bankAccountKey := fmt.Sprintf("%s_%s", bankTx.BankKey, bankTx.AccountNumber)
		bankAccount, ok := bankAccountsWithTxs[bankAccountKey]
		if !ok {
			bankAccount = &types.BankAccountWithTransactions{
				BankKey: bankTx.BankKey,
				Account: struct{ Number string }{
					Number: bankTx.AccountNumber,
				},
			}
			bankAccountsWithTxs[bankAccountKey] = bankAccount
		}
		ref := fmt.Sprintf("%s_%s", bankTx.Date.Format("20060102"), bankTx.DocNo)
		sameRefCount := 0
		for _, iterTx := range bankAccount.Transactions {
			iterRef := fmt.Sprintf("%s_%s", iterTx.Date.Format("20060102"), iterTx.DocNo)
			if bankTx.Id != iterTx.BankTx.Id && ref == iterRef {
				sameRefCount += 1
			}
		}
		if sameRefCount > 0 {
			ref = fmt.Sprintf("%s(%d)", ref, sameRefCount+1)
			slog.Info("found duplicate doc no", "docno", bankTx.DocNo, "new ref", ref)
		}
		bankAccount.Transactions = append(bankAccount.Transactions, types.PreparedBankTx{
			BankTx:      bankTx,
			Ref:         ref,
			Date:        bankTx.Date,
			DocNo:       bankTx.DocNo,
			Description: bankTx.Description,
			Amount:      bankTx.Amount.Mul(decimal.NewFromInt(1_000)).IntPart(),
		})
		slog.Info("tx size", "s", len(bankAccount.Transactions))
	}

	bankAccounts := []types.BankAccountWithTransactions{}
	for _, bankAccount := range bankAccountsWithTxs {
		slices.SortFunc(bankAccount.Transactions, func(a, b types.PreparedBankTx) int {
			return a.Date.Compare(b.Date)
		})
		bankAccounts = append(bankAccounts, *bankAccount)
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
