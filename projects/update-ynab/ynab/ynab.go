package ynab

import (
	"fmt"
	"log/slog"
	"regexp"
	"slices"
	"time"

	"bank-bots/update-ynab/types"
)

type AugmentedYnabTransaction struct {
	Tx         *Transaction
	ParsedMemo *ParsedYnabTransactionMemo
}

func UpdateYnabWithBankTxs(
	config *types.Config,
	bankAccountsWithTxs []types.BankAccountWithTransactions,
	fromMonth time.Time,
) error {
	client := NewClient(config.YNAB.AccessToken)

	ynabTxCreates := []map[string]any{}
	ynabTxUpdates := []map[string]any{}
	ynabTxDeletes := []string{}

	for _, bankAccount := range bankAccountsWithTxs {
		if len(bankAccount.Transactions) == 0 {
			continue
		}

		idx := slices.IndexFunc(config.YNAB.AccountsMap, func(e types.AccountMap) bool {
			return e.BankKey == bankAccount.BankKey &&
				e.BankAccountNumber == bankAccount.Account.Number
		})
		if idx == -1 {
			return fmt.Errorf(
				"ynab account id not found for bank key %s, account number %s",
				bankAccount.BankKey,
				bankAccount.Account.Number,
			)
		}
		ynabAccountId := config.YNAB.AccountsMap[idx].YNABAccountID

		year, month, _ := bankAccount.Transactions[0].Date.Date()
		sinceDate := time.Date(year, month-2, 1, 0, 0, 0, 0, time.UTC)
		slog.Info(
			"getting transactions",
			"since",
			sinceDate,
			"budget id",
			config.YNAB.BudgetID,
			"account id",
			ynabAccountId,
		)

		_ynabTxs, err := client.GetAccountTransactions(
			config.YNAB.BudgetID,
			ynabAccountId,
			sinceDate,
		)
		if err != nil {
			return fmt.Errorf("error getting transactions: %w", err)
		}

		ynabTxs := []AugmentedYnabTransaction{}
		for i, ynabTx := range _ynabTxs {
			if ynabTx.Memo == nil {
				continue
			}
			parsedMemo, err := ParseYnabTransactionMemo(ynabTx.Memo)
			if err != nil {
				return err
			}
			ynabTxs = append(ynabTxs, AugmentedYnabTransaction{
				Tx:         &_ynabTxs[i],
				ParsedMemo: &parsedMemo,
			})
		}

		// upserts
		for _, bankTx := range bankAccount.Transactions {
			if bankTx.DocNo == "112900248" {
				slog.Info("checking upsert for bank tx", "tx", bankTx)
			}
			idx := slices.IndexFunc(ynabTxs, func(ynabTx AugmentedYnabTransaction) bool {
				return ynabTx.ParsedMemo.Ref == bankTx.Ref || ynabTx.ParsedMemo.Ref == bankTx.DocNo
			})
			if idx == -1 {
				year, month, date := bankTx.Date.Date()
				d := time.Date(year, month, date, 0, 0, 0, 0, time.UTC)
				memo := fmt.Sprintf("ref: %s; desc: %s;", bankTx.Ref, bankTx.Description)
				ynabTxCreates = append(ynabTxCreates, map[string]any{
					"account_id": ynabAccountId,
					"date":       d.Format("2006-01-02"),
					"amount":     bankTx.Amount,
					"memo":       &memo,
					"cleared":    "cleared",
				})
			} else {
				ynabTx := ynabTxs[idx]
				if ynabTx.Tx.Approved || ynabTx.Tx.Cleared != "uncleared" {
					continue
				}
				if ynabTx.Tx.Amount != bankTx.Amount {
					slog.Info(fmt.Sprintf("updating transaction with ref %s. amount before %v, after %v", ynabTx.ParsedMemo.Ref, ynabTx.Tx.Amount, bankTx.Amount))
					ynabTxUpdates = append(ynabTxUpdates, map[string]any{
						"id":      ynabTx.Tx.ID,
						"amount":  bankTx.Amount,
						"cleared": "cleared",
					})
				}
			}
		}
		// deletes
		rgx := regexp.MustCompile(`\d{8,}_\d+(\(\d+\))?$`)
		for _, ynabTx := range ynabTxs {
			ynabTxDate, err := time.Parse("2006-01-02", ynabTx.Tx.Date)
			if err != nil {
				return fmt.Errorf("error parsing transaction date (%s): %w", ynabTx.Tx.Date, err)
			}
			fromMonthMonth := fromMonth.Format("2006-01")
			ynabTxDateMonth := ynabTxDate.Format("2006-01")
			if ynabTxDateMonth < fromMonthMonth {
				continue
			}
			if !rgx.MatchString(ynabTx.ParsedMemo.Ref) {
				continue
			}
			idx := slices.IndexFunc(
				bankAccount.Transactions,
				func(bankTx types.PreparedBankTx) bool {
					return ynabTx.ParsedMemo.Ref == bankTx.Ref ||
						ynabTx.ParsedMemo.Ref == bankTx.DocNo
				},
			)
			if idx == -1 {
				slog.Warn(
					"marking transaction for deletion",
					"ref",
					ynabTx.ParsedMemo.Ref,
				)
				ynabTxDeletes = append(ynabTxDeletes, ynabTx.Tx.ID)
			}
		}
	}

	slog.Info(fmt.Sprintf("creating %v transactions", len(ynabTxCreates)))
	if len(ynabTxCreates) > 0 {
		err := client.CreateMultipleTransactions(
			config.YNAB.BudgetID,
			ynabTxCreates,
		)
		if err != nil {
			return err
		}
	}
	slog.Info(fmt.Sprintf("updating %v transactions", len(ynabTxUpdates)))
	if len(ynabTxUpdates) > 0 {
		err := client.UpdateMultipleTransactions(
			config.YNAB.BudgetID,
			ynabTxUpdates,
		)
		if err != nil {
			return err
		}
	}
	slog.Info(fmt.Sprintf("deleting %v transactions", len(ynabTxDeletes)))
	if len(ynabTxDeletes) > 0 {
		var transactions []map[string]any
		for _, txId := range ynabTxDeletes {
			transactions = append(transactions, map[string]any{
				"id":         txId,
				"flag_color": "red",
			})
		}
		err := client.UpdateMultipleTransactions(
			config.YNAB.BudgetID,
			transactions,
		)
		if err != nil {
			return err
		}
	}

	return nil
}

func UpdateEmptyPayees(config *types.Config) error {
	client := NewClient(config.YNAB.AccessToken)

	transactions := []map[string]any{}

	now := time.Now()
	sinceDate := time.Date(now.Year(), now.Month()-2, 1, 0, 0, 0, 0, time.UTC)

	for _, account := range config.YNAB.AccountsMap {
		ynabAccountId := account.YNABAccountID
		ynabTxs, err := client.GetAccountTransactions(
			config.YNAB.BudgetID,
			ynabAccountId,
			sinceDate,
		)
		if err != nil {
			return err
		}
		sourceTxs := make([]Transaction, len(ynabTxs))
		copy(sourceTxs, ynabTxs)
		slices.SortFunc(sourceTxs, func(a, b Transaction) int {
			if b.Date > a.Date {
				return 1
			} else if b.Date < a.Date {
				return -1
			}
			return 0
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
					slog.Info(
						"updating payee",
						"tx id",
						ynabTx.ID,
						"payee id",
						*sourceTx.PayeeID,
						"category id",
						*sourceTx.CategoryID,
					)
					transactions = append(transactions, map[string]any{
						"id":          ynabTx.ID,
						"payee_id":    *sourceTx.PayeeID,
						"category_id": *sourceTx.CategoryID,
					})
					break
				}
			}
		}
	}

	slog.Info(fmt.Sprintf("updating %v transactions with payees", len(transactions)))
	err := client.UpdateMultipleTransactions(
		config.YNAB.BudgetID,
		transactions,
	)
	if err != nil {
		return err
	}
	return nil
}
