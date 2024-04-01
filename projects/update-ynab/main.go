package main

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"slices"
	"time"

	"bank-bots/update-ynab/types"
	"bank-bots/update-ynab/utils"

	"github.com/brunomvsouza/ynab.go"
	"github.com/brunomvsouza/ynab.go/api"
	"github.com/brunomvsouza/ynab.go/api/transaction"
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
		logFatal(err)
	}

	config, err := loadConfig(db)
	if err != nil {
		logFatal(err)
	}

	bankAccountsWithTxs, err := loadBankTxs(db)
	if err != nil {
		logFatal(err)
	}

	err = updateYnabTxs(config, bankAccountsWithTxs)
	if err != nil {
		logFatal(err)
	}

	slog.Info("done")
}

func logFatal(err error) {
	slog.Error(err.Error())
	os.Exit(1)
}

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

func loadBankTxs(db *sqlx.DB) ([]BankAccountWithTransactions, error) {
	bankTxs := []types.BankTx{}
	sql := `
		select *
		from bank_txs
		where month = $1
		order by
			bank_key asc, account_number asc, date asc, doc_no asc`
	err := db.Select(&bankTxs, sql, time.Now().Format("2006-01"))
	if err != nil {
		return nil, err
	}

	bankAccountsWithTxs := map[string]BankAccountWithTransactions{}
	for _, bankTx := range bankTxs {
		bankAccountKey := fmt.Sprintf("%s_%s", bankTx.BankKey, bankTx.AccountNumber)
		bankAccount, ok := bankAccountsWithTxs[bankAccountKey]
		if !ok {
			bankAccount = BankAccountWithTransactions{
				BankKey: bankTx.BankKey,
				Account: struct{ Number string }{
					Number: bankTx.AccountNumber,
				},
				TransactionsByKey: map[string][]PreparedBankTx{},
			}
			bankAccountsWithTxs[bankAccountKey] = bankAccount
		}

		ref := fmt.Sprintf("%s_%s", bankTx.Date.Format("20060102"), bankTx.DocNo)
		slice, ok := bankAccount.TransactionsByKey[ref]
		if !ok {
			slice = []PreparedBankTx{}

		}
		slice = append(slice, PreparedBankTx{
			Ref:         ref,
			Date:        bankTx.Date,
			DocNo:       bankTx.DocNo,
			Description: bankTx.Description,
			Amount:      bankTx.Amount.Mul(decimal.NewFromInt(1_000)).IntPart(),
		})
		bankAccount.TransactionsByKey[ref] = slice
	}

	bankAccounts := []BankAccountWithTransactions{}
	for _, bankAccount := range bankAccountsWithTxs {
		for txKey, slice := range bankAccount.TransactionsByKey {
			if len(slice) > 1 {
				// need to handle this soon. particularly deciding on the description to use
				return nil, fmt.Errorf("preparedKey %s has more than one item", txKey)
			} else {
				bankAccount.Transactions = append(bankAccount.Transactions, slice[0])
			}
		}
		bankAccounts = append(bankAccounts, bankAccount)
	}

	return bankAccounts, nil
}

type AugmentedYnabTransaction struct {
	Tx  *transaction.Transaction
	Ref string
}

func updateYnabTxs(config types.Config, bankAccountsWithTxs []BankAccountWithTransactions) error {
	client := ynab.NewClient(config.YNAB.AccessToken)

	for _, bankAccount := range bankAccountsWithTxs {
		if len(bankAccount.Transactions) == 0 {
			continue
		}

		idx := slices.IndexFunc(config.YNAB.AccountsMap, func(e types.AccountMap) bool {
			return e.BankKey == bankAccount.BankKey && e.BankAccountNumber == bankAccount.Account.Number
		})
		if idx == -1 {
			return fmt.Errorf("ynab account id not found for bank key %s, account number %s", bankAccount.BankKey, bankAccount.Account.Number)
		}
		ynabAccountId := config.YNAB.AccountsMap[idx].YNABAccountID

		year, month, _ := bankAccount.Transactions[0].Date.Date()
		sinceDate := time.Date(year, month-2, 1, 0, 0, 0, 0, time.UTC)

		_ynabTxs, err := client.Transaction().GetTransactionsByAccount(
			config.YNAB.BudgetID, ynabAccountId, &transaction.Filter{
				Since: &api.Date{
					Time: sinceDate,
				},
			},
		)
		if err != nil {
			return err
		}

		ynabTxs := []AugmentedYnabTransaction{}
		for _, ynabTx := range _ynabTxs {
			parsedMemo, err := utils.ParseYnabTransactionMemo(ynabTx.Memo)
			if err != nil {
				return err
			}
			ynabTxs = append(ynabTxs, AugmentedYnabTransaction{
				Tx:  ynabTx,
				Ref: parsedMemo.Ref,
			})
		}

		ynabTxCreates := []transaction.PayloadTransaction{}
		ynabTxUpdates := []transaction.PayloadTransaction{}

		for _, bankTx := range bankAccount.Transactions {
			idx := slices.IndexFunc(ynabTxs, func(e AugmentedYnabTransaction) bool {
				return e.Ref == bankTx.Ref || e.Ref == bankTx.DocNo
			})
			if idx == -1 {
				slog.Info(fmt.Sprintf("creating transaction: %+v", bankTx))
				year, month, date := bankTx.Date.Date()
				d := time.Date(year, month, date, 0, 0, 0, 0, time.UTC)
				memo := fmt.Sprintf("ref: %s; desc: %s;", bankTx.Ref, bankTx.Description)
				ynabTxCreates = append(ynabTxCreates, transaction.PayloadTransaction{
					AccountID: ynabAccountId,
					Date: api.Date{
						Time: d,
					},
					Amount:  bankTx.Amount,
					Memo:    &memo,
					Cleared: transaction.ClearingStatusCleared,
				})
			} else {
				ynabTx := ynabTxs[idx]
				if ynabTx.Tx.Approved || ynabTx.Tx.Cleared != transaction.ClearingStatusUncleared {
					continue
				}
				if ynabTx.Tx.Amount != bankTx.Amount {
					slog.Info(fmt.Sprintf("updating transaction with ref %s. amount before %v, after %v", ynabTx.Ref, ynabTx.Tx.Amount, bankTx.Amount))
					ynabTxUpdates = append(ynabTxUpdates, transaction.PayloadTransaction{
						ID:      ynabTx.Tx.ID,
						Amount:  bankTx.Amount,
						Cleared: transaction.ClearingStatusCleared,
					})
				}
			}
		}

		slog.Info(fmt.Sprintf("creating %v transactions", len(ynabTxCreates)))
		if len(ynabTxCreates) > 0 {
			_, err := client.Transaction().CreateTransactions(
				config.YNAB.BudgetID,
				ynabTxCreates,
			)
			if err != nil {
				return err
			}
		}
		slog.Info(fmt.Sprintf("updating %v transactions", len(ynabTxUpdates)))
		if len(ynabTxUpdates) > 0 {
			_, err := client.Transaction().UpdateTransactions(
				config.YNAB.BudgetID,
				ynabTxUpdates,
			)
			if err != nil {
				return err
			}
		}
	}

	return nil
}
