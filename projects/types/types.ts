export enum AccountType {
  Checking = 'checking',
  Savings = 'savings',
}

export enum TransactionType {
  Debit = 'debit',
  Credit = 'credit',
}

export type BankTransaction = {
  year: number;
  month: number;
  date: number;
  ref: string;
  docNo: string;
  description: string;
  type: TransactionType;
  amount: number;
};

export type BankAccountWithTransactions = {
  account: {
    number: string;
    type: AccountType;
  };
  transactions: BankTransaction[];
};
