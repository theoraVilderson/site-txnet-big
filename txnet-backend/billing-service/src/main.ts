import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import {
  I18nExceptionFilter,
  ResponseInterceptor,
} from '@txnet-backend/shared-core';

import { AppModule } from './app/app.module';
import type { EnvConfig } from './app/config/env.validation';
import { LocaleService } from './app/locale/locale.service';

/**
 * billing-service (F-039; the request edge is F-092-a).
 *
 * Every route but `/health` sits behind `forward-auth` and runs inside the
 * tenant it forwarded (`app/request/identity.middleware.ts`). No CORS: the
 * panel reaches this through its own API proxy, never from the browser.
 */
async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();

  // The `shared-core` envelope, the same pair `auth-service` installs (F-094):
  // the filter translates what is thrown, the interceptor what is returned.
  const locale = app.get(LocaleService);
  app.useGlobalFilters(new I18nExceptionFilter(locale));
  app.useGlobalInterceptors(new ResponseInterceptor(locale));

  // Through the validated config rather than `process.env` (F-089).
  const config = app.get(ConfigService<EnvConfig, true>);
  const globalPrefix = config.get('GLOBAL_PREFIX', { infer: true });
  const port = config.get('PORT', { infer: true });
  const host = config.get('PUBLIC_HOST', { infer: true });

  app.setGlobalPrefix(globalPrefix);
  await app.listen(port);
  Logger.log(`🚀 Application is running on: http://${host}:${port}/${globalPrefix}`);
}

bootstrap();
