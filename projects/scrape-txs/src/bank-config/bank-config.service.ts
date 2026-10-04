import { Injectable } from '@nestjs/common';
import { db } from '@bank-bots/db';
import { type Config, configSchema } from './config-schema';

@Injectable()
export class BankConfigService {
  /** Reads the `config` row. Called once per batch, so an edit applies to the next run. */
  async load(): Promise<Config> {
    const row = await db.query.config.findFirst({
      where: (c, { eq }) => eq(c.id, 'general'),
      columns: { data: true },
    });
    if (!row) {
      throw new Error("config row 'general' not found");
    }
    return configSchema.parse(row.data);
  }
}
