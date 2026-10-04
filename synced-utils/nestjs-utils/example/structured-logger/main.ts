import 'reflect-metadata';
import type { AddressInfo } from 'node:net';
import { NestFactory } from '@nestjs/core';
import { setupLogging } from '@rhyek/nestjs-utils';
import { AppModule } from './app.module';

const app = await NestFactory.create(AppModule, { bufferLogs: true });
const logger = setupLogging(app);
app.enableShutdownHooks();

// Port 0 unless told otherwise: the OS hands out a free one, so the example can never collide with
// a real service. The port it got is on the line below — the spec reads it from there.
await app.listen(Number(process.env.PORT ?? 0));
const { port } = app.getHttpServer().address() as AddressInfo;
logger.log(`listening on :${port}`, 'Bootstrap');
