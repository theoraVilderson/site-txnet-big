import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { AppModule } from './app/app.module';

/**
 * bot-service — the bot as a product surface (`bot-app`, ADR-0009/0011).
 *
 * It serves exactly one kind of caller: Telegram and Bale, posting updates to
 * an unguessable per-bot path. No browser talks to it, so there is no CORS
 * block and no cookie handling here; the user's session lives in Redis, keyed
 * by the chat.
 */
async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService);
  const logger = new Logger('bootstrap');

  app.setGlobalPrefix('api');
  app.getHttpAdapter().getInstance().set('trust proxy', config.get('TRUST_PROXY', '1'));

  const port = config.get<number>('PORT', 3002);
  await app.listen(port);
  logger.log(`bot-service listening on :${port}`);
}
bootstrap();
