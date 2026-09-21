import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { AppModule } from './app/app.module';

/**
 * metering-service — collection passes become usage, and nothing else
 * (ADR-0077).
 *
 * `createApplicationContext`, not `create`: this process listens on no port and
 * serves no HTTP, for ADR-0027's reason and one of its own — it writes every
 * tenant's traffic in a loop, so it holds the cross-tenant pool, and a process
 * holding that should have no door on it at all.
 *
 * Shutdown hooks are enabled because the broker connection needs closing:
 * without them a redeploy leaves a consumer holding unacked passes until the
 * broker times it out, and those bytes wait that long to be counted.
 */
async function bootstrap() {
  const app = await NestFactory.createApplicationContext(AppModule);
  app.enableShutdownHooks();
  new Logger('bootstrap').log('metering-service running');
}
bootstrap();
