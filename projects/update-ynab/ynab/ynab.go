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

type TransactionWithExtra struct {
	tx         Transaction
	parsedMemo *ParsedYnabTransactionMemo
}

type Matcher func(tx TransactionWithExtra) bool

var matchers = []Matcher{
	func(tx TransactionWithExtra) bool {
		matched, _ := regexp.MatchString(`(?i)\bsan martin\b`, tx.parsedMemo.Desc)
		return matched
	},
	func(tx TransactionWithExtra) bool {
		matched, _ := regexp.MatchString(`(?i)\bcpx\b`, tx.parsedMemo.Desc)
		return matched
	},
	func(tx TransactionWithExtra) bool {
		matched, _ := regexp.MatchString(`(?i)\bspotify\b`, tx.parsedMemo.Desc)
		return matched
	},
	func(tx TransactionWithExtra) bool {
		matched, _ := regexp.MatchString(`(?i)\bSEGUROS EL_A\b`, tx.parsedMemo.Desc)
		return matched
	},
	func(tx TransactionWithExtra) bool {
		matched, _ := regexp.MatchString(`(?i)\bvolaris\b`, tx.parsedMemo.Desc)
		return matched
	},
	func(tx TransactionWithExtra) bool {
		matched, _ := regexp.MatchString(
			`(?i)\bfarmacia galeno\b`,
			tx.parsedMemo.Desc,
		)
		return matched
	},
	func(tx TransactionWithExtra) bool {
		matched, _ := regexp.MatchString(
			`(?i)\bamazon(\.com|\sMKTPL)\b`,
			tx.parsedMemo.Desc,
		)
		return matched
	},
	func(tx TransactionWithExtra) bool {
		matched, _ := regexp.MatchString(
			`(?i)\bstarbucks\b`,
			tx.parsedMemo.Desc,
		)
		return matched
	},
	func(tx TransactionWithExtra) bool {
		matched, _ := regexp.MatchString(
			`(?i)\bI/T-\d+ I000\d+\b`,
			tx.parsedMemo.Desc,
		)
		return matched
	},
	func(tx TransactionWithExtra) bool {
		matched, _ := regexp.MatchString(
			`(?i)\bPAGO TARJETA\b`,
			tx.parsedMemo.Desc,
		)
		return matched
	},
	func(tx TransactionWithExtra) bool {
		matched, _ := regexp.MatchString(
			`(?i)\buber.+(trip|rides)\b`,
			tx.parsedMemo.Desc,
		)
		return matched
	},
	func(tx TransactionWithExtra) bool {
		matched, _ := regexp.MatchString(
			`(?i)\bmcdonalds\b`,
			tx.parsedMemo.Desc,
		)
		return matched
	},
	func(tx TransactionWithExtra) bool {
		matched, _ := regexp.MatchString(
			`(?i)\bpollo campero\b`,
			tx.parsedMemo.Desc,
		)
		return matched
	},
	func(tx TransactionWithExtra) bool {
		matched, _ := regexp.MatchString(
			`(?i)\bcafe barista\b`,
			tx.parsedMemo.Desc,
		)
		return matched
	},
	func(tx TransactionWithExtra) bool {
		matched, _ := regexp.MatchString(
			`(?i)\bcemaco\b`,
			tx.parsedMemo.Desc,
		)
		return matched
	},
}

func UpdateEmptyPayees(config *types.Config) error {
	client := NewClient(config.YNAB.AccessToken)

	transactions := []map[string]any{}

	now := time.Now()
	sinceDate := time.Date(now.Year(), now.Month()-3, 1, 0, 0, 0, 0, time.UTC)

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
		targetTxs := make([]TransactionWithExtra, len(ynabTxs))
		for _, tx := range ynabTxs {
			var parsedMemo *ParsedYnabTransactionMemo
			if tx.Memo != nil {
				_parsedMemo, err := ParseYnabTransactionMemo(tx.Memo)
				if err == nil {
					parsedMemo = &_parsedMemo
				}
			}
			targetTxs = append(targetTxs, TransactionWithExtra{
				tx:         tx,
				parsedMemo: parsedMemo,
			})
		}
		sourceTxs := []TransactionWithExtra{}
		for _, targetTx := range targetTxs {
			if targetTx.tx.PayeeID == nil || targetTx.tx.CategoryID == nil ||
				targetTx.parsedMemo == nil {
				continue
			}
			sourceTxs = append(sourceTxs, targetTx)
		}
		slices.SortFunc(sourceTxs, func(a, b TransactionWithExtra) int {
			if b.tx.Date > a.tx.Date {
				return 1
			} else if b.tx.Date < a.tx.Date {
				return -1
			}
			return 0
		})
		for _, targetTx := range targetTxs {
			if targetTx.tx.PayeeID != nil {
				continue
			}
			if targetTx.parsedMemo == nil {
				continue
			}
			// find with equal description
			foundIndex := slices.IndexFunc(sourceTxs, func(sourceTx TransactionWithExtra) bool {
				return targetTx.parsedMemo.Desc == sourceTx.parsedMemo.Desc
			})
			// find with similar description
			if foundIndex == -1 {
				for _, matcher := range matchers {
					if matcher(targetTx) {
						foundIndex = slices.IndexFunc(
							sourceTxs,
							func(sourceTx TransactionWithExtra) bool {
								return matcher(sourceTx)
							},
						)
					}
				}
			}

			if foundIndex > -1 {
				sourceTx := sourceTxs[foundIndex]
				slog.Info(
					"updating payee",
					"tx id",
					targetTx.tx.ID,
					"payee id",
					*sourceTx.tx.PayeeID,
					"category id",
					*sourceTx.tx.CategoryID,
				)
				transactions = append(transactions, map[string]any{
					"id":          targetTx.tx.ID,
					"payee_id":    *sourceTx.tx.PayeeID,
					"category_id": *sourceTx.tx.CategoryID,
				})
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
