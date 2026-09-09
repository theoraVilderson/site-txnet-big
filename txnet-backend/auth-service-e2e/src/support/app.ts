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
 *
 * One row is seeded here rather than by `prisma/seed.js`: the `tenant_domain`
 * for `E2E_HOST`. There is no fallback tenant (ADR-0025), so without it every
 * request in this suite would be answered a neutral 404 — and with it the
 * suite exercises real host resolution (`via: 'domain'`) instead of proving a
 * fallback, which is what it used to do.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Server } from 'node:http';
import { AppModule } from '../../../auth-service/src/app/app.module';
import { I18nExceptionFilter } from '../../../auth-service/src/app/common/filters/i18n-exception.filter';
import { LocaleService } from '../../../auth-service/src/app/locale/locale.service';
import { PrismaService } from '../../../auth-service/src/app/prisma/prisma.service';
import { RedisService } from '../../../auth-service/src/app/redis/redis.service';
import { runAcrossTenants } from '../../../auth-service/src/app/tenant-context/tenant-context';
import { LocaleStub } from './locale.stub';
import { OtpInbox } from './otp';

/**
 * The host every request in this suite arrives on.
 *
 * Supertest binds the app to an ephemeral port on the loopback address and
 * sends `Host: 127.0.0.1:<port>`; `TenantResolverService` normalizes the port
 * away and looks that up. Nothing configures it, so it is a fact about
 * supertest rather than a choice — asserted in `seedTenantDomain` below.
 */
export const E2E_HOST = '127.0.0.1';

export interface E2eApp {
  app: INestApplication;
  server: Server;
  prisma: PrismaService;
  /**
   * A direct read, for asserting what a request left behind.
   *
   * It runs inside `runAcrossTenants()` because a test assertion is not a
   * request: no middleware opened a tenant scope for it, and a query on a
   * scoped model would throw rather than answer (ADR-0024). Using the named
   * escape is also the honest description — the suite is checking rows the way
   * a platform owner would, from outside any tenant's surface.
   */
  db<T>(read: (prisma: PrismaService) => Promise<T>): Promise<T>;
  redis: RedisService;
  otp: OtpInbox;
  /** Back to a freshly-seeded state: no users, no sessions, empty keyspace. */
  reset(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Points `E2E_HOST` at the seeded `platform_owner` tenant, the way a real
 * deployment points `api.<domain>` at whoever owns it.
 *
 * `subdomain`, not `custom_domain`: the platform issued this host, so matching
 * the row is the whole proof (tenant invariant 5 only binds custom domains).
 * Idempotent — the suite creates several apps per run, and `domainValue` is
 * unique.
 */
async function seedTenantDomain(prisma: PrismaService): Promise<void> {
  const tenant = await prisma.tenant.findUnique({
    where: { slug: 'platform_owner' },
    select: { id: true },
  });
  if (!tenant) throw new Error('e2e: prisma/seed.js did not create platform_owner');

  await prisma.tenantDomain.upsert({
    where: { domainValue: E2E_HOST },
    update: { tenantId: tenant.id },
    create: {
      tenantId: tenant.id,
      domainType: 'subdomain',
      domainValue: E2E_HOST,
      verificationStatus: 'verified',
      verifiedAt: new Date(),
    },
  });
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

  await seedTenantDomain(prisma);

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
    // `await` *inside* the scope, not outside it: a Prisma promise is lazy,
    // so a scope that has already returned is a scope the query never ran in.
    db: (read) => runAcrossTenants(async () => await read(prisma)),
    redis,
    otp,
    reset,
    close: async () => {
      await app.close();
      otp.restore();
    },
  };
}
