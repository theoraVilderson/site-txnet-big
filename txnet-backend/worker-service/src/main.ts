import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { AppModule } from './app/app.module';

/**
 * worker-service — background work, and nothing else (ADR-0027).
 *
 * `createApplicationContext`, not `create`: this process listens on no port and
 * serves no HTTP. That is the decision ADR-0027 records — an in-process
 * scheduler runs inside a request-serving replica, so two replicas run every
 * job twice and a slow job degrades logins. There is deliberately no way to
 * reach this process from outside.
 *
 * Shutdown hooks are enabled because the broker connection and the tick timer
 * both need closing: without them a redeploy leaves a consumer holding unacked
 * ticks until the broker times it out.
 */
async function bootstrap() {
  const app = await NestFactory.createApplicationContext(AppModule);
  app.enableShutdownHooks();

  const logger = new Logger('bootstrap');
  const name = app.get(ConfigService).get<string>('WORKER_NAME');
  logger.log(`worker-service running${name ? ` as ${name}` : ''}`);
}
bootstrap();
