package types

type Account struct {
	Type   string `json:"type"`
	Number string `json:"number"`
}

type Config struct {
	YNAB struct {
		BudgetID    string `json:"budgetId"`
		AccessToken string `json:"accessToken"`
		AccountsMap []struct {
			YNABAccountID     string `json:"ynabAccountId"`
			BankKey           string `json:"bankKey"`
			BankAccountNumber string `json:"bankAccountNumber"`
		} `json:"accountsMap"`
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
