/**
 * A gateway's merchant id, read from the vault by `billing-service` against a
 * real Postgres (F-092-f, ADR-0039).
 *
 * Two things only a database can say. First, that the binding in
 * `tenant-bound-vault-db.ts` actually reaches the RLS policy: a bind that ran
 * on another connection is not an error under RLS, it is zero rows, so every
 * `use` would answer `missing` and nothing would be red until F-092-i. Second,
 * that a ref naming **another** tenant finds nothing even though the vault's
 * own `where` would have matched — the property this service gets by reading
 * on the app pool rather than the cross-tenant one. The cross-tenant pool
 * seeing that row is the negative control.
 *
 * The credentials are written the way `auth-service` writes them: its vault,
 * on the cross-tenant pool, under the same KEK file.
 *
 *   npm run test:int
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PrismaClient, TenantCredentialKind } from '@prisma/client';
import {
  CredentialUnavailable,
  CredentialVaultService,
  KekService,
  runWithTenant,
  TenantContextMissing,
  withTenant,
} from '@txnet-backend/shared-core';

import {
  HARNESS_TIMEOUT_MS,
  PostgresFixture,
  startPostgresFixture,
} from '../../../../../test-support/postgres-fixture';
import { PrismaService } from '../../prisma/prisma.service';
import { GatewayMerchant } from './gateway-merchant';
import { tenantBoundVaultDb } from './tenant-bound-vault-db';

vi.setConfig({ testTimeout: HARNESS_TIMEOUT_MS, hookTimeout: HARNESS_TIMEOUT_MS });

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const ACTOR = '44444444-4444-4444-8444-444444444444';

let pg: PostgresFixture;
let keyDir: string;
let app: PrismaService;
let crossTenant: PrismaClient;
let merchant: GatewayMerchant;

beforeAll(async () => {
  pg = await startPostgresFixture();

  keyDir = mkdtempSync(join(tmpdir(), 'vault-kek-'));
  const keyFile = join(keyDir, 'vault-kek');
  writeFileSync(keyFile, 'ab'.repeat(32));
  const kekFor = () => {
    const kek = new KekService({ get: () => keyFile } as never);
    kek.onModuleInit();
    return kek;
  };

  const owner = new PrismaClient({ datasourceUrl: pg.ownerUrl });
  for (const [id, slug] of [[TENANT_A, 'alpha'], [TENANT_B, 'beta']]) {
    await owner.$executeRawUnsafe(`
      INSERT INTO tenant.tenant (id, "tenantType", "ownerUserId", slug, status, "billingModel", "updatedAt")
      VALUES ('${id}', 'reseller', '${id}', '${slug}', 'active', 'pay_as_you_go_metered', now())
    `);
  }
  await owner.$disconnect();

  // auth-service's side: the cross-tenant pool writes both tenants' merchants.
  crossTenant = new PrismaClient({ datasourceUrl: pg.crossTenantUrl });
  const writer = new CredentialVaultService(crossTenant, kekFor());
  for (const [tenantId, value] of [[TENANT_A, 'merchant-alpha'], [TENANT_B, 'merchant-beta']]) {
    await writer.put({ tenantId, kind: TenantCredentialKind.gateway_merchant_id, label: 'zarinpal' }, value);
  }

  // billing-service's side, exactly as `gateway.module.ts` builds it.
  const base = new PrismaService(pg.appUrl);
  app = base.$extends(withTenant(base)) as unknown as PrismaService;
  merchant = new GatewayMerchant(new CredentialVaultService(tenantBoundVaultDb(app), kekFor()));
});

afterAll(async () => {
  await Promise.allSettled([app?.$disconnect(), crossTenant?.$disconnect()]);
  await pg?.stop();
  if (keyDir) rmSync(keyDir, { recursive: true, force: true });
});

const accessRows = (tenantId: string) =>
  crossTenant.tenantCredentialAccess.findMany({ where: { tenantId } });

it("reads the request tenant's merchant id and audits the read", async () => {
  const credentials = await runWithTenant({ id: TENANT_A }, () =>
    merchant.credentialsFor({ tenantId: TENANT_A, providerName: 'zarinpal' }, ACTOR),
  );

  expect(credentials).toEqual({ merchantId: 'merchant-alpha' });
  const rows = await accessRows(TENANT_A);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ caller: 'billing:zarinpal', actorId: ACTOR, kind: 'gateway_merchant_id' });
});

it("finds no row for another tenant's gateway, though the credential exists", async () => {
  const failure = await runWithTenant({ id: TENANT_A }, () =>
    merchant.credentialsFor({ tenantId: TENANT_B, providerName: 'zarinpal' }),
  ).catch((e: unknown) => e);

  expect(failure).toBeInstanceOf(CredentialUnavailable);
  expect(failure).toMatchObject({ reason: 'missing' });
  // The negative control: the row is there, the app pool under A cannot see it.
  await expect(
    crossTenant.tenantCredential.count({ where: { tenantId: TENANT_B, kind: 'gateway_merchant_id' } }),
  ).resolves.toBe(1);
  await expect(accessRows(TENANT_B)).resolves.toHaveLength(0);
});

it('refuses to read with no tenant in scope', async () => {
  // Not `missing`: an unbound read would also find nothing, and say so.
  await expect(
    merchant.credentialsFor({ tenantId: TENANT_A, providerName: 'zarinpal' }),
  ).rejects.toBeInstanceOf(TenantContextMissing);
});
