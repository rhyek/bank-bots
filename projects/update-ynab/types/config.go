package types

type Account struct {
	Type   string `json:"type"`
	Number string `json:"number"`
}

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
	Banks struct {
		BancoIndustrialGt struct {
			Auth struct {
				Code     string `json:"code"`
				Password string `json:"password"`
				Username string `json:"username"`
			} `json:"auth"`
			Accounts []Account `json:"accounts"`
		} `json:"bancoIndustrialGt"`
	} `json:"banks"`
}
