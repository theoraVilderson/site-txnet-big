import { Module, type NestApplicationOptions, type Type } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { JSON_LOGGER_PROVIDER, JsonLogger } from './json-logger';
import { RequestIdMiddleware } from './request-id.middleware';

/** Provides {@link JsonLogger} (H12); every service's `AppModule` imports it. */
@Module({ providers: [JSON_LOGGER_PROVIDER], exports: [JsonLogger] })
export class JsonLoggerModule {}

/**
 * `NestFactory.create` with H12's logger and H13's request id. The id is an
 * `app.use` middleware rather than a module's, because Express runs it before
 * every module's middleware — a module-applied one runs after its importer's,
 * and a 401 from an identity middleware would carry no id.
 */
export async function createNestApp(appModule: Type<unknown>, options: NestApplicationOptions = {}) {
  const app = await NestFactory.create(appModule, { ...options, bufferLogs: true });
  app.useLogger(app.get(JsonLogger));
  const requestId = new RequestIdMiddleware();
  app.use(requestId.use.bind(requestId));
  return app;
}

/** {@link createNestApp} for a service with no HTTP surface (worker, metering). */
export async function createNestContext(appModule: Type<unknown>) {
  const app = await NestFactory.createApplicationContext(appModule, { bufferLogs: true });
  app.useLogger(app.get(JsonLogger));
  return app;
}
