// Minimal read-only YNAB REST client (https://api.ynab.com/v1) used by the one-shot backfill that
// imports payees/categories + per-tx mappings into Postgres. Uses global fetch; no SDK.

export interface YnabTransaction {
  id: string;
  date: string; // YYYY-MM-DD
  amount: number; // milliunits (bank amount * 1000); negative = outflow
  memo: string | null;
  account_id: string;
  payee_id: string | null;
  payee_name: string | null;
  import_payee_name: string | null;
  category_id: string | null;
  transfer_account_id: string | null;
  deleted: boolean;
}

export interface YnabPayee {
  id: string;
  name: string;
  transfer_account_id: string | null;
  deleted: boolean;
}

export interface YnabCategory {
  id: string;
  category_group_id: string;
  name: string;
  hidden: boolean;
  deleted: boolean;
}

export interface YnabCategoryGroup {
  id: string;
  name: string;
  hidden: boolean;
  deleted: boolean;
  categories: YnabCategory[];
}

export class YnabClient {
  constructor(
    private readonly accessToken: string,
    private readonly budgetId: string,
  ) {}

  private async get<T>(path: string): Promise<T> {
    const res = await fetch(`https://api.ynab.com/v1${path}`, {
      headers: { Authorization: `Bearer ${this.accessToken}` },
    });
    if (!res.ok) {
      throw new Error(`YNAB GET ${path} -> ${res.status} ${res.statusText}: ${await res.text()}`);
    }
    const body = (await res.json()) as { data: T };
    return body.data;
  }

  async getPayees(): Promise<YnabPayee[]> {
    const data = await this.get<{ payees: YnabPayee[] }>(`/budgets/${this.budgetId}/payees`);
    return data.payees;
  }

  // Full history for one account (far-back since_date — see getTransactions).
  async getAccountTransactions(
    accountId: string,
    sinceDate = '2000-01-01',
  ): Promise<YnabTransaction[]> {
    const data = await this.get<{ transactions: YnabTransaction[] }>(
      `/budgets/${this.budgetId}/accounts/${accountId}/transactions?since_date=${sinceDate}`,
    );
    return data.transactions;
  }

  async getCategoryGroups(): Promise<YnabCategoryGroup[]> {
    const data = await this.get<{ category_groups: YnabCategoryGroup[] }>(
      `/budgets/${this.budgetId}/categories`,
    );
    return data.category_groups;
  }

  // NOTE: YNAB's transaction endpoints return only ~the last year when `since_date` is omitted, so
  // we pass a far-back date to fetch the FULL history. (Omitting it silently truncated the backfill.)
  async getTransactions(sinceDate = '2000-01-01'): Promise<YnabTransaction[]> {
    const data = await this.get<{ transactions: YnabTransaction[] }>(
      `/budgets/${this.budgetId}/transactions?since_date=${sinceDate}`,
    );
    return data.transactions;
  }
}
