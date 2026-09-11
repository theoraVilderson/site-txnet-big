/**
 * This is not a production server yet!
 * This is only a minimal backend to get started.
 */

import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';

import { AppModule } from './app/app.module';
import type { EnvConfig } from './app/config/env.validation';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Through the validated config rather than `process.env` (F-089). A typo'd
  // variable is now a refusal to start instead of a service that boots on a
  // default and looks healthy.
  const config = app.get(ConfigService<EnvConfig, true>);
  const globalPrefix = config.get('GLOBAL_PREFIX', { infer: true });
  const port = config.get('PORT', { infer: true });
  const host = config.get('PUBLIC_HOST', { infer: true });

  app.setGlobalPrefix(globalPrefix);
  await app.listen(port);
  Logger.log(`🚀 Application is running on: http://${host}:${port}/${globalPrefix}`);
}

bootstrap();
