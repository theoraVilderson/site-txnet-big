/**
 * The manual-transfer storage (F-803-a, D-60), against a real Postgres built
 * from the committed migration history.
 *
 * Each rule here is one no service code can stand in for — two replicas, or an
 * admin editing a row by hand, would otherwise break it with no error:
 *
 *   * a reseller may run several manual gateways (a card and two wallets), but
 *     still one gateway per real provider (user, 2026-10-15);
 *   * a gateway has at most one manual setting, only a `manual_transfer`
 *     gateway has one, and a platform gateway's belongs to the platform owner;
 *   * a destination, a transfer detail and a reference are their tenant's,
 *     and never name another tenant's row;
 *   * a destination an existing payment showed is never deleted;
 *   * one external reference credits at most once per tenant and network.
 *
 *   npm run test:int
 */
import { Prisma, PrismaClient } from '@prisma/client';
import { runWithTenant, tenantTransaction, withTenant } from '@txnet-backend/shared-core';

import {
  HARNESS_TIMEOUT_MS,
  PostgresFixture,
  prismaAt,
  startPostgresFixture,
} from '../../../../../test-support/postgres-fixture';
import { PrismaService } from '../../prisma/prisma.service';

vi.setConfig({ testTimeout: HARNESS_TIMEOUT_MS, hookTimeout: HARNESS_TIMEOUT_MS });

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const PLATFORM = '33333333-3333-4333-8333-333333333333';
const ROLE = '44444444-4444-4444-8444-444444444444';
const USER_A = '55555555-5555-4555-8555-5555555555a1';
const USER_B = '55555555-5555-4555-8555-5555555555b1';

const A_CARD = '66666666-6666-4666-8666-6666666666a1';
const A_WALLET = '66666666-6666-4666-8666-6666666666a2';
const A_ZARINPAL = '66666666-6666-4666-8666-6666666666a3';
const B_CARD = '66666666-6666-4666-8666-6666666666b1';
const P_MANUAL = '77777777-7777-4777-8777-7777777777a1';
const P_ZARINPAL = '77777777-7777-4777-8777-7777777777a2';

const SET_A = '88888888-8888-4888-8888-8888888888a1';
const SET_B = '88888888-8888-4888-8888-8888888888b1';
const DEST_A = '99999999-9999-4999-8999-9999999999a1';
const DEST_B = '99999999-9999-4999-8999-9999999999b1';
const PAY_A = 'aaaaaaaa-0000-4000-8000-0000000000a1';
const PAY_A2 = 'aaaaaaaa-0000-4000-8000-0000000000a2';
const PAY_B = 'aaaaaaaa-0000-4000-8000-0000000000b1';

let pg: PostgresFixture;
let owner: PrismaClient;
let app: PrismaService;

const asTenant = <T>(tenantId: string, fn: (tx: Prisma.TransactionClient) => Promise<T>) =>
  runWithTenant({ id: tenantId }, () => tenantTransaction(app, fn));

const sql = (text: string) => owner.$executeRawUnsafe(text);

const tenantGateway = (id: string, tenantId: string, provider: string, category: string) => sql(`
  INSERT INTO tenant.tenant_gateway_config
    (id, "tenantId", "displayName", "providerName", "gatewayCategory", "feeCalculationMode", "feeType", "feeValue", "updatedAt", "currencyCode")
  VALUES ('${id}', '${tenantId}', 'gw', '${provider}', '${category}', 'manual', 'fixed', 0, now(), 'IRT')`);

const platformGateway = (id: string, provider: string, category: string) => sql(`
  INSERT INTO billing.payment_gateway
    (id, "displayName", "providerName", "gatewayCategory", "supportedCurrencies", "merchantId", "feeCalculationMode", "feeType", "feeValue", "updatedAt", "currencyCode")
  VALUES ('${id}', 'gw', '${provider}', '${category}', '["IRR"]', '', 'manual', 'fixed', 0, now(), 'USD')`);

/** One setting; `column` names which gateway column it fills. */
const setting = (o: { id?: string; tenantId: string; gateway: string; column?: 'gatewayId' | 'tenantGatewayConfigId'; windowMinutes?: number }) => sql(`
  INSERT INTO billing.manual_gateway_setting (id, "tenantId", "${o.column ?? 'tenantGatewayConfigId'}", kind, "requiredProof", "windowMinutes", "updatedAt")
  VALUES ('${o.id ?? crypto.randomUUID()}', '${o.tenantId}', '${o.gateway}', 'card_to_card', '{trackingCode}', ${o.windowMinutes ?? 30}, now())`);

const destination = (id: string, tenantId: string, settingId: string, weight = 1) => sql(`
  INSERT INTO billing.manual_destination (id, "tenantId", "settingId", label, fields, weight, "updatedAt")
  VALUES ('${id}', '${tenantId}', '${settingId}', 'main card', '{"cardNumber":"6037991234567890"}', ${weight}, now())`);

const payment = (id: string, tenantId: string, userId: string, gateway: string) => sql(`
  INSERT INTO billing.payment_transaction
    (id, "tenantId", "userId", "tenantGatewayConfigId", "amountRequested", "feeApplied", "amountCredited", "chargedAmountMinor", "currencyCode")
  VALUES ('${id}', '${tenantId}', '${userId}', '${gateway}', 10.00, 0, 10.00, 1000000, 'IRT')`);

const detail = (paymentId: string, tenantId: string, destinationId: string, expected = '1000000') => sql(`
  INSERT INTO billing.payment_transfer_detail
    ("paymentId", "tenantId", "destinationId", "destinationSnapshot", "expectedAmountMinor", "chargeCurrency", "chargeDecimals", "windowEndsAt", "updatedAt")
  VALUES ('${paymentId}', '${tenantId}', '${destinationId}', '{}', ${expected}, 'IRR', 0, now() + interval '30 minutes', now())`);

const txRef = (tenantId: string, paymentId: string, network: string, ref: string) => sql(`
  INSERT INTO billing.transfer_tx_ref ("tenantId", "paymentId", network, "txRef") VALUES ('${tenantId}', '${paymentId}', '${network}', '${ref}')`);

beforeAll(async () => {
  pg = await startPostgresFixture();
  owner = prismaAt(pg.ownerUrl);

  await sql(`INSERT INTO identity.role (id, name, "isSystemRole") VALUES ('${ROLE}', 'User', true)`);
  for (const [id, slug, type] of [[TENANT_A, 'alpha', 'reseller'], [TENANT_B, 'beta', 'reseller'], [PLATFORM, 'platform', 'platform_owner']]) {
    await sql(`
      INSERT INTO tenant.tenant (id, "tenantType", "ownerUserId", slug, status, "billingModel", "updatedAt")
      VALUES ('${id}', '${type}', '${id}', '${slug}', 'active', 'pay_as_you_go_metered', now())`);
  }
  for (const [id, tenantId] of [[USER_A, TENANT_A], [USER_B, TENANT_B]]) {
    await sql(`
      INSERT INTO identity."user" (id, "tenantId", "fullName", "passwordHash", "roleId", "updatedAt")
      VALUES ('${id}', '${tenantId}', 'Someone', 'x', '${ROLE}', now())`);
  }
  await tenantGateway(A_CARD, TENANT_A, 'manual_transfer', 'manual');
  await tenantGateway(A_ZARINPAL, TENANT_A, 'zarinpal', 'domestic_rial');
  await tenantGateway(B_CARD, TENANT_B, 'manual_transfer', 'manual');
  await platformGateway(P_MANUAL, 'manual_transfer', 'manual');
  await platformGateway(P_ZARINPAL, 'zarinpal', 'domestic_rial');

  await setting({ id: SET_A, tenantId: TENANT_A, gateway: A_CARD });
  await setting({ id: SET_B, tenantId: TENANT_B, gateway: B_CARD });
  await destination(DEST_A, TENANT_A, SET_A);
  await destination(DEST_B, TENANT_B, SET_B);
  await payment(PAY_A, TENANT_A, USER_A, A_CARD);
  await payment(PAY_A2, TENANT_A, USER_A, A_CARD);
  await payment(PAY_B, TENANT_B, USER_B, B_CARD);
  await detail(PAY_A, TENANT_A, DEST_A);

  const base = new PrismaService(pg.appUrl);
  app = base.$extends(withTenant(base)) as unknown as PrismaService;
});

afterAll(async () => {
  await Promise.allSettled([app?.$disconnect(), owner?.$disconnect()]);
  await pg?.stop();
});

describe('a manual gateway is a provider a reseller may run more than once', () => {
  it('a second manual_transfer gateway is accepted', async () => {
    await expect(tenantGateway(A_WALLET, TENANT_A, 'manual_transfer', 'manual')).resolves.toBe(1);
  });

  it('a second zarinpal still is not', async () => {
    await expect(tenantGateway(crypto.randomUUID(), TENANT_A, 'zarinpal', 'domestic_rial')).rejects.toThrow(/already exists/);
  });
});

describe('the manual setting', () => {
  it('is one per gateway', async () => {
    await expect(setting({ tenantId: TENANT_A, gateway: A_CARD })).rejects.toThrow(/already exists/);
  });

  it('names exactly one gateway', async () => {
    await expect(sql(`
      INSERT INTO billing.manual_gateway_setting ("tenantId", kind, "updatedAt") VALUES ('${TENANT_A}', 'card_to_card', now())`)).rejects.toThrow(/one_gateway/);
  });

  it('exists only on a manual_transfer gateway', async () => {
    await expect(setting({ tenantId: TENANT_A, gateway: A_ZARINPAL })).rejects.toThrow(/manual_transfer/);
  });

  it('of a platform gateway is the platform owner\'s, never a reseller\'s', async () => {
    await expect(setting({ tenantId: TENANT_A, gateway: P_MANUAL, column: 'gatewayId' })).rejects.toThrow(/platform owner/);
    await expect(setting({ tenantId: PLATFORM, gateway: P_MANUAL, column: 'gatewayId' })).resolves.toBe(1);
  });

  it('cannot name another tenant\'s gateway', async () => {
    await expect(setting({ tenantId: TENANT_B, gateway: A_WALLET })).rejects.toThrow(/foreign key/i);
  });

  it('keeps its payment window within 10..1440 minutes', async () => {
    await expect(setting({ tenantId: TENANT_A, gateway: A_WALLET, windowMinutes: 5 })).rejects.toThrow(/window/);
    await expect(setting({ tenantId: TENANT_A, gateway: A_WALLET, windowMinutes: 1441 })).rejects.toThrow(/window/);
  });
});

describe('a destination', () => {
  it('belongs to its setting\'s tenant', async () => {
    await expect(destination(crypto.randomUUID(), TENANT_B, SET_A)).rejects.toThrow(/foreign key/i);
  });

  it('keeps its weight within 1..100', async () => {
    await expect(destination(crypto.randomUUID(), TENANT_A, SET_A, 0)).rejects.toThrow(/weight/);
  });

  it('that a payment showed is never deleted', async () => {
    await expect(sql(`DELETE FROM billing.manual_destination WHERE id = '${DEST_A}'`)).rejects.toThrow(/foreign key/i);
  });
});

describe('a transfer detail', () => {
  it('is its payment\'s tenant\'s', async () => {
    await expect(detail(PAY_B, TENANT_A, DEST_A)).rejects.toThrow(/tenant/);
  });

  it('never names another tenant\'s destination', async () => {
    await expect(detail(PAY_B, TENANT_B, DEST_A)).rejects.toThrow(/foreign key/i);
  });

  it('expects a positive amount', async () => {
    await expect(detail(PAY_A2, TENANT_A, DEST_A, '0')).rejects.toThrow(/expected/);
  });
});

describe('an external reference', () => {
  it('credits once per tenant and network', async () => {
    await txRef(TENANT_A, PAY_A, 'card', 'TRK-1');
    await expect(txRef(TENANT_A, PAY_A2, 'card', 'TRK-1')).rejects.toThrow(/already exists/);
    await expect(txRef(TENANT_A, PAY_A2, 'TRC20', 'TRK-1')).resolves.toBe(1);
    await expect(txRef(TENANT_B, PAY_B, 'card', 'TRK-1')).resolves.toBe(1);
  });

  it('is its payment\'s tenant\'s', async () => {
    await expect(txRef(TENANT_B, PAY_A, 'card', 'TRK-2')).rejects.toThrow(/tenant/);
  });
});

describe('a tenant reads only its own', () => {
  it('settings, destinations, details and references', async () => {
    const count = (tx: Prisma.TransactionClient, table: string) =>
      tx.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM billing.${table}`).then((r) => Number(r[0]?.n));
    const seen = await asTenant(TENANT_B, async (tx) => ({
      settings: await count(tx, 'manual_gateway_setting'),
      destinations: await count(tx, 'manual_destination'),
      details: await count(tx, 'payment_transfer_detail'),
      refs: await count(tx, 'transfer_tx_ref'),
    }));
    expect(seen).toEqual({ settings: 1, destinations: 1, details: 0, refs: 1 });
  });
});
