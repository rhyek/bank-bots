import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from '~/app.module';

// devtooie injects the configured port as PORT; fall back to a default for a standalone run.
const PORT = Number(process.env.PORT ?? 3000);

const app = await NestFactory.create<NestExpressApplication>(AppModule);

await app.listen(PORT);
console.log(`[app] listening on :${PORT}`);
