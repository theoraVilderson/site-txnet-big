/**
 * Boots the real `auth-service` in-process and hands back a Supertest agent.
 *
 * Everything `main.ts` does to the app is repeated here — global `api`
 * prefix, the same ValidationPipe, the same CORS policy and the same
 * `I18nExceptionFilter` — because those are part of the wire contract: the
 * prefix decides the paths, the filter decides the error envelope. A harness
 * that skipped them would be testing a different service.
 *
 * The only substitution is `LocaleService` (see locale.stub.ts). Postgres and
 * Redis are real.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Server } from 'node:http';
import { AppModule } from '../../../auth-service/src/app/app.module';
import { I18nExceptionFilter } from '../../../auth-service/src/app/common/filters/i18n-exception.filter';
import { LocaleService } from '../../../auth-service/src/app/locale/locale.service';
import { PrismaService } from '../../../auth-service/src/app/prisma/prisma.service';
import { RedisService } from '../../../auth-service/src/app/redis/redis.service';
import { LocaleStub } from './locale.stub';
import { OtpInbox } from './otp';

export interface E2eApp {
  app: INestApplication;
  server: Server;
  prisma: PrismaService;
  redis: RedisService;
  otp: OtpInbox;
  /** Back to a freshly-seeded state: no users, no sessions, empty keyspace. */
  reset(): Promise<void>;
  close(): Promise<void>;
}

export async function createE2eApp(): Promise<E2eApp> {
  const otp = new OtpInbox();
  otp.install();

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(LocaleService)
    .useValue(new LocaleStub())
    .compile();

  const app = moduleRef.createNestApplication();
  const locale = app.get(LocaleService);

  app.useGlobalFilters(new I18nExceptionFilter(locale));
  app.getHttpAdapter().getInstance().set('trust proxy', '1');
  app.enableCors({
    origin: [process.env.FRONTEND_ORIGIN as string],
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-captcha-token'],
    optionsSuccessStatus: 204,
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.setGlobalPrefix('api');

  await app.init();

  const prisma = app.get(PrismaService);
  const redis = app.get(RedisService);

  const reset = async () => {
    // Order matters: children first, and the seeded tenant owner survives —
    // a tenant row points at it, and `RegisterService` needs that tenant.
    await prisma.$executeRawUnsafe('DELETE FROM identity.otp_code');
    await prisma.$executeRawUnsafe('DELETE FROM identity.session');
    await prisma.$executeRawUnsafe('DELETE FROM identity.linked_bot_account');
    await prisma.$executeRawUnsafe(
      'DELETE FROM identity."user" WHERE id NOT IN (SELECT "ownerUserId" FROM tenant.tenant)',
    );
    // Sessions, OTP records, rate-limit counters and captcha passes all live
    // here; a test must not inherit another's rate-limit window.
    await redis.client.flushdb();
    otp.clear();
  };

  await reset();

  return {
    app,
    server: app.getHttpServer(),
    prisma,
    redis,
    otp,
    reset,
    close: async () => {
      await app.close();
      otp.restore();
    },
  };
}
