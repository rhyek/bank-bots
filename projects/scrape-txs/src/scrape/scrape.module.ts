import { Module } from '@nestjs/common';
import { BankConfigService } from '~/bank-config/bank-config.service';
import { BankCredentialsService } from '~/credentials/bank-credentials.service';
import { BwCli, BwCliProcess } from '~/credentials/bitwarden';
import { ScrapeAlertService } from './scrape-alert.service';
import { ScrapeJobService } from './scrape-job.service';
import { DrizzleScrapeRunStore, ScrapeRunStore } from './scrape-run.store';
import { ScrapeRunsService } from './scrape-runs.service';
import { ScrapeScheduleService } from './scrape-schedule.service';
import { ScrapeController } from './scrape.controller';

// `BwCli` and `ScrapeRunStore` are abstract classes used as injection tokens: the two seams to the
// outside (the `bw` binary, the `scrape_run` table) that specs replace with in-memory ones.
@Module({
  controllers: [ScrapeController],
  providers: [
    BankConfigService,
    BankCredentialsService,
    { provide: BwCli, useClass: BwCliProcess },
    { provide: ScrapeRunStore, useClass: DrizzleScrapeRunStore },
    ScrapeAlertService,
    ScrapeJobService,
    ScrapeRunsService,
    ScrapeScheduleService,
  ],
})
export class ScrapeModule {}
