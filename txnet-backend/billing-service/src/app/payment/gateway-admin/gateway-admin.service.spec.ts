/**
 * Gateway management (F-102-b, D-31): who may create, change and delete which
 * payment gateway, and what may never leave the service.
 *
 * The class reads and writes on the cross-tenant pool, so the boundary is
 * entirely in its own checks, and every way it breaks is silent:
 *
 *  - **ownership.** The platform owner manages the platform's gateways and
 *    every tenant's; any other tenant manages only its own. A reseller who can
 *    edit another reseller's gateway can point that gateway's merchant id at its
 *    own account and collect somebody else's sales. A row of another tenant is
 *    answered as *not found*, so the surface does not confirm it exists;
 *  - **verification.** Only the platform owner verifies a tenant gateway, and a
 *    tenant that changes a verified gateway's secret sends it back to
 *    `pending_test_transaction` — otherwise a verified gateway is a place to
 *    swap in an unverified account without anyone looking;
 *  - **secrets.** A merchant id and secret key are relayed to the vault writer
 *    (F-102-a) and appear in no answer, no audit row, and no gateway column;
 *  - **delete** (ADR-0041 §6). A row nothing points at is deleted. A row a
 *    payment or a grant points at is deactivated instead, its live grants
 *    withdrawn and its secrets revoked — and the secrets go first, so a failure
 *    part-way leaves a gateway that cannot charge rather than one that can.
 */
import { Prisma, TenantGatewayVerificationStatus, TenantType } from '@prisma/client';

import { GatewayAdminRefused, GatewayAdminService, GatewaySecretWriter } from './gateway-admin.service';

const OWNER = '11111111-1111-4111-8111-111111111111';
const RESELLER = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const ADMIN = '44444444-4444-4444-8444-444444444444';
const PLATFORM_GW = '55555555-5555-4555-8555-555555555555';
const RESELLER_GW = '66666666-6666-4666-8666-666666666666';
const OTHER_GW = '77777777-7777-4777-8777-777777777777';

const MERCHANT = 'zp-merchant-9f3c1e';
const SECRET = 'sk_live_very_secret_value';

const actor = (tenantId: string) => ({ adminId: ADMIN, tenantId, ip: '10.0.0.9' });

const FIELDS = {
  displayName: 'Zarinpal',
  providerName: 'zarinpal',
  gatewayCategory: 'domestic_rial',
  minAcceptAmount: '1.00',
  maxAcceptAmount: '500.00',
  feeCalculationMode: 'manual',
  feeType: 'percentage',
  feeValue: '1.5000',
} as const;

type Row = Record<string, unknown>;

function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([k, v]) => v === undefined || row[k] === v);
}

function table(rows: Row[], name: string, writes: string[]) {
  let next = 0;
  return {
    rows,
    findMany: async ({ where }: { where?: Row } = {}) => rows.filter((r) => matches(r, where)),
    findUnique: async ({ where }: { where: Row }) => rows.find((r) => matches(r, where)) ?? null,
    findFirst: async ({ where }: { where?: Row } = {}) => rows.find((r) => matches(r, where)) ?? null,
    count: async ({ where }: { where?: Row } = {}) => rows.filter((r) => matches(r, where)).length,
    create: async ({ data }: { data: Row }) => {
      writes.push(`${name}.create`);
      const row = { id: `00000000-0000-4000-8000-00000000000${next++}`, createdAt: new Date(), updatedAt: new Date(), ...data };
      rows.push(row);
      return row;
    },
    update: async ({ where, data }: { where: Row; data: Row }) => {
      writes.push(`${name}.update`);
      const row = rows.find((r) => matches(r, where));
      if (!row) throw new Error(`${name}: no row`);
      Object.assign(row, data);
      return row;
    },
    updateMany: async ({ where, data }: { where: Row; data: Row }) => {
      writes.push(`${name}.updateMany`);
      const hit = rows.filter((r) => matches(r, where));
      hit.forEach((r) => Object.assign(r, data));
      return { count: hit.length };
    },
    delete: async ({ where }: { where: Row }) => {
      writes.push(`${name}.delete`);
      const i = rows.findIndex((r) => matches(r, where));
      if (i < 0) throw new Error(`${name}: no row`);
      return rows.splice(i, 1)[0];
    },
  };
}

function build(seed: { payments?: Row[]; grants?: Row[]; verified?: boolean } = {}) {
  const writes: string[] = [];
  const audit: Row[] = [];
  const types: Record<string, TenantType> = { [OWNER]: TenantType.platform_owner, [RESELLER]: TenantType.reseller, [OTHER]: TenantType.reseller };

  const tenants = table(Object.entries(types).map(([id, tenantType]) => ({ id, tenantType })), 'tenant', writes);
  const paymentGateway = table(
    [{ id: PLATFORM_GW, ...FIELDS, isActive: true, merchantId: 'LEGACY-PLAINTEXT', supportedCurrencies: ['IRR'], createdAt: new Date(), updatedAt: new Date() }],
    'paymentGateway',
    writes,
  );
  const tenantGatewayConfig = table(
    [
      { id: RESELLER_GW, tenantId: RESELLER, ...FIELDS, isActive: true, merchantIdEncrypted: 'ENC-LEGACY', apiKeyEncrypted: 'ENC-KEY', verificationStatus: seed.verified ? TenantGatewayVerificationStatus.verified : TenantGatewayVerificationStatus.pending_test_transaction, createdAt: new Date(), updatedAt: new Date() },
      { id: OTHER_GW, tenantId: OTHER, ...FIELDS, providerName: 'idpay', isActive: true, verificationStatus: TenantGatewayVerificationStatus.verified, createdAt: new Date(), updatedAt: new Date() },
    ],
    'tenantGatewayConfig',
    writes,
  );

  const db = {
    tenant: tenants,
    paymentGateway,
    tenantGatewayConfig,
    paymentTransaction: table(seed.payments ?? [], 'paymentTransaction', writes),
    paymentGatewayGrant: table(seed.grants ?? [], 'paymentGatewayGrant', writes),
    adminAuditLog: {
      create: async ({ data }: { data: Row }) => {
        writes.push('audit');
        audit.push(data);
        return data;
      },
    },
  };
  let committed = 0;
  const all = {
    ...db,
    $transaction: async <T>(fn: (tx: typeof db) => Promise<T>) => {
      const out = await fn(db);
      committed++;
      writes.push('commit');
      return out;
    },
  };
  const app = { tenant: { findUnique: async ({ where }: { where: Row }) => (types[where['id'] as string] ? { tenantType: types[where['id'] as string] } : null) } };

  const configured = { configured: true, version: 1, rotatedAt: new Date() };
  const none = { configured: false, version: null, rotatedAt: null };
  const secrets: GatewaySecretWriter & { calls: Row[] } = {
    calls: [],
    set: vi.fn(async (target, values, actorId) => {
      writes.push('secrets.set');
      secrets.calls.push({ op: 'set', target, values, actorId });
      return { merchantId: values.merchantId ? configured : none, secretKey: values.secretKey ? configured : none };
    }),
    state: vi.fn(async () => ({ merchantId: none, secretKey: none })),
    revoke: vi.fn(async (target) => {
      writes.push('secrets.revoke');
      secrets.calls.push({ op: 'revoke', target });
      return { merchantId: none, secretKey: none };
    }),
  };

  const service = new GatewayAdminService(app as never, all as never, secrets);
  return { service, db, writes, audit, secrets, committed: () => committed };
}

async function refusal(run: () => Promise<unknown>): Promise<GatewayAdminRefused> {
  try {
    await run();
  } catch (e) {
    if (e instanceof GatewayAdminRefused) return e;
    throw e;
  }
  throw new Error('expected a refusal');
}

describe('GatewayAdminService — who may manage which gateway', () => {
  it("lists every gateway to the platform owner, and only a tenant's own to that tenant", async () => {
    const { service } = build();

    const owner = await service.list(actor(OWNER));
    expect(owner.map((g) => `${g.source}:${g.id}`).sort()).toEqual(
      [`platform:${PLATFORM_GW}`, `tenant:${RESELLER_GW}`, `tenant:${OTHER_GW}`].sort(),
    );

    const reseller = await service.list(actor(RESELLER), { tenantId: OTHER });
    expect(reseller.map((g) => g.id)).toEqual([RESELLER_GW]);
  });

  it("refuses a tenant a platform gateway and another tenant's, and writes nothing", async () => {
    const { service, writes } = build();

    expect((await refusal(() => service.create(actor(RESELLER), { source: 'platform', ...FIELDS }))).reason).toBe('not_platform_owner');
    expect((await refusal(() => service.create(actor(RESELLER), { source: 'tenant', tenantId: OTHER, ...FIELDS, providerName: 'stripe' }))).reason).toBe('not_platform_owner');
    expect((await refusal(() => service.update(actor(RESELLER), { source: 'tenant', id: OTHER_GW }, { displayName: 'mine now' }))).reason).toBe('gateway_not_found');
    expect((await refusal(() => service.update(actor(RESELLER), { source: 'platform', id: PLATFORM_GW }, { displayName: 'mine now' }))).reason).toBe('gateway_not_found');
    expect((await refusal(() => service.remove(actor(RESELLER), { source: 'tenant', id: OTHER_GW }))).reason).toBe('gateway_not_found');

    expect(writes).toEqual([]);
  });

  it("lets the platform owner create a gateway for any tenant, with that tenant's vault as the secrets' home", async () => {
    const { service, db, secrets } = build();

    const created = await service.create(actor(OWNER), { source: 'tenant', tenantId: OTHER, ...FIELDS, providerName: 'stripe', merchantId: MERCHANT });

    expect(db.tenantGatewayConfig.rows.find((r) => r['id'] === created.id)?.['tenantId']).toBe(OTHER);
    expect(secrets.calls).toEqual([
      { op: 'set', target: { tenantId: OTHER, source: 'tenant', gatewayId: created.id }, values: { merchantId: MERCHANT }, actorId: ADMIN },
    ]);
  });

  it('only the platform owner verifies, and a tenant that changes a verified gateway\'s secret sends it back to pending', async () => {
    const { service, db } = build({ verified: true });

    expect(
      (await refusal(() => service.update(actor(RESELLER), { source: 'tenant', id: RESELLER_GW }, { verificationStatus: 'verified' }))).reason,
    ).toBe('verification_is_platform_owners');

    await service.update(actor(RESELLER), { source: 'tenant', id: RESELLER_GW }, { merchantId: MERCHANT });
    expect(db.tenantGatewayConfig.rows.find((r) => r['id'] === RESELLER_GW)?.['verificationStatus']).toBe(
      TenantGatewayVerificationStatus.pending_test_transaction,
    );

    await service.update(actor(OWNER), { source: 'tenant', id: RESELLER_GW }, { verificationStatus: 'verified' });
    const row = db.tenantGatewayConfig.rows.find((r) => r['id'] === RESELLER_GW);
    expect(row?.['verificationStatus']).toBe(TenantGatewayVerificationStatus.verified);
    expect(row?.['verifiedByAdminId']).toBe(ADMIN);
  });

  it('refuses a second gateway of the same provider for one tenant, and a minimum above the maximum', async () => {
    const { service } = build();

    expect((await refusal(() => service.create(actor(RESELLER), { source: 'tenant', ...FIELDS }))).reason).toBe('provider_already_configured');
    expect(
      (await refusal(() => service.update(actor(RESELLER), { source: 'tenant', id: RESELLER_GW }, { minAcceptAmount: '900.00' }))).reason,
    ).toBe('invalid_range');
  });
});

describe('GatewayAdminService — what never leaves', () => {
  it('puts no secret, legacy column or fingerprint in an answer, an audit row or a gateway column', async () => {
    const { service, db, audit } = build();

    const created = await service.create(actor(RESELLER), { source: 'tenant', ...FIELDS, providerName: 'stripe', merchantId: MERCHANT, secretKey: SECRET });
    const updated = await service.update(actor(RESELLER), { source: 'tenant', id: RESELLER_GW }, { displayName: 'Renamed', secretKey: SECRET });
    const listed = await service.list(actor(OWNER));

    const leaked = JSON.stringify({ created, updated, listed, audit, row: db.tenantGatewayConfig.rows.find((r) => r['id'] === created.id) });
    for (const needle of [MERCHANT, SECRET, 'LEGACY-PLAINTEXT', 'ENC-LEGACY', 'ENC-KEY']) {
      expect(leaked).not.toContain(needle);
    }
    expect(created.credentials.merchantId.configured).toBe(true);
    // The audit row records *that* a secret changed, never what to.
    expect(audit.at(-1)?.['newValue']).toEqual(expect.objectContaining({ secretsChanged: ['secretKey'] }));
  });

  it('writes each change and its audit row inside one transaction', async () => {
    const { service, writes } = build();

    await service.update(actor(OWNER), { source: 'platform', id: PLATFORM_GW }, { feeValue: '2.0000' });

    expect(writes).toEqual(['paymentGateway.update', 'audit', 'commit']);
  });
});

describe('GatewayAdminService — delete (ADR-0041 §6)', () => {
  it('deletes a gateway nothing points at, after revoking its secrets', async () => {
    const { service, db, writes } = build();

    const out = await service.remove(actor(RESELLER), { source: 'tenant', id: RESELLER_GW });

    expect(out.mode).toBe('deleted');
    expect(db.tenantGatewayConfig.rows.some((r) => r['id'] === RESELLER_GW)).toBe(false);
    expect(writes.indexOf('secrets.revoke')).toBeLessThan(writes.indexOf('tenantGatewayConfig.delete'));
  });

  it('deactivates a gateway a payment or grant points at, withdraws its live grants and never deletes it', async () => {
    const { service, db, writes } = build({
      payments: [{ id: 'p1', gatewayId: PLATFORM_GW }],
      grants: [
        { id: 'g1', gatewayId: PLATFORM_GW, tenantId: RESELLER, isActive: true },
        { id: 'g2', gatewayId: PLATFORM_GW, tenantId: OTHER, isActive: false },
      ],
    });

    const out = await service.remove(actor(OWNER), { source: 'platform', id: PLATFORM_GW });

    expect(out.mode).toBe('deactivated');
    expect(db.paymentGateway.rows.find((r) => r['id'] === PLATFORM_GW)?.['isActive']).toBe(false);
    expect(db.paymentGatewayGrant.rows.find((r) => r['id'] === 'g1')).toEqual(
      expect.objectContaining({ isActive: false, withdrawnByAdminId: ADMIN }),
    );
    expect(writes).not.toContain('paymentGateway.delete');
  });

  it('leaves the gateway untouched when its secrets cannot be revoked', async () => {
    const { service, db, secrets, writes } = build();
    (secrets.revoke as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('auth-service down'));

    await expect(service.remove(actor(RESELLER), { source: 'tenant', id: RESELLER_GW })).rejects.toThrow('auth-service down');

    expect(db.tenantGatewayConfig.rows.some((r) => r['id'] === RESELLER_GW)).toBe(true);
    expect(writes.filter((w) => w !== 'secrets.revoke')).toEqual([]);
  });
});

// Keep the Decimal import honest: amounts are decimal strings on the way in (C-02).
void Prisma.Decimal;
