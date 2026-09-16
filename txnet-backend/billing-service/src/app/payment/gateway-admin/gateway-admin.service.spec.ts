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
const WEBHOOK = 'whsec_signing_secret_value';

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
    upsert: async ({ where, create, update }: { where: Row; create: Row; update: Row }) => {
      writes.push(`${name}.upsert`);
      const row = rows.find((r) => matches(r, where));
      if (row) return Object.assign(row, update);
      rows.push({ ...create });
      return create;
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
    depositSetting: table([], 'depositSetting', writes),
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
      return {
        merchantId: values.merchantId ? configured : none,
        secretKey: values.secretKey ? configured : none,
        webhookSecret: values.webhookSecret ? configured : none,
      };
    }),
    state: vi.fn(async () => ({ merchantId: none, secretKey: none, webhookSecret: none })),
    revoke: vi.fn(async (target) => {
      writes.push('secrets.revoke');
      secrets.calls.push({ op: 'revoke', target });
      return { merchantId: none, secretKey: none, webhookSecret: none };
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

  it('creates a gateway with no amount range and clears a bound on edit — null is no limit, not a missing field', async () => {
    const { service, db } = build();

    const created = await service.create(actor(OWNER), { source: 'tenant', tenantId: OTHER, ...FIELDS, providerName: 'stripe', minAcceptAmount: undefined, maxAcceptAmount: undefined });
    expect([created.minAcceptAmount, created.maxAcceptAmount]).toEqual([null, null]);

    const updated = await service.update(actor(RESELLER), { source: 'tenant', id: RESELLER_GW }, { maxAcceptAmount: null });
    expect(updated.maxAcceptAmount).toBeNull();
    expect(db.tenantGatewayConfig.rows.find((r) => r['id'] === RESELLER_GW)?.['maxAcceptAmount']).toBeNull();
    // With the maximum open, any minimum is a valid range.
    await expect(service.update(actor(RESELLER), { source: 'tenant', id: RESELLER_GW }, { minAcceptAmount: '900.00' })).resolves.toBeDefined();
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

/**
 * Quick amounts on the top-up page (F-092-v): a gateway's own list and the
 * tenant's default. Both are written through `normalizePresets`, so what the
 * top-up page is handed is already sorted, unique and in two decimals.
 */
describe('GatewayAdminService — quick amounts (F-092-v)', () => {
  it("stores a gateway's own list normalised, and answers it", async () => {
    const { service, db } = build();

    const view = await service.update(actor(RESELLER), { source: 'tenant', id: RESELLER_GW }, { depositPresets: ['5', '2.5', '5.00'] });

    expect(view.depositPresets).toEqual(['2.50', '5.00']);
    const row = db.tenantGatewayConfig.rows.find((r) => r['id'] === RESELLER_GW)!;
    expect((row['depositPresets'] as Prisma.Decimal[]).map((d) => d.toFixed(2))).toEqual(['2.50', '5.00']);
  });

  it('refuses a list it cannot store, and writes nothing', async () => {
    const { service, writes } = build();

    expect((await refusal(() => service.update(actor(RESELLER), { source: 'tenant', id: RESELLER_GW }, { depositPresets: ['0'] }))).reason).toBe(
      'invalid_presets',
    );
    expect(writes).toEqual([]);
  });

  it("reads and writes the caller's own default list, audited, and no other tenant's", async () => {
    const { service, audit } = build();

    expect(await service.presets(actor(RESELLER))).toEqual([]);
    expect(await service.setPresets(actor(RESELLER), ['2.5', '2'])).toEqual(['2.00', '2.50']);
    expect(await service.presets(actor(RESELLER))).toEqual(['2.00', '2.50']);
    expect(await service.presets(actor(OTHER))).toEqual([]);
    expect(audit.at(-1)).toMatchObject({ tenantId: RESELLER, action: 'deposit_presets_update', targetEntityType: 'config', targetEntityId: RESELLER });
  });
});

/** F-092-w: the callback address Zarinpal is given, written per gateway. */
describe('GatewayAdminService — callback address (F-092-w)', () => {
  it('stores an http(s) address trimmed, answers it, and clears it with null', async () => {
    const { service } = build();

    const set = await service.update(actor(RESELLER), { source: 'tenant', id: RESELLER_GW }, { callbackUrl: ' https://pay.example.org/cb ' });
    expect(set.callbackUrl).toBe('https://pay.example.org/cb');

    const cleared = await service.update(actor(RESELLER), { source: 'tenant', id: RESELLER_GW }, { callbackUrl: null });
    expect(cleared.callbackUrl).toBeNull();
  });

  it('refuses anything that is not an absolute http(s) address, and writes nothing', async () => {
    const { service, writes } = build();

    for (const callbackUrl of ['pay.example.org/cb', 'javascript:alert(1)', 'ftp://x.example/cb']) {
      expect((await refusal(() => service.update(actor(RESELLER), { source: 'tenant', id: RESELLER_GW }, { callbackUrl }))).reason).toBe('invalid_callback');
    }
    expect(writes).toEqual([]);
  });
});

describe('GatewayAdminService — the D-32 providers (F-104-e)', () => {
  it('relays a webhook secret like the other two: to the writer, named in the audit row, never in an answer', async () => {
    const { service, audit, secrets } = build();

    const created = await service.create(actor(RESELLER), { source: 'tenant', ...FIELDS, providerName: 'stripe', secretKey: SECRET, webhookSecret: WEBHOOK });

    expect(secrets.calls).toEqual([
      { op: 'set', target: { tenantId: RESELLER, source: 'tenant', gatewayId: created.id }, values: { secretKey: SECRET, webhookSecret: WEBHOOK }, actorId: ADMIN },
    ]);
    expect(audit.at(-1)?.['newValue']).toEqual(expect.objectContaining({ secretsChanged: ['secretKey', 'webhookSecret'] }));
    expect(created.credentials?.webhookSecret.configured).toBe(true);
    expect(JSON.stringify({ created, audit })).not.toContain(WEBHOOK);
  });

  it("creates and activates a gateway missing its provider's secrets, and says which are missing (the user's call)", async () => {
    const { service } = build();

    const bare = await service.create(actor(RESELLER), { source: 'tenant', ...FIELDS, providerName: 'airwallex', isActive: true });
    expect(bare.isActive).toBe(true);
    expect(bare.missingSecrets).toEqual(['merchantId', 'secretKey', 'webhookSecret']);

    const half = await service.create(actor(OWNER), { source: 'platform', ...FIELDS, providerName: 'stripe', secretKey: SECRET });
    expect(half.missingSecrets).toEqual(['webhookSecret']);

    const listed = await service.list(actor(RESELLER));
    expect(listed.find((g) => g.id === RESELLER_GW)?.missingSecrets).toEqual(['merchantId']);
  });

  it('says nothing about missing secrets when the vault writer could not be asked', async () => {
    const { service, secrets } = build();
    secrets.state = vi.fn(async () => {
      throw new Error('unreachable');
    });

    const listed = await service.list(actor(RESELLER));

    expect(listed[0].credentials).toBeNull();
    expect(listed[0].missingSecrets).toBeNull();
  });

  it('refuses a telegram_stars gateway with no USD value per Star, and writes nothing', async () => {
    const { service, writes } = build();
    const stars = { ...FIELDS, providerName: 'telegram_stars', gatewayCategory: 'in_chat' } as const;

    for (const staticRate of [undefined, null, '0']) {
      const e = await refusal(() => service.create(actor(RESELLER), { source: 'tenant', ...stars, staticRate }));
      expect([e.reason, e.message]).toEqual(['missing_field', 'missing_field: staticRate']);
    }
    expect(writes).toEqual([]);
  });

  it("stores a Star's value as the static rate with the live rate off, whatever was sent, and needs no secret", async () => {
    const { service, db } = build();

    const created = await service.create(actor(RESELLER), {
      source: 'tenant',
      ...FIELDS,
      providerName: 'telegram_stars',
      gatewayCategory: 'in_chat',
      staticRate: '0.013',
      useLiveRate: true,
    });

    expect(created.staticRate).toBe('0.013');
    expect(created.useLiveRate).toBe(false);
    expect(db.tenantGatewayConfig.rows.find((r) => r['id'] === created.id)?.['useLiveRate']).toBe(false);
    expect(created.missingSecrets).toEqual([]);
  });

  it('refuses an edit that leaves a telegram_stars gateway without its rate, including switching a gateway to it', async () => {
    const { service, writes } = build();

    const switched = await refusal(() =>
      service.update(actor(RESELLER), { source: 'tenant', id: RESELLER_GW }, { providerName: 'telegram_stars' }),
    );
    expect(switched.reason).toBe('missing_field');

    const withRate = await service.update(actor(RESELLER), { source: 'tenant', id: RESELLER_GW }, { providerName: 'telegram_stars', staticRate: '0.013' });
    expect(withRate.useLiveRate).toBe(false);

    writes.length = 0;
    const cleared = await refusal(() => service.update(actor(RESELLER), { source: 'tenant', id: RESELLER_GW }, { staticRate: null }));
    expect(cleared.reason).toBe('missing_field');
    expect(writes).toEqual([]);
  });
});
