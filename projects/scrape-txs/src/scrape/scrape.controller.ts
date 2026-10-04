import {
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';
import { ZodSerializerDto } from 'nestjs-zod';
import { ScrapeRunsService } from './scrape-runs.service';
import { BankKeyParamsDto, RunDto, RunIdParamsDto, ScrapeBodyDto } from './scrape.dto';

@Controller('scrape')
export class ScrapeController {
  constructor(private readonly runs: ScrapeRunsService) {}

  /** Starts a scrape of one bank and answers at once; follow it with `GET /scrape/runs/:runId`. */
  @Post(':bankKey')
  @HttpCode(202)
  @ZodSerializerDto(RunDto)
  async start(@Param() { bankKey }: BankKeyParamsDto, @Body() body: ScrapeBodyDto) {
    const { started, alreadyRunning } = await this.runs.startBatch(
      [{ bankKey, params: body }],
      'manual',
    );
    const [run] = started;
    if (!run) {
      throw new ConflictException({
        statusCode: 409,
        message: `${bankKey} already has a scrape in progress`,
        runId: alreadyRunning[0]?.runId,
      });
    }
    return run;
  }

  @Get('runs')
  @ZodSerializerDto([RunDto])
  list() {
    return this.runs.list();
  }

  @Get('runs/:runId')
  @ZodSerializerDto(RunDto)
  async get(@Param() { runId }: RunIdParamsDto) {
    const run = await this.runs.get(runId);
    if (!run) {
      throw new NotFoundException(`No scrape run ${runId}`);
    }
    return run;
  }
}
