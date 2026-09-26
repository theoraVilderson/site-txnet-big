/**
 * A panel is registered once (F-027-cd, ADR-0090 decision 1). What would break silently:
 *
 *  - **one panel read twice.** Two rows over one panel each list every client
 *    on it, call the other's orphans and, under `delete_remote`, delete them.
 *    Registration and an address edit are refused while another panel holds
 *    the same normalised `apiBaseUrl`, and the refusal names that panel so the
 *    owner edits or restores it instead;
 *  - **a panel refused by its own address.** An edit that re-sends (or
 *    re-spells) the address the panel already has is not a duplicate;
 *  - **the race.** Two registrations of one address at once both pass the
 *    look-up; the database's `panel_api_address_key` refuses the second, and
 *    that must answer the same refusal, not a 500.
 *
 * The normaliser itself is SQL (`network.panel_api_address`), shared by the
 * index and the look-up, so this spec sees only what the look-up answers.
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
const HOLDER = { id: '66666666-6666-4666-8666-666666666666', name: 'de-fra-1' };

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
    holders?: Array<{ id: string; name: string } | undefined>;
    write?: () => void;
  } = {},
) {
  const lookups: unknown[][] = [];
  const holders = [...(opts.holders ?? [])];
  const writes: unknown[] = [];
  const prisma = {
    tenant: {
      findUnique: async () => ({ tenantType: TenantType.platform_owner }),
    },
    panel: {
      findFirst: async () => ({
        transport: PanelTransport.pull,
        driverType: DriverType.sanaee,
        reviewState: PanelReviewState.accepted,
        apiBaseUrl: 'https://fra.example.com:2053/panel',
        clientBaseUrl: null,
        retiredAt: null,
      }),
    },
  };
  const all = {
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      lookups.push(values);
      const holder = holders.shift();
      return holder ? [holder] : [];
    },
    panel: {
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
    const { registration, writes, lookups } = harness({ holders: [HOLDER] });
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

  it('a push panel has no address to hold and is not looked up', async () => {
    const { registration, lookups } = harness({ holders: [HOLDER] });
    await registration.register(actor, {
      ...registerInput(''),
      apiBaseUrl: null,
      transport: PanelTransport.push,
      ipAddress: '10.0.0.1',
      radiusSecret: 's',
    });
    expect(lookups).toEqual([]);
  });

  it('the concurrent second registration, refused by the index, answers the same refusal', async () => {
    const { registration } = harness({
      holders: [undefined, HOLDER],
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
    const { lifecycle, writes, lookups } = harness({ holders: [HOLDER] });
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
      holders: [undefined, HOLDER],
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

  it('an edit that changes no address is not looked up', async () => {
    const { lifecycle, lookups } = harness({ holders: [HOLDER] });
    await lifecycle.update(actor, PANEL, { name: 'de-fra-main' });
    expect(lookups).toEqual([]);
  });
});
