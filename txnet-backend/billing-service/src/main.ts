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
 * tenant it forwarded (`app/request/identity.middleware.ts`).
 *
 * **CORS is on, and the comment here used to say the opposite.** It said the
 * panel reached this "through its own API proxy, never from the browser" — but
 * `site-pwa` deleted that proxy on 2026-09-05 and lists it under Deprecations
 * (`panel-web/contract.md`), because server-to-server was where an intermittent
 * 502 came from. Every panel call now goes cross-origin to `api.<domain>` with
 * the access token as a Bearer header, which is how `auth-service` has been
 * reached all along. Nothing had failed, because until F-093-c no panel screen
 * had ever asked billing for anything — this service was built on an assumption
 * that had already been retired, and the first caller is what found it.
 */
async function bootstrap() {
  // `rawBody`: a webhook's signature is over the bytes sent (F-104-b, ADR-0051).
  // JSON is still parsed for every route; the raw copy rides beside it.
  const app = await NestFactory.create(AppModule, { rawBody: true });
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

  // The panel's origin, with credentials — `auth-service`'s rule, including its
  // refusal to boot without one in production. A wallet route that answered any
  // origin would be readable by any page that could borrow a session, and the
  // permissive fallback below is deliberately dev-and-localhost only.
  const frontendOrigin = config.get('FRONTEND_ORIGIN', { infer: true });
  const nodeEnv = config.get('NODE_ENV', { infer: true });
  if (!frontendOrigin && nodeEnv === 'production') {
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
    // No captcha header here: billing mints no credential of its own, so the
    // only non-safelisted header a browser sends is the bearer token.
    allowedHeaders: ['Content-Type', 'Authorization'],
    optionsSuccessStatus: 204,
  });

  app.setGlobalPrefix(globalPrefix);
  await app.listen(port);
  Logger.log(`🚀 Application is running on: http://${host}:${port}/${globalPrefix}`);
}

bootstrap();
