package ynab

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"regexp"
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

func UpdateYnabWithBankTxs(config *types.Config, bankAccountsWithTxs []types.BankAccountWithTransactions, fromMonth time.Time) error {
	client := ynab.NewClient(config.YNAB.AccessToken)

	ynabTxCreates := []transaction.PayloadTransaction{}
	ynabTxUpdates := []transaction.PayloadTransaction{}

	type DeleteTransaction struct {
		Id        string                `json:"id"`
		FlagColor transaction.FlagColor `json:"flag_color"`
	}
	type DeleteTransactionsPayload struct {
		Transactions []DeleteTransaction `json:"transactions"`
	}
	ynabTxDeletes := []DeleteTransaction{}

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
			if ynabTx.Memo == nil {
				continue
			}
			parsedMemo, err := ParseYnabTransactionMemo(ynabTx.Memo)
			if err != nil {
				return err
			}
			ynabTxs = append(ynabTxs, AugmentedYnabTransaction{
				Tx:         ynabTx,
				ParsedMemo: &parsedMemo,
			})
		}

		// upserts
		for _, bankTx := range bankAccount.Transactions {
			idx := slices.IndexFunc(ynabTxs, func(ynabTx AugmentedYnabTransaction) bool {
				return ynabTx.ParsedMemo.Ref == bankTx.Ref || ynabTx.ParsedMemo.Ref == bankTx.DocNo
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
		// deletes
		rgx := regexp.MustCompile(`\d{8,}_\d+(\(\d+\))?$`)
		isSameOrFutureMonth := func(fromMonth, t time.Time) bool {
			fromYear, fromMonthNum, _ := fromMonth.Date()
			tYear, tMonthNum, _ := t.Date()

			if tYear > fromYear {
				return true
			} else if tYear == fromYear && tMonthNum >= fromMonthNum {
				return true
			}
			return false
		}
		for _, ynabTx := range ynabTxs {
			if !isSameOrFutureMonth(fromMonth, ynabTx.Tx.Date.Time) {
				continue
			}
			if !rgx.MatchString(ynabTx.ParsedMemo.Ref) {
				continue
			}
			idx := slices.IndexFunc(bankAccount.Transactions, func(bankTx types.PreparedBankTx) bool {
				return ynabTx.ParsedMemo.Ref == bankTx.Ref || ynabTx.ParsedMemo.Ref == bankTx.DocNo
			})
			if idx == -1 {
				slog.Warn(fmt.Sprintf("marking transaction for deletion: %+v", ynabTx.Tx), "ref", ynabTx.ParsedMemo.Ref)
				ynabTxDeletes = append(ynabTxDeletes, DeleteTransaction{
					Id:        ynabTx.Tx.ID,
					FlagColor: transaction.FlagColorRed,
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
	slog.Info(fmt.Sprintf("deleting %v transactions", len(ynabTxDeletes)))
	if len(ynabTxDeletes) > 0 {
		payload := DeleteTransactionsPayload{
			Transactions: ynabTxDeletes,
		}
		jsonStr, err := json.Marshal(payload)
		if err != nil {
			return err
		}
		req, err := http.NewRequest(
			"PATCH",
			fmt.Sprintf("https://api.ynab.com/v1/budgets/%s/transactions", config.YNAB.BudgetID),
			bytes.NewBuffer(jsonStr))
		if err != nil {
			return err
		}
		req.Header.Add("Authorization", fmt.Sprintf("Bearer %s", config.YNAB.AccessToken))
		req.Header.Add("Content-Type", "application/json")
		httpClient := &http.Client{}
		res, err := httpClient.Do(req)
		if err != nil {
			return err
		}
		defer res.Body.Close()
	}

	return nil
}

func UpdateEmptyPayees(config *types.Config) error {
	ynabClient := ynab.NewClient(config.YNAB.AccessToken)

	type Transaction struct {
		Id         string `json:"id"`
		PayeeId    string `json:"payee_id"`
		CategoryId string `json:"category_id"`
	}
	type UpdateTransactionsPayload struct {
		Transactions []Transaction `json:"transactions"`
	}

	transactions := []Transaction{}

	now := time.Now()
	sinceDate := time.Date(now.Year(), now.Month()-2, 1, 0, 0, 0, 0, time.UTC)

	for _, account := range config.YNAB.AccountsMap {
		ynabAccountId := account.YNABAccountID
		ynabTxs, err := ynabClient.Transaction().GetTransactionsByAccount(
			config.YNAB.BudgetID, ynabAccountId, &transaction.Filter{
				Since: &api.Date{
					Time: sinceDate,
				},
			},
		)
		if err != nil {
			return err
		}
		sourceTxs := make([]*transaction.Transaction, len(ynabTxs))
		copy(sourceTxs, ynabTxs)
		slices.SortFunc(sourceTxs, func(a, b *transaction.Transaction) int {
			return b.Date.Time.Compare(a.Date.Time)
		})
		for _, ynabTx := range ynabTxs {
			if ynabTx.PayeeID != nil {
				continue
			}
			if ynabTx.Memo == nil {
				continue
			}
			parsedMemo, err := ParseYnabTransactionMemo(ynabTx.Memo)
			if err != nil {
				continue
			}
			for _, sourceTx := range sourceTxs {
				if sourceTx.Memo == nil {
					continue
				}
				iterParsedMemo, err := ParseYnabTransactionMemo(sourceTx.Memo)
				if err != nil {
					continue
				}
				if parsedMemo.Desc == iterParsedMemo.Desc &&
					sourceTx.PayeeID != nil &&
					sourceTx.CategoryID != nil {
					slog.Info("updating payee", "tx id", ynabTx.ID, "payee id", *sourceTx.PayeeID, "category id", *sourceTx.CategoryID)
					transactions = append(transactions, Transaction{
						Id: ynabTx.ID,

						PayeeId:    *sourceTx.PayeeID,
						CategoryId: *sourceTx.CategoryID,
					})
					break
				}
			}
		}
	}

	slog.Info(fmt.Sprintf("updating %v transactions with payees", len(transactions)))
	if len(transactions) > 0 {
		// the following is buggy. all unspecified fields are sent with "null" value instead of undefined
		// _, err := client.Transaction().UpdateTransactions(
		// 	config.YNAB.BudgetID,
		// 	ynabTxUpdates,
		// )
		// if err != nil {
		// 	return err
		// }
		payload := UpdateTransactionsPayload{
			Transactions: transactions,
		}
		jsonStr, err := json.Marshal(payload)
		if err != nil {
			return err
		}
		req, err := http.NewRequest(
			"PATCH",
			fmt.Sprintf("https://api.ynab.com/v1/budgets/%s/transactions", config.YNAB.BudgetID),
			bytes.NewBuffer(jsonStr))
		if err != nil {
			return err
		}
		req.Header.Add("Authorization", fmt.Sprintf("Bearer %s", config.YNAB.AccessToken))
		req.Header.Add("Content-Type", "application/json")
		httpClient := &http.Client{}
		res, err := httpClient.Do(req)
		if err != nil {
			return err
		}
		defer res.Body.Close()
	}
	return nil
}
