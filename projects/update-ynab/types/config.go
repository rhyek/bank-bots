package types

type AccountMap struct {
	YNABAccountID     string `json:"ynabAccountId"`
	BankKey           string `json:"bankKey"`
	BankAccountNumber string `json:"bankAccountNumber"`
}

type Config struct {
	YNAB struct {
		BudgetID    string       `json:"budgetId"`
		AccessToken string       `json:"accessToken"`
		AccountsMap []AccountMap `json:"accountsMap"`
	} `json:"ynab"`
}
