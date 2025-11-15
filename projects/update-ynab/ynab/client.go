package ynab

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"time"
)

type DefaultHeadersTransport struct {
	AccessToken string
	T           http.RoundTripper
}

func (adt *DefaultHeadersTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	req.Header.Add("Authorization", fmt.Sprintf("Bearer %s", adt.AccessToken))
	req.Header.Add("Content-Type", "application/json")
	return adt.T.RoundTrip(req)
}

type Client struct {
	accessToken string
	httpClient  *http.Client
}

func NewClient(accessToken string) *Client {
	httpClient := &http.Client{
		Transport: &DefaultHeadersTransport{
			AccessToken: accessToken,
			T:           http.DefaultTransport,
		},
	}
	return &Client{
		accessToken: accessToken,
		httpClient:  httpClient,
	}
}

func (c *Client) DoReq(method string, path string, payload map[string]any, out any) error {
	jsonStr, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	req, err := http.NewRequest(
		method,
		fmt.Sprintf("https://api.ynab.com/v1/%s", path),
		bytes.NewBuffer(jsonStr),
	)
	if err != nil {
		return err
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if out != nil {
		if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
			return err
		}
	}
	return nil
}

type Transaction struct {
	ID                      string  `json:"id"`
	Date                    string  `json:"date"`
	Amount                  int64   `json:"amount"`
	Memo                    *string `json:"memo"`
	Cleared                 string  `json:"cleared"`
	Approved                bool    `json:"approved"`
	FlagColor               *string `json:"flag_color"`
	FlagName                *string `json:"flag_name"`
	AccountID               string  `json:"account_id"`
	AccountName             string  `json:"account_name"`
	PayeeID                 *string `json:"payee_id"`
	PayeeName               string  `json:"payee_name"`
	CategoryID              *string `json:"category_id"`
	CategoryName            string  `json:"category_name"`
	TransferAccountID       *string `json:"transfer_account_id"`
	TransferTransactionID   *string `json:"transfer_transaction_id"`
	MatchedTransactionID    *string `json:"matched_transaction_id"`
	ImportID                *string `json:"import_id"`
	ImportPayeeName         *string `json:"import_payee_name"`
	ImportPayeeNameOriginal *string `json:"import_payee_name_original"`
	DebtTransactionType     *string `json:"debt_transaction_type"`
	Deleted                 bool    `json:"deleted"`
	Subtransactions         []any   `json:"subtransactions"`
}

func (c *Client) GetTransactions(
	budgetID string,
	since time.Time,
) ([]Transaction, error) {
	path := fmt.Sprintf("/budgets/%s/transactions", budgetID)
	payload := map[string]any{
		"since_date": since.Format("2006-01-02"),
	}
	var result struct {
		Data struct {
			Transactions    []Transaction `json:"transactions"`
			ServerKnowledge int           `json:"server_knowledge"`
		} `json:"data"`
	}
	if err := c.DoReq("GET", path, payload, &result); err != nil {
		return nil, err
	}
	return result.Data.Transactions, nil
}

func (c *Client) GetAccountTransactions(
	budgetID string,
	accountID string,
	since time.Time,
) ([]Transaction, error) {
	path := fmt.Sprintf("/budgets/%s/accounts/%s/transactions", budgetID, accountID)
	payload := map[string]any{
		"since_date": since.Format("2006-01-02"),
	}
	var result struct {
		Data struct {
			Transactions    []Transaction `json:"transactions"`
			ServerKnowledge int           `json:"server_knowledge"`
		} `json:"data"`
	}
	if err := c.DoReq("GET", path, payload, &result); err != nil {
		return nil, err
	}
	return result.Data.Transactions, nil
}

func (c *Client) CreateMultipleTransactions(
	budgetID string,
	transactions []map[string]any,
) error {
	if len(transactions) == 0 {
		return nil
	}
	for _, tx := range transactions {
		if memo, ok := tx["memo"].(*string); ok && memo != nil {
			slog.Info("creating transaction", "memo", *memo, "amount", tx["amount"])
			continue
		}
	}
	path := fmt.Sprintf("/budgets/%s/transactions", budgetID)
	payload := map[string]any{
		"transactions": transactions,
	}
	if err := c.DoReq("POST", path, payload, nil); err != nil {
		return err
	}
	return nil
}

func (c *Client) UpdateMultipleTransactions(
	budgetID string,
	transactions []map[string]any,
) error {
	if len(transactions) == 0 {
		return nil
	}
	for _, tx := range transactions {
		slog.Info("updating transaction", "tx", tx)
	}
	path := fmt.Sprintf("/budgets/%s/transactions", budgetID)
	payload := map[string]any{
		"transactions": transactions,
	}
	if err := c.DoReq("PATCH", path, payload, nil); err != nil {
		return err
	}
	return nil
}
