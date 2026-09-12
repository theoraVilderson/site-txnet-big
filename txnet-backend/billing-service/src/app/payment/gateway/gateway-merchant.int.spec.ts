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
 * And, since D-26, that every gateway pays into its own account: two gateways
 * of one provider under one tenant read two merchant ids, and a gateway with
 * no credential of its own is refused rather than handed a provider-wide one.
 * `configuredLabels` is what keeps such a gateway off the top-up page at all
 * (F-092-u), so it must see this tenant's gateway labels and nothing else.
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
const A_OWN = 'aaaaaaaa-0000-4000-8000-000000000001';
const A_PLATFORM = 'aaaaaaaa-0000-4000-8000-000000000002';
const A_NO_CREDENTIAL = 'aaaaaaaa-0000-4000-8000-000000000003';
const B_OWN = 'bbbbbbbb-0000-4000-8000-000000000001';

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
  for (const [tenantId, label, value] of [
    [TENANT_A, `gateway:tenant:${A_OWN}`, 'merchant-alpha'],
    [TENANT_A, `gateway:platform:${A_PLATFORM}`, 'merchant-alpha-platform'],
    // The provider-wide label F-092-f used: nothing may read it any more.
    [TENANT_A, 'zarinpal', 'merchant-shared'],
    [TENANT_B, `gateway:tenant:${B_OWN}`, 'merchant-beta'],
  ]) {
    await writer.put({ tenantId, kind: TenantCredentialKind.gateway_merchant_id, label }, value);
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

const zarinpal = (tenantId: string, source: 'tenant' | 'platform', gatewayId: string) =>
  ({ tenantId, source, gatewayId, providerName: 'zarinpal' }) as const;

it("reads the request tenant's merchant id and audits the read", async () => {
  const credentials = await runWithTenant({ id: TENANT_A }, () =>
    merchant.credentialsFor(zarinpal(TENANT_A, 'tenant', A_OWN), ACTOR),
  );

  expect(credentials).toEqual({ merchantId: 'merchant-alpha' });
  const rows = await accessRows(TENANT_A);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ caller: 'billing:zarinpal', actorId: ACTOR, kind: 'gateway_merchant_id' });
});

it("finds no row for another tenant's gateway, though the credential exists", async () => {
  const failure = await runWithTenant({ id: TENANT_A }, () =>
    merchant.credentialsFor(zarinpal(TENANT_B, 'tenant', B_OWN)),
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
    merchant.credentialsFor(zarinpal(TENANT_A, 'tenant', A_OWN)),
  ).rejects.toBeInstanceOf(TenantContextMissing);
});

it('gives two gateways of one provider under one tenant their own accounts', async () => {
  const [own, platform] = await runWithTenant({ id: TENANT_A }, () =>
    Promise.all([
      merchant.credentialsFor(zarinpal(TENANT_A, 'tenant', A_OWN)),
      merchant.credentialsFor(zarinpal(TENANT_A, 'platform', A_PLATFORM)),
    ]),
  );

  expect(own).toEqual({ merchantId: 'merchant-alpha' });
  expect(platform).toEqual({ merchantId: 'merchant-alpha-platform' });
});

it('refuses a gateway with no merchant id of its own, though a provider-wide one exists', async () => {
  await expect(
    runWithTenant({ id: TENANT_A }, () => merchant.credentialsFor(zarinpal(TENANT_A, 'tenant', A_NO_CREDENTIAL))),
  ).rejects.toMatchObject({ name: 'CredentialUnavailable', reason: 'missing' });
});

it('lists the gateway labels this tenant has a merchant id for, and no other kind', async () => {
  const labels = await runWithTenant({ id: TENANT_A }, () => merchant.configuredLabels(TENANT_A));

  // The provider-wide `zarinpal` row is a `gateway_merchant_id` too, so it is
  // listed; what matters is that no gateway label of another tenant is.
  expect(labels).toEqual(new Set([`gateway:tenant:${A_OWN}`, `gateway:platform:${A_PLATFORM}`, 'zarinpal']));
  expect(labels.has(`gateway:tenant:${B_OWN}`)).toBe(false);
});

it('refuses to confirm a gateway that has no merchant id, and confirms one that has', async () => {
  await runWithTenant({ id: TENANT_A }, async () => {
    await expect(merchant.requireConfigured(zarinpal(TENANT_A, 'tenant', A_OWN))).resolves.toBeUndefined();
    await expect(
      merchant.requireConfigured(zarinpal(TENANT_A, 'tenant', A_NO_CREDENTIAL)),
    ).rejects.toMatchObject({ name: 'CredentialUnavailable', reason: 'missing' });
  });
});
