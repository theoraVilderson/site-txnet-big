import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';

import { AppModule } from './app/app.module';
import type { EnvConfig } from './app/config/env.validation';
import { installEnvelope } from './app/envelope';
import { LocaleService } from './app/locale/locale.service';

/**
 * ai-service (ADR-0109 point 2) — every model call and every proactive
 * suggestion goes through here, so the attention budget, PII scrub, output
 * validation and token accounting have one home.
 *
 * An HTTP app: `/health`, the user's card (F-038-h) and the tenant's AI admin
 * (F-038-j1) through Traefik, the internal seams for service callers. Shutdown hooks close the broker
 * so a redeploy does not leave triggers unacked until the broker times out.
 */
async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();
  // F-038-j0: the shared envelope, as billing installs it — a refusal's reason reaches the panel.
  installEnvelope(app, app.get(LocaleService));
  const port = app.get(ConfigService<EnvConfig, true>).get('PORT', { infer: true });
  await app.listen(port);
  new Logger('bootstrap').log(`ai-service listening on ${port}`);
}

bootstrap();
