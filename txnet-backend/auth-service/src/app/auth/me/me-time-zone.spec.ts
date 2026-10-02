import { meTimeZoneSchema } from '../auth.schema';
import { MeTimeZoneService } from './me-time-zone.service';
import type { AuthClaims } from '../token.service';

/**
 * The caller's own time zone (TZ-1-c, ADR-0108 point 4). The rule that breaks
 * silently is the order of two writers: the panel reports its browser zone
 * after every sign-in, and that report must never undo a zone the user chose —
 * not even when the choice lands between the report's read and its write. So
 * the harness's `updateMany` honours its `where`, as Postgres would.
 */

const CLAIMS = { sub: 'user-1', tenantId: 'tenant-1' } as AuthClaims;

type Row = { timezone: string | null; timezoneSource: 'user' | 'browser' | null };

function harness(start: Row, tenantZone = 'Europe/Istanbul') {
  const row: Row = { ...start };
  const view = () => ({ ...row, tenant: { timezone: tenantZone } });
  const matches = (where: { OR?: Array<{ timezoneSource: string | null }> }) =>
    !where.OR || where.OR.some((w) => w.timezoneSource === row.timezoneSource);
  const prisma = {
    user: {
      findUnique: vi.fn(async () => view()),
      updateMany: vi.fn(async ({ where, data }: { where: { id: string; OR?: Array<{ timezoneSource: string | null }> }; data: Row }) => {
        if (where.id !== CLAIMS.sub || !matches(where)) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      }),
    },
  };
  return { prisma, row, service: new MeTimeZoneService(prisma as never) };
}

describe('MeTimeZoneService', () => {
  it('reads a user with no zone as the tenant zone, and says where it came from', async () => {
    const { service, prisma } = harness({ timezone: null, timezoneSource: null });
    expect(await service.read(CLAIMS)).toMatchObject({
      ok: true,
      data: { timezone: null, source: null, resolved: { zone: 'Europe/Istanbul', from: 'tenant' } },
    });
    expect(prisma.user.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'user-1' } }));
  });

  it('stores a browser report over nothing, canonical', async () => {
    const { service, row } = harness({ timezone: null, timezoneSource: null });
    const out = await service.save(CLAIMS, { zone: 'Iran', source: 'browser' });
    expect(row).toEqual({ timezone: 'Asia/Tehran', timezoneSource: 'browser' });
    expect(out).toMatchObject({ data: { applied: true, resolved: { zone: 'Asia/Tehran', from: 'browser' } } });
  });

  it('declines a browser report over a zone the user chose, and says so', async () => {
    const { service, row, prisma } = harness({ timezone: 'Europe/Berlin', timezoneSource: 'user' });
    const out = await service.save(CLAIMS, { zone: 'Asia/Dubai', source: 'browser' });
    expect(row).toEqual({ timezone: 'Europe/Berlin', timezoneSource: 'user' });
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
    expect(out).toMatchObject({ data: { applied: false, timezone: 'Europe/Berlin', source: 'user' } });
  });

  it('declines a browser report even when the choice lands between its read and its write', async () => {
    const { service, row, prisma } = harness({ timezone: null, timezoneSource: null });
    prisma.user.findUnique.mockImplementationOnce(async () => {
      const before = { timezone: null, timezoneSource: null, tenant: { timezone: 'Europe/Istanbul' } };
      Object.assign(row, { timezone: 'Europe/Berlin', timezoneSource: 'user' });
      return before;
    });
    const out = await service.save(CLAIMS, { zone: 'Asia/Dubai', source: 'browser' });
    expect(row).toEqual({ timezone: 'Europe/Berlin', timezoneSource: 'user' });
    expect(out).toMatchObject({ data: { applied: false } });
  });

  it('lets the user choose over a report, and clear the choice', async () => {
    const { service, row } = harness({ timezone: 'Asia/Dubai', timezoneSource: 'browser' });
    await service.save(CLAIMS, { zone: 'Europe/Berlin', source: 'user' });
    expect(row).toEqual({ timezone: 'Europe/Berlin', timezoneSource: 'user' });
    const out = await service.save(CLAIMS, { zone: null, source: 'user' });
    expect(row).toEqual({ timezone: null, timezoneSource: null });
    expect(out).toMatchObject({ data: { applied: true, resolved: { from: 'tenant' } } });
  });
});

describe('meTimeZoneSchema', () => {
  it.each([
    { zone: 'Europe/Berlin', source: 'user' },
    { zone: 'Asia/Tehran', source: 'browser' },
    { zone: null, source: 'user' },
  ])('accepts %j', (body) => {
    expect(meTimeZoneSchema.safeParse(body).success).toBe(true);
  });

  it.each([
    { zone: '+03:30', source: 'user' },
    { zone: 'Mars/Olympus', source: 'browser' },
    { zone: null, source: 'browser' },
    { zone: 'Europe/Berlin', source: 'ip' },
    { zone: 'Europe/Berlin' },
    { zone: 'Europe/Berlin', source: 'user', extra: 1 },
  ])('refuses %j — a 400', (body) => {
    expect(meTimeZoneSchema.safeParse(body).success).toBe(false);
  });
});
