/**
 * A panel is registered once (F-027-cd, ADR-0090 decision 1). What would break silently:
 *
 *  - **one panel read twice.** Two rows over one panel each list every client
 *    on it, call the other's orphans and, under `delete_remote`, delete them.
 *    Registration and an address edit are refused while another panel holds
 *    the same normalised `apiBaseUrl`, and the refusal names that panel so the
 *    owner edits or restores it instead — only when it is the actor's to see:
 *    another owner's panel still refuses, unnamed;
 *  - **a panel refused by its own address.** An edit that re-sends (or
 *    re-spells) the address the panel already has is not a duplicate;
 *  - **the race.** Two registrations of one address at once both pass the
 *    look-up; the database's `panel_api_address_key` refuses the second, and
 *    that must answer the same refusal, not a 500.
 *
 * A push panel's `ipAddress` is registered once too (F-027-ff, ADR-0130
 * decision 5): two push panels at one IP drop each other off the RADIUS
 * allowlist, across tenants. Register, edit and restore are refused the same
 * way; an archived panel holds no IP, so restoring it is where a clash shows.
 *
 * The normalisers themselves are SQL (`network.panel_api_address`,
 * `network.panel_push_address`), each shared by its index and its look-up, so
 * this spec sees only what the look-up answers.
 */
import {
  CounterSemantics,
  DriverType,
  PanelReviewState,
  PanelRole,
  PanelTransport,
  Prisma,
  TenantType,
} from '@prisma/client';

import { PanelAlreadyRegistered } from './panel-address';
import { PanelLifecycleService } from './panel-lifecycle';
import { PanelRegistrationService } from './panel-registration';

const OWNER = '11111111-1111-4111-8111-111111111111';
const ADMIN = '44444444-4444-4444-8444-444444444444';
const PANEL = '55555555-5555-4555-8555-555555555555';
const RESELLER = '22222222-2222-4222-8222-222222222222';
/** The look-up's row: the holder and whose it is. */
const HOLDER_ROW = { id: '66666666-6666-4666-8666-666666666666', name: 'de-fra-1', ownershipType: 'platform', tenantId: null };
/** What the refusal names: the holder's id and name, nothing else. */
const HOLDER = { id: HOLDER_ROW.id, name: HOLDER_ROW.name };

const actor = { adminId: ADMIN, tenantId: OWNER };
const duplicateKey = () =>
  new Prisma.PrismaClientKnownRequestError('duplicate', {
    code: 'P2002',
    clientVersion: 'test',
    meta: { target: 'panel_api_address_key' },
  });

/** `holders` answers the look-up, one answer per call; `write` throws what the database would. */
function harness(
  opts: {
    holders?: Array<typeof HOLDER_ROW | { id: string; name: string; ownershipType: string; tenantId: string } | undefined>;
    write?: () => void;
    /** What the edited or restored panel reads as; a pull panel by default. */
    panel?: Record<string, unknown>;
  } = {},
) {
  const lookups: unknown[][] = [];
  const holders = [...(opts.holders ?? [])];
  const writes: unknown[] = [];
  const prisma = {
    tenant: {
      findUnique: async () => ({ tenantType: TenantType.platform_owner }),
    },
  };
  const all = {
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      lookups.push(values);
      const holder = holders.shift();
      return holder ? [holder] : [];
    },
    // Panels are read on the cross-tenant pool, the scope in the where (BYO-1-b).
    panel: {
      findFirst: async () => ({
        transport: PanelTransport.pull,
        driverType: DriverType.sanaee,
        reviewState: PanelReviewState.accepted,
        apiBaseUrl: 'https://fra.example.com:2053/panel',
        clientBaseUrl: null,
        ipAddress: null,
        retiredAt: null,
        ...opts.panel,
      }),
      create: async (args: unknown) => {
        opts.write?.();
        writes.push(args);
      },
      updateMany: async (args: unknown) => {
        opts.write?.();
        writes.push(args);
        return { count: 1 };
      },
      delete: async () => undefined,
    },
  };
  const vault = {
    set: async () => ({
      configured: true,
      version: 1,
      rotatedAt: '2026-09-26T00:00:00.000Z',
    }),
  };
  return {
    registration: new PanelRegistrationService(
      prisma as never,
      all as never,
      vault,
    ),
    lifecycle: new PanelLifecycleService(prisma as never, all as never),
    lookups,
    writes,
  };
}

const registerInput = (apiBaseUrl: string) => ({
  name: 'de-fra-2',
  apiBaseUrl,
  driverType: DriverType.sanaee,
  counterSemantics: CounterSemantics.cumulative,
  transport: PanelTransport.pull,
  role: PanelRole.active,
  region: 'de',
  credentials: 'admin:secret',
});

async function refusal(
  work: Promise<unknown>,
): Promise<PanelAlreadyRegistered> {
  const e = await work.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(PanelAlreadyRegistered);
  return e as PanelAlreadyRegistered;
}

describe('a panel address is registered once (F-027-cd)', () => {
  it('registering an address another panel holds is refused, naming that panel, and nothing is written', async () => {
    const { registration, writes, lookups } = harness({ holders: [HOLDER_ROW] });
    const e = await refusal(
      registration.register(
        actor,
        registerInput('https://FRA.example.com/panel/'),
      ),
    );
    expect(e.reason).toBe('panel_already_registered');
    expect(e.panel).toEqual(HOLDER);
    expect(writes).toEqual([]);
    expect(lookups[0]).toContain('https://FRA.example.com/panel/');
  });

  it('a free address registers', async () => {
    const { registration, writes } = harness();
    const answer = await registration.register(
      actor,
      registerInput('https://fra2.example.com:2053/panel'),
    );
    expect(answer.reviewState).toBe(PanelReviewState.pending);
    expect(writes).toHaveLength(1);
  });

  it('the concurrent second registration, refused by the index, answers the same refusal', async () => {
    const { registration } = harness({
      holders: [undefined, HOLDER_ROW],
      write: () => {
        throw duplicateKey();
      },
    });
    const e = await refusal(
      registration.register(
        actor,
        registerInput('https://fra.example.com/panel'),
      ),
    );
    expect(e.panel).toEqual(HOLDER);
  });

  it('editing an address onto another panel is refused, naming it, and the panel is untouched', async () => {
    const { lifecycle, writes, lookups } = harness({ holders: [HOLDER_ROW] });
    const e = await refusal(
      lifecycle.update(actor, PANEL, {
        apiBaseUrl: 'https://fra.example.com/panel',
      }),
    );
    expect(e.panel).toEqual(HOLDER);
    expect(writes).toEqual([]);
    // The look-up leaves the panel itself out: re-spelling its own address is no duplicate.
    expect(lookups[0]).toContain(PANEL);
  });

  it('an edit that loses the race to the index answers the same refusal', async () => {
    const { lifecycle } = harness({
      holders: [undefined, HOLDER_ROW],
      write: () => {
        throw duplicateKey();
      },
    });
    const e = await refusal(
      lifecycle.update(actor, PANEL, {
        apiBaseUrl: 'https://fra3.example.com/panel',
      }),
    );
    expect(e.panel).toEqual(HOLDER);
  });

  it("a holder outside the actor's scope still refuses, but is not named", async () => {
    // Uniqueness is every owner's; the holder's name is only for whoever may see it.
    const { registration, lifecycle, writes } = harness({
      holders: [
        { id: '77777777-7777-4777-8777-777777777777', name: 'their-own', ownershipType: 'tenant', tenantId: RESELLER },
        { id: '77777777-7777-4777-8777-777777777777', name: 'their-own', ownershipType: 'tenant', tenantId: RESELLER },
      ],
    });
    const registered = await refusal(registration.register(actor, registerInput('https://their.example.com/panel')));
    const edited = await refusal(lifecycle.update(actor, PANEL, { apiBaseUrl: 'https://their.example.com/panel' }));
    for (const e of [registered, edited]) {
      expect(e.reason).toBe('panel_already_registered');
      expect(e.panel).toBeNull();
    }
    expect(writes).toEqual([]);
  });

  it('an edit that changes no address is not looked up', async () => {
    const { lifecycle, lookups } = harness({ holders: [HOLDER_ROW] });
    await lifecycle.update(actor, PANEL, { name: 'de-fra-main' });
    expect(lookups).toEqual([]);
  });
});

const PUSH_IP = '203.0.113.7';
const registerPush = (ipAddress: string) => ({
  ...registerInput(''),
  apiBaseUrl: null,
  transport: PanelTransport.push,
  ipAddress,
  radiusSecret: 's',
});
const pushPanel = (over: Record<string, unknown> = {}) => ({
  transport: PanelTransport.push,
  driverType: DriverType.mikrotik_user_manager,
  apiBaseUrl: null,
  ipAddress: PUSH_IP,
  ...over,
});

describe("a push panel's ipAddress is registered once (F-027-ff)", () => {
  it('registering an IP another push panel holds is refused, naming it, and nothing is written', async () => {
    const { registration, writes, lookups } = harness({ holders: [HOLDER_ROW] });
    const e = await refusal(registration.register(actor, registerPush(PUSH_IP)));
    expect(e.reason).toBe('panel_already_registered');
    expect(e.panel).toEqual(HOLDER);
    expect(writes).toEqual([]);
    expect(lookups[0]).toContain(PUSH_IP);
  });

  it('a free IP registers', async () => {
    const { registration, writes, lookups } = harness();
    await registration.register(actor, registerPush('203.0.113.8'));
    expect(lookups).toHaveLength(1);
    expect(writes).toHaveLength(1);
  });

  it('the concurrent second registration, refused by the index, answers the same refusal', async () => {
    const { registration } = harness({
      holders: [undefined, HOLDER_ROW],
      write: () => {
        throw duplicateKey();
      },
    });
    expect((await refusal(registration.register(actor, registerPush(PUSH_IP)))).panel).toEqual(HOLDER);
  });

  it("a holder outside the actor's scope still refuses, but is not named", async () => {
    const { registration } = harness({
      holders: [{ id: '77777777-7777-4777-8777-777777777777', name: 'their-own', ownershipType: 'tenant', tenantId: RESELLER }],
    });
    expect((await refusal(registration.register(actor, registerPush(PUSH_IP)))).panel).toBeNull();
  });

  it('editing the IP onto another push panel is refused, and the panel is untouched', async () => {
    const { lifecycle, writes, lookups } = harness({ holders: [HOLDER_ROW], panel: pushPanel() });
    const e = await refusal(lifecycle.update(actor, PANEL, { ipAddress: '203.0.113.9' }));
    expect(e.panel).toEqual(HOLDER);
    expect(writes).toEqual([]);
    expect(lookups[0]).toEqual(expect.arrayContaining(['203.0.113.9', PANEL]));
  });

  it('an edit that keeps its own IP is not looked up', async () => {
    const { lifecycle, lookups } = harness({ holders: [HOLDER_ROW], panel: pushPanel() });
    await lifecycle.update(actor, PANEL, { ipAddress: PUSH_IP, name: 'mt-1' });
    expect(lookups).toEqual([]);
  });

  it('restoring an archived push panel whose IP another one now holds is refused, and it stays archived', async () => {
    const { lifecycle, writes } = harness({ holders: [HOLDER_ROW], panel: pushPanel({ retiredAt: new Date('2026-10-01T00:00:00Z') }) });
    expect((await refusal(lifecycle.restore(actor, PANEL))).panel).toEqual(HOLDER);
    expect(writes).toEqual([]);
  });

  it('restoring a pull panel looks up no IP', async () => {
    const { lifecycle, lookups, writes } = harness({ holders: [HOLDER_ROW], panel: { retiredAt: new Date('2026-10-01T00:00:00Z') } });
    await lifecycle.restore(actor, PANEL);
    expect(lookups).toEqual([]);
    expect(writes).toHaveLength(1);
  });
});
