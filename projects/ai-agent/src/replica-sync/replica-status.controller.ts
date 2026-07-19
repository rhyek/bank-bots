import { Controller, Get } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { SQLiteTable } from 'drizzle-orm/sqlite-core';
import { bankTx, category, payee } from '~/replica-db/replica-schema';
import { ReplicaDb } from '~/replica-db/replica-db.service';

// Observability: row counts + most-recent updated_at per table in the local replica.
@Controller('replica')
export class ReplicaStatusController {
  constructor(private readonly replica: ReplicaDb) {}

  @Get('status')
  status() {
    const stat = (t: SQLiteTable) =>
      this.replica.db
        .select({
          count: sql<number>`count(*)`,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          lastUpdatedAt: sql<string | null>`max(${(t as any).updatedAt})`,
        })
        .from(t)
        .get();
    return { payee: stat(payee), category: stat(category), bank_tx: stat(bankTx) };
  }
}
