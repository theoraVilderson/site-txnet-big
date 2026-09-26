/**
 * A user's own configs (F-027-ac): `GET /api/billing/traffic/grants/:grantId/configs`
 * and `POST /api/billing/traffic/configs/actions`.
 *
 * Three things about them fail silently, and each is asserted here:
 *
 *  - **a bulk action is per config** (user, 2026-09-23). One refused config —
 *    at its regenerate limit, retired meanwhile — must not stop the others,
 *    and every config's outcome is answered, so the page never has to guess
 *    which one was refused. A throw that is not a refusal is an outcome too:
 *    the configs before it are committed and have to be reported;
 *  - **whose configs.** The actor is the gate's user, so another user's
 *    config reads as `config_not_found` and another user's Grant as a 404;
 *  - **the bare credential stays out of the list.** A config's `uuid` is read
 *    only to tell whether its captured lines are its current client's; it is
 *    never answered. The lines themselves are the owner's (F-307-a) — `/sub`
 *    already hands them out — but only lines captured from the client the
 *    config is now: a regenerate makes the old ones dead links.
 */
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { NotFoundException } from '@nestjs/common';
import { ActorType, ConfigProtocol, ConfigStatus, DriftState, DriverType, EnforcementState } from '@prisma/client';
import { RATE_LIMIT_KEY, RateLimitBucket, type RateLimitOptions, runWithTenant } from '@txnet-backend/shared-core';

import { ConfigActionRefused } from './config-actions';
import { CONFIG_ACTION_FAILED, MAX_BULK_CONFIGS, UserConfigsService } from './user-configs';
import { UserConfigsController } from './user-configs.controller';
import { configActionSchema, configLabelSchema } from './user-configs.schema';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '44444444-4444-4444-8444-444444444444';
const GRANT = '22222222-2222-4222-8222-222222222222';
const C1 = '55555555-5555-4555-8555-555555555501';
const C2 = '55555555-5555-4555-8555-555555555502';
const C3 = '55555555-5555-4555-8555-555555555503';

const req = (userId: string) => ({ identity: { userId, tenantId: TENANT, roleId: 'r', sessionId: 's', permissions: [] } });

function configRow(overrides: Record<string, unknown> = {}) {
  return {
    id: C1,
    protocol: ConfigProtocol.vless,
    status: ConfigStatus.active,
    allocatedCeilingBytes: BigInt('1073741824'),
    appliedCeilingBytes: BigInt('536870912'),
    driftState: DriftState.limit_overridden,
    enforcementState: EnforcementState.partial,
    regenerateUsedCount: 1,
    maxRegenerateCount: 3,
    lastReconciledAt: new Date('2026-09-23T10:00:00Z'),
    uuid: 'uuid-now',
    linksUuid: 'uuid-now' as string | null,
    linkLines: ['vless://uuid-now@de.example:443?type=tcp#de-1'],
    linksRemoteId: 'remote-now' as string | null,
    linksCapturedAt: new Date('2026-09-23T09:00:00Z') as Date | null,
    userLabel: null as string | null,
    panel: { region: 'de-fra', driverType: DriverType.marzban as DriverType, ovpnProfile: null as string | null },
    ...overrides,
  };
}

type Branding = { brandName: string; lineNameTemplate: string | null } | null;

function build(
  opts: { grant?: { id: string; tenantId: string } | null; configs?: ReturnType<typeof configRow>[]; updated?: number; branding?: Branding } = {},
) {
  const asked: {
    grantWhere?: unknown;
    brandingWhere?: unknown;
    configWhere?: unknown;
    select?: unknown;
    orderBy?: unknown;
    updateWhere?: unknown;
    updateData?: unknown;
    transactions: number;
  } = { transactions: 0 };
  const tx = {
    $executeRaw: async () => 0,
    grant: {
      findFirst: async (args: { where: unknown }) => {
        asked.grantWhere = args.where;
        return opts.grant === undefined ? { id: GRANT, tenantId: TENANT } : opts.grant;
      },
    },
    tenantBranding: {
      findUnique: async (args: { where: unknown }) => {
        asked.brandingWhere = args.where;
        return opts.branding ?? null;
      },
    },
    config: {
      updateMany: async (args: { where: unknown; data: unknown }) => {
        asked.updateWhere = args.where;
        asked.updateData = args.data;
        return { count: opts.updated ?? 1 };
      },
      findMany: async (args: { where: unknown; select: unknown; orderBy: unknown }) => {
        asked.configWhere = args.where;
        asked.select = args.select;
        asked.orderBy = args.orderBy;
        return opts.configs ?? [configRow()];
      },
    },
  };
  const prisma = {
    $transaction: (fn: (t: typeof tx) => unknown) => {
      asked.transactions += 1;
      return fn(tx);
    },
  };
  const actions = {
    regenerate: vi.fn(async (_tx: unknown, _input: { configId: string }) => ({ uuid: 'u', regenerateUsedCount: 2 })),
    retire: vi.fn(async (_tx: unknown, _input: { configId: string }): Promise<void> => undefined),
  };
  const service = new UserConfigsService(prisma as never, actions as never);
  const inTenant = <T>(fn: () => Promise<T>) => runWithTenant({ id: TENANT }, fn);
  return { service, actions, asked, inTenant };
}

describe('UserConfigsService.listForGrant', () => {
  it('answers the Grant’s live configs with their ceiling and verdict, oldest first', async () => {
    const { service, asked, inTenant } = build();

    const rows = await inTenant(() => service.listForGrant(USER, GRANT));

    expect(asked.grantWhere).toEqual({ id: GRANT, userId: USER });
    // Retired is what the user deleted: gone from their view.
    expect(asked.configWhere).toEqual({ grantId: GRANT, userId: USER, status: { not: ConfigStatus.retired } });
    expect(asked.orderBy).toEqual([{ createdAt: 'asc' }, { id: 'asc' }]);
    expect(rows).toEqual([
      {
        id: C1,
        protocol: ConfigProtocol.vless,
        status: ConfigStatus.active,
        region: 'de-fra',
        allocatedCeilingBytes: '1073741824',
        appliedCeilingBytes: '536870912',
        driftState: DriftState.limit_overridden,
        enforcementState: EnforcementState.partial,
        regenerateUsedCount: 1,
        maxRegenerateCount: 3,
        lastReconciledAt: '2026-09-23T10:00:00.000Z',
        label: null,
        // Named by the platform template, the panel's region (ADR-0089).
        lines: ['vless://uuid-now@de.example:443?type=tcp#de-fra'],
        linksCapturedAt: '2026-09-23T09:00:00.000Z',
        login: null,
        ovpnProfile: null,
      },
    ]);
  });

  it('names lines by the buyer’s label, numbering over the whole Grant, and skips dead lines when numbering', async () => {
    const line = (h: string) => `vless://uuid-now@${h}:443?type=tcp#raw`;
    const { service, inTenant } = build({
      configs: [
        configRow({ id: C1, userLabel: 'خانه', linkLines: [line('a'), line('b')] }),
        configRow({ id: C2, uuid: 'uuid-new', linkLines: [line('dead')] }),
        configRow({ id: C3, linkLines: [line('c')] }),
      ],
    });
    const rows = await inTenant(() => service.listForGrant(USER, GRANT));
    expect(rows.map((r) => [r.label, r.lines])).toEqual([
      ['خانه', [`${line('a').replace('#raw', '')}#${encodeURIComponent('خانه')}`, `${line('b').replace('#raw', '')}#${encodeURIComponent('خانه 2')}`]],
      [null, []],
      [null, [line('c').replace('#raw', '#de-fra')]],
    ]);
  });

  it('names lines the buyer did not name by the reseller’s template (F-307-j), read by the Grant’s tenant', async () => {
    const line = (h: string) => `vless://uuid-now@${h}:443?type=tcp#raw`;
    const { service, asked, inTenant } = build({
      branding: { brandName: 'Nova', lineNameTemplate: '{brand} · {region}' },
      configs: [configRow({ id: C1, linkLines: [line('a')] }), configRow({ id: C2, userLabel: 'خانه', linkLines: [line('b')] })],
    });
    const rows = await inTenant(() => service.listForGrant(USER, GRANT));
    expect(asked.brandingWhere).toEqual({ tenantId: TENANT });
    expect(rows.map((r) => r.lines)).toEqual([
      [line('a').replace('#raw', `#${encodeURIComponent('Nova · de-fra')}`)],
      [line('b').replace('#raw', `#${encodeURIComponent('خانه')}`)],
    ]);
  });

  it('never answers the bare uuid, though it reads it to judge the lines', async () => {
    const { service, asked, inTenant } = build();
    const [row] = await inTenant(() => service.listForGrant(USER, GRANT));
    expect(row).not.toHaveProperty('uuid');
    expect(row).not.toHaveProperty('linksUuid');
    expect(JSON.stringify(asked.select)).not.toContain('Credentials');
  });

  it('answers no lines captured from a client the config no longer is: a regenerate makes them dead links', async () => {
    const { service, inTenant } = build({ configs: [configRow({ uuid: 'uuid-new', linksUuid: 'uuid-now' })] });
    const [row] = await inTenant(() => service.listForGrant(USER, GRANT));
    expect(row.lines).toEqual([]);
    expect(row.linksCapturedAt).toBeNull();
  });

  it('answers a never-captured config as no lines and no capture time', async () => {
    const { service, inTenant } = build({ configs: [configRow({ linksUuid: null, linkLines: [], linksCapturedAt: null })] });
    const [row] = await inTenant(() => service.listForGrant(USER, GRANT));
    expect(row.lines).toEqual([]);
    expect(row.linksCapturedAt).toBeNull();
  });

  it('answers a panel that gives no lines as captured and empty', async () => {
    const { service, inTenant } = build({ configs: [configRow({ linkLines: [] })] });
    const [row] = await inTenant(() => service.listForGrant(USER, GRANT));
    expect(row.lines).toEqual([]);
    expect(row.linksCapturedAt).toBe('2026-09-23T09:00:00.000Z');
  });

  describe('a User Manager login (F-307-d, user 2026-09-26)', () => {
    const PROFILE = 'client\ndev tun\nproto tcp\nremote vpn.arianet.example 1194\nauth-user-pass\n<ca>\n…\n</ca>\n';
    const um = (overrides: Record<string, unknown> = {}) =>
      configRow({
        protocol: ConfigProtocol.openvpn,
        uuid: 'a1b2-c3d4',
        linksUuid: 'a1b2-c3d4',
        linksRemoteId: 'a1b2c3d4',
        linkLines: [],
        panel: { region: 'ir-thr', driverType: DriverType.mikrotik_user_manager, ovpnProfile: PROFILE },
        ...overrides,
      });

    it('answers the owner the login the router confirmed, and the router’s .ovpn for an OpenVPN config', async () => {
      const { service, inTenant } = build({ configs: [um()] });
      const [row] = await inTenant(() => service.listForGrant(USER, GRANT));
      expect(row.login).toEqual({ username: 'a1b2c3d4', password: 'a1b2-c3d4' });
      expect(row.ovpnProfile).toBe(PROFILE);
    });

    it('answers a PPPoE config its login and no file', async () => {
      const { service, inTenant } = build({ configs: [um({ protocol: ConfigProtocol.pppoe })] });
      const [row] = await inTenant(() => service.listForGrant(USER, GRANT));
      expect(row.login).toEqual({ username: 'a1b2c3d4', password: 'a1b2-c3d4' });
      expect(row.ovpnProfile).toBeNull();
    });

    it('answers no login while a regenerate waits for the router to confirm the new one', async () => {
      const { service, inTenant } = build({ configs: [um({ uuid: 'e5f6-a7b8' })] });
      const [row] = await inTenant(() => service.listForGrant(USER, GRANT));
      // The old password is refused by the router already; the new one is not there yet.
      expect(row.login).toBeNull();
      expect(row.ovpnProfile).toBeNull();
    });

    it('answers no file for a router whose admin uploaded none', async () => {
      const { service, inTenant } = build({ configs: [um({ panel: { region: 'ir-thr', driverType: DriverType.mikrotik_user_manager, ovpnProfile: null } })] });
      const [row] = await inTenant(() => service.listForGrant(USER, GRANT));
      expect(row.login).not.toBeNull();
      expect(row.ovpnProfile).toBeNull();
    });

    it('never answers the uuid of any other family, whose credential is inside its lines', async () => {
      const { service, inTenant } = build({ configs: [configRow({ protocol: ConfigProtocol.vless })] });
      const [row] = await inTenant(() => service.listForGrant(USER, GRANT));
      expect(row.login).toBeNull();
      expect(JSON.stringify(row)).not.toContain('"uuid-now"');
    });
  });

  it('refuses another user’s Grant exactly as a missing one', async () => {
    const { service, inTenant } = build({ grant: null });
    await expect(inTenant(() => service.listForGrant(USER, GRANT))).rejects.toMatchObject({ reason: 'grant_not_found' });
  });
});

describe('UserConfigsService.setLabel (F-307-g)', () => {
  it('writes only the label, on the gate’s user’s own live config', async () => {
    const { service, asked, inTenant } = build();
    await inTenant(() => service.setLabel(USER, C1, 'خانه'));
    expect(asked.updateWhere).toEqual({ id: C1, userId: USER, status: { not: ConfigStatus.retired } });
    // Display only: nothing for the panel, no desired state touched.
    expect(asked.updateData).toEqual({ userLabel: 'خانه' });
  });

  it('refuses another user’s, a retired or a missing config as `config_not_found`', async () => {
    const { service, inTenant } = build({ updated: 0 });
    await expect(inTenant(() => service.setLabel(USER, C1, null))).rejects.toMatchObject({ reason: 'config_not_found' });
  });
});

describe('UserConfigsService.act', () => {
  it('runs each config in its own transaction, as the gate’s user', async () => {
    const { service, actions, asked, inTenant } = build();

    const results = await inTenant(() => service.act(USER, 'retire', [C1, C2]));

    expect(asked.transactions).toBe(2);
    expect(actions.retire).toHaveBeenCalledWith(expect.anything(), { configId: C1, actor: { actorType: ActorType.user, actorId: USER } });
    expect(results).toEqual([
      { configId: C1, ok: true },
      { configId: C2, ok: true },
    ]);
  });

  it('does not let one refusal stop the others, and names every outcome', async () => {
    const { service, actions, inTenant } = build();
    actions.regenerate.mockImplementation(async (_tx: unknown, input: { configId: string }) => {
      if (input.configId === C2) throw new ConfigActionRefused('regenerate_limit_reached', '3/3');
      return { uuid: 'u', regenerateUsedCount: 1 };
    });

    const results = await inTenant(() => service.act(USER, 'regenerate', [C1, C2, C3]));

    expect(results).toEqual([
      { configId: C1, ok: true },
      { configId: C2, ok: false, reason: 'regenerate_limit_reached' },
      { configId: C3, ok: true },
    ]);
  });

  it('reports a throw that is not a refusal as `failed`, after committing the ones before it', async () => {
    const { service, actions, inTenant } = build();
    actions.retire.mockImplementationOnce(async () => undefined).mockImplementationOnce(async () => {
      throw new Error('connection reset');
    });

    const results = await inTenant(() => service.act(USER, 'retire', [C1, C2]));

    expect(results).toEqual([
      { configId: C1, ok: true },
      { configId: C2, ok: false, reason: CONFIG_ACTION_FAILED },
    ]);
  });

  it('acts once on an id named twice — a second regenerate would spend another of three', async () => {
    const { service, actions, inTenant } = build();
    const results = await inTenant(() => service.act(USER, 'regenerate', [C1, C1]));
    expect(actions.regenerate).toHaveBeenCalledTimes(1);
    expect(results).toHaveLength(1);
  });
});

describe('configActionSchema', () => {
  it('takes the two user actions on one to fifty config ids', () => {
    expect(configActionSchema.parse({ action: 'retire', configIds: [C1] })).toEqual({ action: 'retire', configIds: [C1] });
    expect(configActionSchema.safeParse({ action: 'disable', configIds: [C1] }).success).toBe(false);
    expect(configActionSchema.safeParse({ action: 'move', configIds: [C1] }).success).toBe(false);
    expect(configActionSchema.safeParse({ action: 'retire', configIds: [] }).success).toBe(false);
    expect(configActionSchema.safeParse({ action: 'retire', configIds: ['nope'] }).success).toBe(false);
    const tooMany = Array.from({ length: MAX_BULK_CONFIGS + 1 }, () => C1);
    expect(configActionSchema.safeParse({ action: 'retire', configIds: tooMany }).success).toBe(false);
  });
});

describe('configLabelSchema', () => {
  it('trims a label, and reads an empty one as the default', () => {
    expect(configLabelSchema.parse({ label: '  خانه  ' })).toEqual({ label: 'خانه' });
    expect(configLabelSchema.parse({ label: '   ' })).toEqual({ label: null });
    expect(configLabelSchema.parse({ label: null })).toEqual({ label: null });
  });

  it('refuses a label past 40 characters, and a missing one', () => {
    expect(configLabelSchema.safeParse({ label: 'x'.repeat(40) }).success).toBe(true);
    expect(configLabelSchema.safeParse({ label: 'x'.repeat(41) }).success).toBe(false);
    expect(configLabelSchema.safeParse({}).success).toBe(false);
  });
});

describe('UserConfigsController', () => {
  it('passes the gate’s user, and answers another user’s Grant as a 404', async () => {
    const configs = {
      listForGrant: vi.fn(async () => {
        throw new ConfigActionRefused('grant_not_found', GRANT);
      }),
      act: vi.fn(async () => []),
    };
    const controller = new UserConfigsController(configs as never, {} as never);

    await expect(controller.list(GRANT, req(USER) as never)).rejects.toBeInstanceOf(NotFoundException);
    expect(configs.listForGrant).toHaveBeenCalledWith(USER, GRANT);

    await controller.act({ action: 'retire', configIds: [C1] }, { ...req(USER), body: { userId: 'someone-else' } } as never);
    expect(configs.act).toHaveBeenCalledWith(USER, 'retire', [C1]);
  });

  it('reads and acts under two buckets of their own', () => {
    expect(Reflect.getMetadata(PATH_METADATA, UserConfigsController)).toBe('billing/traffic');
    const list = UserConfigsController.prototype.list;
    const act = UserConfigsController.prototype.act;
    expect(Reflect.getMetadata(METHOD_METADATA, list)).toBe(0); // GET
    expect(Reflect.getMetadata(METHOD_METADATA, act)).toBe(1); // POST
    expect(Reflect.getMetadata(PATH_METADATA, list)).toBe('grants/:grantId/configs');
    expect(Reflect.getMetadata(PATH_METADATA, act)).toBe('configs/actions');

    const readLimit = Reflect.getMetadata(RATE_LIMIT_KEY, list) as RateLimitOptions;
    const actLimit = Reflect.getMetadata(RATE_LIMIT_KEY, act) as RateLimitOptions;
    expect(readLimit.key(req(USER) as never)).toBe(`${RateLimitBucket.CONFIG_LIST}:${USER}`);
    expect(actLimit.key(req(USER) as never)).toBe(`${RateLimitBucket.CONFIG_ACTION}:${USER}`);
    expect(actLimit.configKey).toBe('CONFIG_ACTION_RATE_LIMIT');
  });

  it('names a config under PUT, the acting bucket, and answers another user’s config as a 404', async () => {
    const setLabel = UserConfigsController.prototype.setLabel;
    expect(Reflect.getMetadata(METHOD_METADATA, setLabel)).toBe(2); // PUT
    expect(Reflect.getMetadata(PATH_METADATA, setLabel)).toBe('configs/:configId/label');
    expect((Reflect.getMetadata(RATE_LIMIT_KEY, setLabel) as RateLimitOptions).key(req(USER) as never)).toBe(
      `${RateLimitBucket.CONFIG_ACTION}:${USER}`,
    );

    const configs = {
      setLabel: vi.fn(async () => {
        throw new ConfigActionRefused('config_not_found', C1);
      }),
    };
    const controller = new UserConfigsController(configs as never, {} as never);
    await expect(controller.setLabel(C1, { label: 'x' }, req(USER) as never)).rejects.toBeInstanceOf(NotFoundException);
    expect(configs.setLabel).toHaveBeenCalledWith(USER, C1, 'x');
  });
});
