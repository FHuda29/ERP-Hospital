import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import helmet from 'helmet';
import { AppModule } from './app.module.js';
import { getConfig } from './config.js';

/** Konfigurasi HTTP bersama untuk server & test e2e. */
export function configureApp(app: INestApplication) {
  const config = getConfig();
  app.setGlobalPrefix('api/v1', { exclude: ['health'] });
  app.use(helmet());
  app.enableCors({ origin: config.corsOrigin.split(','), credentials: false, exposedHeaders: ['X-Request-Id', 'Idempotent-Replay'] });
  app.enableShutdownHooks();
  return app;
}

async function bootstrap() {
  const app = configureApp(await NestFactory.create(AppModule, { bufferLogs: false }));
  const port = getConfig().port;
  await app.listen(port);
  console.log(`SIMRS API berjalan di http://localhost:${port}/api/v1`);
}

if (process.env.NODE_ENV !== 'test') await bootstrap();
