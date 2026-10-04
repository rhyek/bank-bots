import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { setupLogging } from '@rhyek/nestjs-utils';
import { AppModule } from '~/app.module';

// devtooie injects the configured port as PORT. No fallback on purpose — see ~/Dev/CLAUDE.md:
// a service that quietly binds an unallocated port is worse than one that refuses to start.
const port = Number(process.env.PORT);
if (!Number.isInteger(port)) {
  throw new Error('PORT is not set — run through devtooie (`devtooie -p scrape-txs`)');
}

// `bufferLogs: true` holds Nest's own startup logs until `setupLogging` installs the logger, so
// they come out structured instead of as pretty console lines.
const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true });

// Installs the Nest log adapter, the request-context middleware and the body interceptor.
const logger = setupLogging(app);

await app.listen(port);
logger.log(`listening on :${port}`, 'Bootstrap');
