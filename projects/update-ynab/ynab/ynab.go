package ynab

import (
	"fmt"
	"log/slog"
	"slices"
	"time"

	"bank-bots/update-ynab/types"

	"github.com/brunomvsouza/ynab.go"
	"github.com/brunomvsouza/ynab.go/api"
	"github.com/brunomvsouza/ynab.go/api/transaction"
)

type AugmentedYnabTransaction struct {
	Tx         *transaction.Transaction
	ParsedMemo *ParsedYnabTransactionMemo
}

func UpdateYnabTxs(config types.Config, bankAccountsWithTxs []types.BankAccountWithTransactions) error {
	client := ynab.NewClient(config.YNAB.AccessToken)

	ynabTxCreates := []transaction.PayloadTransaction{}
	ynabTxUpdates := []transaction.PayloadTransaction{}

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
			parsedMemo, err := ParseYnabTransactionMemo(ynabTx.Memo)
			if err != nil {
				return err
			}
			ynabTxs = append(ynabTxs, AugmentedYnabTransaction{
				Tx:         ynabTx,
				ParsedMemo: &parsedMemo,
			})
		}

		for _, bankTx := range bankAccount.Transactions {
			idx := slices.IndexFunc(ynabTxs, func(e AugmentedYnabTransaction) bool {
				return e.ParsedMemo.Ref == bankTx.Ref || e.ParsedMemo.Ref == bankTx.DocNo
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
					slog.Info(fmt.Sprintf("updating transaction with ref %s. amount before %v, after %v", ynabTx.ParsedMemo.Ref, ynabTx.Tx.Amount, bankTx.Amount))
					ynabTxUpdates = append(ynabTxUpdates, transaction.PayloadTransaction{
						ID:      ynabTx.Tx.ID,
						Amount:  bankTx.Amount,
						Cleared: transaction.ClearingStatusCleared,
					})
				}
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

	return nil
}
