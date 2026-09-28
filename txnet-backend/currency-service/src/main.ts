import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import {
  I18nExceptionFilter,
  ResponseInterceptor,
  trustProxySetting,
} from '@txnet-backend/shared-core';

import { AppModule } from './app/app.module';
import type { EnvConfig } from './app/config/env.validation';
import { LocaleService } from './app/locale/locale.service';

/**
 * currency-service (ADR-0100) — the `currency` unit's HTTP home.
 *
 * Every route but `/health` sits behind `forward-auth`. The panel calls it
 * cross-origin with a bearer token, as it calls tenant-service, so CORS and the
 * envelope follow `tenant-service/src/main.ts`.
 */
async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();

  const locale = app.get(LocaleService);
  app.useGlobalFilters(new I18nExceptionFilter(locale));
  app.useGlobalInterceptors(new ResponseInterceptor(locale));

  const config = app.get(ConfigService<EnvConfig, true>);

  // Behind Traefik the socket's address is Traefik's; the per-caller rate
  // limit needs the visitor's (shared-core, `trust-proxy.ts`).
  app
    .getHttpAdapter()
    .getInstance()
    .set('trust proxy', trustProxySetting(config.get('TRUST_PROXY', { infer: true })));

  const globalPrefix = config.get('GLOBAL_PREFIX', { infer: true });
  const port = config.get('PORT', { infer: true });
  const host = config.get('PUBLIC_HOST', { infer: true });

  const frontendOrigin = config.get('FRONTEND_ORIGIN', { infer: true });
  if (!frontendOrigin && config.get('NODE_ENV', { infer: true }) === 'production') {
    throw new Error(
      'FRONTEND_ORIGIN must be set in production (required for CORS with credentials)',
    );
  }
  app.enableCors({
    origin: frontendOrigin
      ? frontendOrigin.split(',').map((origin) => origin.trim())
      : /^https?:\/\/localhost(:\d+)?$/, // dev only, localhost only
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    optionsSuccessStatus: 204,
  });

  app.setGlobalPrefix(globalPrefix);
  await app.listen(port);
  Logger.log(`🚀 Application is running on: http://${host}:${port}/${globalPrefix}`);
}

bootstrap();
