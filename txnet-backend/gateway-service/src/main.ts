import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Server as HttpServer } from 'node:http';
import { AppModule } from './app/app.module';
import { RealtimeGateway } from './app/realtime/realtime.gateway';

/**
 * gateway-service — the WebSocket gateway (F-067-h, D-9).
 *
 * A real HTTP application, unlike `worker-service`: a WebSocket upgrade *is*
 * an HTTP request, and Traefik needs a port to route to and a `/health` to
 * ask. What it is not is an API — the only route is that health check, and
 * every socket is authenticated by `forward-auth` before it reaches here.
 *
 * The gateway takes over `upgrade` on the server Nest is already listening
 * with, so one process and one port serve both. Shutdown hooks are enabled
 * because they are the only thing that closes held sockets on a redeploy:
 * without them clients discover the process is gone by timing out, one
 * heartbeat at a time.
 */
async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();

  const config = app.get(ConfigService);
  const port = config.get<number>('PORT')!;

  // `listen` before `attach`: the underlying server exists either way, but
  // attaching after it is bound means an upgrade can never arrive at a
  // gateway whose timers have not started.
  await app.listen(port);
  app.get(RealtimeGateway).attach(app.getHttpServer() as HttpServer);

  new Logger('bootstrap').log(`gateway-service listening on ${port}`);
}
bootstrap();
