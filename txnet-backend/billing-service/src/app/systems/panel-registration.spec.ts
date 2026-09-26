/**
 * Registering a panel (F-027-ar, ADR-0080 decision 1): the route writes the
 * `panel` row as `pending` and nothing tests it — `network-service` does, on
 * its own tick. What would break silently here:
 *
 *  - **who.** The platform owner registers, nobody else (decision 2): a
 *    reseller's panel would have the cross-tenant collector dial an address a
 *    tenant chose. The refusal writes nothing and calls no vault;
 *  - **the secret.** The panel's login goes to the owner's vault and never
 *    into `panel.panelApiCredentials`, which holds only where the vault keeps
 *    it — a column is read by every `select *`, a vault row by one audited
 *    `use`;
 *  - **no half-registration.** A vault that refused or did not answer leaves
 *    no `pending` row behind: the next tick would test a panel whose
 *    credentials were never stored.
 */
import { DriverType, CounterSemantics, PanelTransport, PanelRole, TenantType } from '@prisma/client';
import { PanelReviewState } from '@prisma/client';
import { panelCredentialLabel, panelCredentialRef, PanelSecret, panelRadiusSecretRef } from '@txnet-backend/shared-core';

import { PanelCredentialWriter, PanelRegistrationService, PanelResubmitRefused } from './panel-registration';
import { registerPanelSchema } from './panel-registration.schema';
import { PanelScopeRefused } from './panel-scope';
import { SystemsRefused } from './systems-read';

const OWNER = '11111111-1111-4111-8111-111111111111';
const RESELLER = '22222222-2222-4222-8222-222222222222';
const ADMIN = '44444444-4444-4444-8444-444444444444';
const SECRET = '{"username":"root","password":"hunter2-panel"}';

const INPUT = {
  name: 'de-fra-1',
  ipAddress: '203.0.113.7',
  apiBaseUrl: 'https://panel.example.net:8443',
  driverType: DriverType.marzban,
  counterSemantics: CounterSemantics.cumulative,
  transport: PanelTransport.pull,
  role: PanelRole.active,
  region: 'eu-central',
  credentials: SECRET,
};

function harness(opts: { vaultFails?: boolean; secretFails?: boolean } = {}) {
  const panels: Array<Record<string, unknown>> = [];
  const tenants = new Map([
    [OWNER, TenantType.platform_owner],
    [RESELLER, TenantType.reseller],
  ]);
  const prisma = {
    tenant: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        tenants.has(where.id) ? { tenantType: tenants.get(where.id) } : null,
    },
  };
  // A platform panel has tenantId null, which RLS refuses on the scoped pool:
  // every panel write goes through the cross-tenant one.
  const all = {
    // No other panel holds the address (F-027-cd).
    $queryRaw: async () => [],
    panel: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        panels.push({ ...data });
        return data;
      },
      delete: async ({ where }: { where: { id: string } }) => {
        const i = panels.findIndex((p) => p['id'] === where.id);
        panels.splice(i, 1);
      },
    },
  };
  const written: Array<{ tenantId: string; panelId: string; credentials: string; actorId: string; secret?: PanelSecret }> = [];
  const vault: PanelCredentialWriter = {
    set: async (target, credentials, actorId, secret) => {
      if (opts.vaultFails || (opts.secretFails && secret === 'radius_secret')) throw new Error('tenant-service did not answer');
      written.push({ ...target, credentials, actorId, ...(secret ? { secret } : {}) });
      return { configured: true, version: 1, rotatedAt: '2026-09-24T10:00:00.000Z' };
    },
  };
  const service = new PanelRegistrationService(prisma as never, all as never, vault);
  return { service, panels, written };
}

describe('PanelRegistrationService.register', () => {
  it('refuses a tenant that is not the platform owner, before anything is written', async () => {
    const { service, panels, written } = harness();

    await expect(service.register({ adminId: ADMIN, tenantId: RESELLER }, INPUT)).rejects.toMatchObject({
      reason: 'not_platform_owner',
    });
    await expect(service.register({ adminId: ADMIN, tenantId: RESELLER }, INPUT)).rejects.toBeInstanceOf(
      PanelScopeRefused,
    );
    expect(panels).toHaveLength(0);
    expect(written).toHaveLength(0);
  });

  it('writes a pending platform panel whose credential column names the vault, never the secret', async () => {
    const { service, panels, written } = harness();

    const answer = await service.register({ adminId: ADMIN, tenantId: OWNER }, INPUT);

    expect(panels).toHaveLength(1);
    const row = panels[0];
    expect(row).toMatchObject({
      ownershipType: 'platform',
      tenantId: null,
      reviewState: 'pending',
      driverType: DriverType.marzban,
      apiBaseUrl: INPUT.apiBaseUrl,
    });
    expect(row['panelApiCredentials']).toBe(panelCredentialRef(OWNER, row['id'] as string));
    expect(JSON.stringify(row)).not.toContain('hunter2');

    // The owner's vault, under the panel's own label, with who did it.
    expect(written).toEqual([{ tenantId: OWNER, panelId: row["id"], credentials: SECRET, actorId: ADMIN, secret: "login" }]);
    expect(panelCredentialRef(OWNER, row['id'] as string)).toContain(panelCredentialLabel(row['id'] as string));

    expect(answer).toEqual({
      id: row['id'],
      reviewState: 'pending',
      credentials: { configured: true, version: 1, rotatedAt: '2026-09-24T10:00:00.000Z' },
    });
    expect(JSON.stringify(answer)).not.toContain('hunter2');
  });

  it('leaves no pending panel behind when the vault write fails', async () => {
    const { service, panels } = harness({ vaultFails: true });

    await expect(service.register({ adminId: ADMIN, tenantId: OWNER }, INPUT)).rejects.toThrow();
    expect(panels).toHaveLength(0);
  });
});

/**
 * A push panel (F-027-az): a REST login for its driver and a RADIUS secret for
 * its NAS, two vault references. One value cannot be both, and a panel that
 * reached the allowlist signed with its login would have every packet dropped
 * as forged, with nothing red anywhere.
 */
const RADIUS = 'nas-shared-hunter3';
const PUSH = {
  ...INPUT,
  apiBaseUrl: 'https://10.0.0.1/rest',
  driverType: DriverType.mikrotik_user_manager,
  counterSemantics: CounterSemantics.session,
  transport: PanelTransport.push,
  credentials: 'api:hunter2-rest',
  radiusSecret: RADIUS,
};

describe('PanelRegistrationService.register, push (F-027-az)', () => {
  it('writes both references and each secret under its own label, never one for the other', async () => {
    const { service, panels, written } = harness();
    const answer = await service.register({ adminId: ADMIN, tenantId: OWNER }, PUSH);

    const id = panels[0]['id'] as string;
    expect(panels[0]['panelApiCredentials']).toBe(panelCredentialRef(OWNER, id));
    expect(panels[0]['panelRadiusSecret']).toBe(panelRadiusSecretRef(OWNER, id));
    expect(JSON.stringify(panels[0])).not.toContain('hunter');
    expect(written).toEqual([
      { tenantId: OWNER, panelId: id, credentials: 'api:hunter2-rest', actorId: ADMIN, secret: 'login' },
      { tenantId: OWNER, panelId: id, credentials: RADIUS, actorId: ADMIN, secret: 'radius_secret' },
    ]);
    expect(answer).toMatchObject({ radiusSecret: { configured: true, version: 1 } });
    expect(JSON.stringify(answer)).not.toContain('hunter');
  });

  it('writes no secret reference on a pull panel', async () => {
    const { service, panels } = harness();
    await service.register({ adminId: ADMIN, tenantId: OWNER }, INPUT);
    expect(panels[0]['panelRadiusSecret']).toBeUndefined();
  });

  it('leaves no pending panel behind when the secret write fails after the login landed', async () => {
    const { service, panels } = harness({ secretFails: true });
    await expect(service.register({ adminId: ADMIN, tenantId: OWNER }, PUSH)).rejects.toThrow();
    expect(panels).toHaveLength(0);
  });
});

describe('registerPanelSchema, radiusSecret (F-027-az)', () => {
  const { radiusSecret: _drop, ...pushWithout } = PUSH;
  it('requires it on a push panel and refuses it on a pull panel', () => {
    expect(registerPanelSchema.safeParse(PUSH).success).toBe(true);
    expect(registerPanelSchema.safeParse(pushWithout).success).toBe(false);
    expect(registerPanelSchema.safeParse({ ...INPUT, radiusSecret: RADIUS }).success).toBe(false);
  });
});

/**
 * A client base url (F-027-bg): where a family that serves its users' links
 * apart from its API (Hiddify's client proxy path) serves them. Optional, and
 * a push panel has no API to serve them beside.
 */
const HIDDIFY = {
  ...INPUT,
  apiBaseUrl: 'https://panel.example.net/adm1n',
  clientBaseUrl: 'https://cdn.example.net/cl1ent',
  driverType: DriverType.hiddify,
  credentials: '0f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0',
};

describe('registerPanelSchema and register, clientBaseUrl (F-027-bg)', () => {
  it('is optional on a pull panel and refused on a push panel', () => {
    expect(registerPanelSchema.safeParse(HIDDIFY).success).toBe(true);
    expect(registerPanelSchema.safeParse(INPUT).success).toBe(true);
    expect(registerPanelSchema.safeParse({ ...HIDDIFY, clientBaseUrl: 'cl1ent' }).success).toBe(false);
    const push = registerPanelSchema.safeParse({ ...PUSH, clientBaseUrl: 'https://cdn.example.net/cl1ent' });
    expect(push.success ? null : push.error.issues.map((i) => i.path.join('.'))).toEqual(['clientBaseUrl']);
  });

  it('writes it to the row, and null when none was given', async () => {
    const { service, panels } = harness();
    await service.register({ adminId: ADMIN, tenantId: OWNER }, HIDDIFY);
    await service.register({ adminId: ADMIN, tenantId: OWNER }, INPUT);
    expect(panels.map((p) => p['clientBaseUrl'])).toEqual(['https://cdn.example.net/cl1ent', null]);
  });
});

describe('PanelRegistrationService.resubmitRadiusSecret (F-027-az)', () => {
  const PANEL = '55555555-5555-4555-8555-555555555555';
  type Row = { id: string; transport: PanelTransport; reviewState: PanelReviewState; panelRadiusSecret: string | null };

  function rotating(row: Partial<Row> | null, opts: { vaultFails?: boolean } = {}) {
    const panel: Row | null = row && {
      id: PANEL,
      transport: PanelTransport.push,
      reviewState: PanelReviewState.accepted,
      panelRadiusSecret: panelRadiusSecretRef(OWNER, PANEL),
      ...row,
    };
    const updates: Array<Record<string, unknown>> = [];
    const prisma = {
      tenant: { findUnique: async ({ where }: { where: { id: string } }) => ({ tenantType: where.id === OWNER ? TenantType.platform_owner : TenantType.reseller }) },
      panel: {
        findFirst: async ({ where }: { where: { id: string } }) => (panel && panel.id === where.id ? { ...panel } : null),
      },
    };
    const all = {
      panel: {
        update: async ({ data }: { data: Record<string, unknown> }) => {
          updates.push(data);
          Object.assign(panel as Row, data);
        },
        updateMany: async (args: Record<string, unknown>) => {
          updates.push(args);
          return { count: 0 };
        },
      },
    };
    const written: Array<{ credentials: string; secret?: PanelSecret }> = [];
    const vault: PanelCredentialWriter = {
      set: async (_t, credentials, _a, secret) => {
        if (opts.vaultFails) throw new Error('tenant-service did not answer');
        written.push({ credentials, secret });
        return { configured: true, version: 2, rotatedAt: '2026-09-24T10:00:00.000Z' };
      },
    };
    return { service: new PanelRegistrationService(prisma as never, all as never, vault), panel, updates, written };
  }
  const actor = { adminId: ADMIN, tenantId: OWNER };

  it('rotates an accepted panel\'s secret and leaves its review and its last test alone', async () => {
    const { service, updates, written } = rotating({});
    const out = await service.resubmitRadiusSecret(actor, PANEL, RADIUS);
    expect(written).toEqual([{ credentials: RADIUS, secret: 'radius_secret' }]);
    expect(updates).toHaveLength(0);
    expect(out).toEqual({ id: PANEL, reviewState: PanelReviewState.accepted, radiusSecret: { configured: true, version: 2, rotatedAt: '2026-09-24T10:00:00.000Z' } });
  });

  it('gives a push panel registered before its reference existed one, after the vault answered', async () => {
    const { service, panel, updates } = rotating({ panelRadiusSecret: null });
    await service.resubmitRadiusSecret(actor, PANEL, RADIUS);
    expect(updates).toEqual([{ panelRadiusSecret: panelRadiusSecretRef(OWNER, PANEL) }]);
    expect(panel?.panelRadiusSecret).toBe(panelRadiusSecretRef(OWNER, PANEL));
  });

  it('writes no reference when the vault fails', async () => {
    const { service, updates } = rotating({ panelRadiusSecret: null }, { vaultFails: true });
    await expect(service.resubmitRadiusSecret(actor, PANEL, RADIUS)).rejects.toThrow('tenant-service did not answer');
    expect(updates).toHaveLength(0);
  });

  it('refuses a pull panel, which has no NAS, and a refused panel, and writes nothing', async () => {
    for (const [row, reason] of [
      [{ transport: PanelTransport.pull, panelRadiusSecret: null }, 'panel_not_push'],
      [{ reviewState: PanelReviewState.refused }, 'panel_refused'],
    ] as const) {
      const { service, written } = rotating(row);
      await expect(service.resubmitRadiusSecret(actor, PANEL, RADIUS)).rejects.toMatchObject({ reason });
      await expect(service.resubmitRadiusSecret(actor, PANEL, RADIUS)).rejects.toBeInstanceOf(PanelResubmitRefused);
      expect(written).toHaveLength(0);
    }
  });

  it('is not_found for a panel outside the scope', async () => {
    const { service } = rotating(null);
    await expect(service.resubmitRadiusSecret(actor, PANEL, RADIUS)).rejects.toBeInstanceOf(SystemsRefused);
  });
});

/**
 * The panel's IP (F-027-br): only a push panel's is ever read — it is the
 * NAS's allowlist entry (network `contract.collection.md`). A pull panel is
 * reached at `apiBaseUrl`, so asking it for an address nothing reads only
 * gets a guess typed in.
 */
describe('registerPanelSchema and register, ipAddress (F-027-br)', () => {
  const { ipAddress: _dropPull, ...pullWithout } = INPUT;
  const { ipAddress: _dropPush, ...pushWithout } = PUSH;

  it('is optional on a pull panel, and still checked when sent', () => {
    expect(registerPanelSchema.safeParse(pullWithout).success).toBe(true);
    expect(registerPanelSchema.safeParse(INPUT).success).toBe(true);
    const bad = registerPanelSchema.safeParse({ ...INPUT, ipAddress: 'example.net' });
    expect(bad.success ? null : bad.error.issues.map((i) => i.path.join('.'))).toEqual(['ipAddress']);
  });

  it('is required on a push panel, naming the field', () => {
    const out = registerPanelSchema.safeParse(pushWithout);
    expect(out.success ? null : out.error.issues.map((i) => i.path.join('.'))).toEqual(['ipAddress']);
  });

  it('writes null for a pull panel registered without one', async () => {
    const { service, panels } = harness();
    await service.register({ adminId: ADMIN, tenantId: OWNER }, pullWithout);
    expect(panels[0]['ipAddress']).toBeNull();
  });
});
