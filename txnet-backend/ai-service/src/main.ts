import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';

import { AppModule } from './app/app.module';
import type { EnvConfig } from './app/config/env.validation';

/**
 * ai-service (ADR-0109 point 2) — every model call and every proactive
 * suggestion goes through here, so the attention budget, PII scrub, output
 * validation and token accounting have one home.
 *
 * An HTTP app for `/health` now and the tenant's AI settings later (F-038-j,
 * F-1534); no Traefik route reaches it yet. Shutdown hooks close the broker
 * so a redeploy does not leave triggers unacked until the broker times out.
 */
async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();
  const port = app.get(ConfigService<EnvConfig, true>).get('PORT', { infer: true });
  await app.listen(port);
  new Logger('bootstrap').log(`ai-service listening on ${port}`);
}

bootstrap();
