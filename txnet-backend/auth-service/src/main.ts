import { RequestHeaders } from '@txnet-backend/shared-core';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { AppModule } from './app/app.module';
import { ConfigService } from '@nestjs/config';
import { LocaleService } from './app/locale/locale.service';
import { I18nExceptionFilter } from './app/common/filters/i18n-exception.filter';
import { ResponseInterceptor } from './app/common/interceptors/response.interceptor';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const configService = app.get(ConfigService);
  const logger = new Logger('bootstrap');

  const nodeEnv = configService.get<string>('NODE_ENV', 'development');
  const frontendOrigin = configService.get<string>('FRONTEND_ORIGIN');

  const trustProxy = configService.get<string>('TRUST_PROXY', '1');
  const expressApp = app.getHttpAdapter().getInstance();
  const localeService = app.get(LocaleService);

  // The two halves of one contract: the filter translates what is thrown, the
  // interceptor what is returned. Without the second, every `ok()` / `err()`
  // key reached the client verbatim — `accountSwitch.sameAccount` on a screen
  // — and `bot-service`, which reads the `{ok, data}` envelope this builds,
  // saw no envelope at all.
  app.useGlobalFilters(new I18nExceptionFilter(localeService));
  app.useGlobalInterceptors(new ResponseInterceptor(localeService));

  expressApp.set('trust proxy', trustProxy);

  // In production, a missing FRONTEND_ORIGIN means fail-closed, not
  // "allow any origin".
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
    allowedHeaders: ['Content-Type', 'Authorization', RequestHeaders.captchaToken],
    optionsSuccessStatus: 204,
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  const port = configService.get<number>('PORT', 3001);
  app.setGlobalPrefix('api');

  await app.listen(port);
  logger.log(`auth-service listening on :${port}`);
}
bootstrap();
// probe-1788552856
