/**
 * Seats and staff roles become groups, once (GR-1-g, ADR-0139 (6)), against
 * a real Postgres built from the committed migration history.
 *
 * The harness applies every migration to an empty database, where this one
 * does nothing. So the people are seeded first and the migration's own text
 * is run again — the file, not a copy of it.
 *
 * What only a database can say: each person's keys are the same before and
 * after (a key lost is someone locked out of work; a key gained is a grant
 * nobody made); a seat's end becomes the membership's; and what is left
 * alone — `*`, an invite nobody accepted, an ended or revoked seat, a role
 * held without a seat — really is.
 *
 *   npm run test:int
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';

import {
  HARNESS_TIMEOUT_MS,
  PostgresFixture,
  prismaAt,
  startPostgresFixture,
} from '../../../../../test-support/postgres-fixture';

vi.setConfig({ testTimeout: HARNESS_TIMEOUT_MS, hookTimeout: HARNESS_TIMEOUT_MS });

const MIGRATION = join(
  __dirname,
  '../../../../../prisma/domains/migrations/20261009001000_seats_and_staff_roles_become_groups/migration.sql',
);

const PLATFORM = '10000000-0000-4000-8000-000000000001';
const RESELLER = '11111111-1111-4111-8111-111111111111';
const ROLE = {
  user: 'a0000000-0000-4000-8000-000000000001',
  super: 'a0000000-0000-4000-8000-000000000002',
  admin: 'a0000000-0000-4000-8000-000000000003', // a template a reseller's staff and the platform's both hold
  desk: 'a0000000-0000-4000-8000-000000000004', // the reseller's own
  figures: 'a0000000-0000-4000-8000-000000000005', // the platform's own, with a platform key
};
const KEYS: Record<keyof typeof ROLE, string[]> = {
  user: [],
  super: ['*'],
  admin: ['user.read', 'coupon.manage'],
  desk: ['ticket.read', 'ticket.reply'],
  figures: ['platform.report.read', 'user.read'],
};
// People: [id, tenant, role, seat]
const SEAT_END = '2030-01-31T23:59:59.000Z';
type Seat = 'joined' | 'ending' | 'invited' | 'ended' | 'revoked' | null;
const PEOPLE: [string, string, keyof typeof ROLE, Seat][] = [
  ['b0000000-0000-4000-8000-000000000001', RESELLER, 'desk', 'joined'], // ali
  ['b0000000-0000-4000-8000-000000000002', RESELLER, 'desk', 'ending'], // sara, with an end
  ['b0000000-0000-4000-8000-000000000003', RESELLER, 'admin', 'joined'], // reza
  ['b0000000-0000-4000-8000-000000000004', RESELLER, 'desk', 'invited'], // never accepted
  ['b0000000-0000-4000-8000-000000000005', RESELLER, 'desk', 'ended'],
  ['b0000000-0000-4000-8000-000000000006', RESELLER, 'desk', 'revoked'],
  ['b0000000-0000-4000-8000-000000000007', RESELLER, 'desk', null], // a role, no seat
  ['b0000000-0000-4000-8000-000000000008', RESELLER, 'user', 'joined'], // a seat that gave nothing
  ['c0000000-0000-4000-8000-000000000001', PLATFORM, 'super', null], // the owner
  ['c0000000-0000-4000-8000-000000000002', PLATFORM, 'admin', null],
  ['c0000000-0000-4000-8000-000000000003', PLATFORM, 'figures', null],
  ['c0000000-0000-4000-8000-000000000004', PLATFORM, 'user', null],
];
const id = (n: number) => PEOPLE[n][0];

let pg: PostgresFixture;
let owner: PrismaClient;

/** One person's keys: their role's plus every live group's, as `accessOf` counts for a member of the group's own tenant. */
async function keysOf(userId: string): Promise<string[]> {
  const rows = await owner.$queryRawUnsafe<{ key: string }[]>(`
    SELECT p.key FROM identity."user" u
      JOIN identity.role_permission rp ON rp."roleId" = u."roleId" JOIN identity.permission p ON p.id = rp."permissionId"
     WHERE u.id = '${userId}'
    UNION
    SELECT p.key FROM governance.user_group_member m
      JOIN identity."user" u ON u.id = m."userId" AND u."tenantId" = m."tenantId"
      JOIN governance.user_group_permission gp ON gp."groupId" = m."groupId" JOIN identity.permission p ON p.id = gp."permissionId"
     WHERE m."userId" = '${userId}' AND (m."expiresAt" IS NULL OR m."expiresAt" > now())`);
  return rows.map((r) => r.key).sort();
}

const roleOf = async (userId: string) =>
  (await owner.$queryRawUnsafe<{ name: string }[]>(`SELECT r.name FROM identity."user" u JOIN identity.role r ON r.id = u."roleId" WHERE u.id = '${userId}'`))[0].name;

const groupsOf = (tenantId: string) =>
  owner.$queryRawUnsafe<{ name: string; keys: string[]; members: string[]; ends: (Date | null)[] }[]>(`
    SELECT g.name,
           ARRAY(SELECT p.key FROM governance.user_group_permission gp JOIN identity.permission p ON p.id = gp."permissionId" WHERE gp."groupId" = g.id ORDER BY p.key) AS keys,
           ARRAY(SELECT m."userId"::text FROM governance.user_group_member m WHERE m."groupId" = g.id ORDER BY m."userId") AS members,
           ARRAY(SELECT m."expiresAt" FROM governance.user_group_member m WHERE m."groupId" = g.id ORDER BY m."userId") AS ends
      FROM governance.user_group g WHERE g."tenantId" = '${tenantId}' ORDER BY g.name`);

const before = new Map<string, string[]>();

beforeAll(async () => {
  pg = await startPostgresFixture();
  owner = prismaAt(pg.ownerUrl);
  for (const [tid, type, slug] of [
    [PLATFORM, 'platform_owner', 'home'],
    [RESELLER, 'reseller', 'alpha'],
  ]) {
    await owner.$executeRawUnsafe(`
      INSERT INTO tenant.tenant (id, "tenantType", "ownerUserId", slug, status, "billingModel", "updatedAt")
      VALUES ('${tid}', '${type}', '${tid === PLATFORM ? id(8) : 'd0000000-0000-4000-8000-000000000001'}', '${slug}', 'active', 'pay_as_you_go_metered', now())`);
  }
  const allKeys = [...new Set(Object.values(KEYS).flat())];
  for (const key of allKeys) await owner.$executeRawUnsafe(`INSERT INTO identity.permission (id, key) VALUES (gen_random_uuid(), '${key}') ON CONFLICT (key) DO NOTHING`);
  const names: Record<keyof typeof ROLE, [string, string | null]> = {
    user: ['user', null],
    super: ['SuperAdmin', null],
    admin: ['Admin', null],
    desk: ['Desk', RESELLER],
    figures: ['Figures', PLATFORM],
  };
  for (const [k, roleId] of Object.entries(ROLE) as [keyof typeof ROLE, string][]) {
    const [name, tid] = names[k];
    await owner.$executeRawUnsafe(`INSERT INTO identity.role (id, name, "tenantId") VALUES ('${roleId}', '${name}', ${tid ? `'${tid}'` : 'NULL'})`);
    for (const key of KEYS[k]) {
      await owner.$executeRawUnsafe(`INSERT INTO identity.role_permission ("roleId", "permissionId") SELECT '${roleId}', id FROM identity.permission WHERE key = '${key}'`);
    }
  }
  // The reseller already has a group called Desk: the migrated one must not collide with it.
  await owner.$executeRawUnsafe(`INSERT INTO governance.user_group (id, "tenantId", name, "createdByAdminId") VALUES (gen_random_uuid(), '${RESELLER}', 'Desk', '${id(0)}')`);
  for (const [uid, tid, role, seat] of PEOPLE) {
    await owner.$executeRawUnsafe(`
      INSERT INTO identity."user" (id, "tenantId", "roleId", "fullName", "passwordHash", "updatedAt")
      VALUES ('${uid}', '${tid}', '${ROLE[role]}', 'p', 'x', now())`);
    if (!seat) continue;
    const joined = seat === 'invited' ? 'NULL' : 'now()';
    const end = seat === 'ending' ? `'${SEAT_END}'` : seat === 'ended' ? `now() - interval '1 day'` : 'NULL';
    const revoked = seat === 'revoked' ? 'now()' : 'NULL';
    await owner.$executeRawUnsafe(`
      INSERT INTO tenant.tenant_staff_member (id, "tenantId", "userId", "joinedAt", "accessExpiresAt", "revokedAt")
      VALUES (gen_random_uuid(), '${tid}', '${uid}', ${joined}, ${end}, ${revoked})`);
  }
  for (const [uid] of PEOPLE) before.set(uid, await keysOf(uid));

  await owner.$executeRawUnsafe(readFileSync(MIGRATION, 'utf8'));
});

afterAll(async () => {
  await owner?.$disconnect();
  await pg?.stop();
});

describe('seats and staff roles become groups (GR-1-g)', () => {
  it("leaves every person's keys exactly as they were", async () => {
    for (const [uid] of PEOPLE) expect({ uid, keys: await keysOf(uid) }).toEqual({ uid, keys: before.get(uid) });
  });

  it("makes each role a reseller's seated people hold a group of it, its members carrying their seat's end", async () => {
    const [desk, desk2, admin] = [
      { name: 'Admin', keys: KEYS.admin.slice().sort(), members: [id(2)], ends: [null] },
      { name: 'Desk', keys: [], members: [], ends: [] },
      { name: 'Desk (2)', keys: KEYS.desk.slice().sort(), members: [id(0), id(1)], ends: [null, new Date(SEAT_END)] },
    ];
    expect(await groupsOf(RESELLER)).toEqual([desk, desk2, admin]);
  });

  it("makes each of the platform's staff roles a platform group, a platform key included, and never `*`", async () => {
    expect(await groupsOf(PLATFORM)).toEqual([
      { name: 'Admin', keys: KEYS.admin.slice().sort(), members: [id(9)], ends: [null] },
      { name: 'Figures', keys: KEYS.figures.slice().sort(), members: [id(10)], ends: [null] },
    ]);
  });

  it('moves the people it grouped to `user`, and nobody else', async () => {
    const roles = Object.fromEntries(await Promise.all(PEOPLE.map(async ([uid]) => [uid, await roleOf(uid)])));
    expect(roles).toEqual({
      [id(0)]: 'user',
      [id(1)]: 'user',
      [id(2)]: 'user',
      [id(3)]: 'Desk', // invited, never accepted
      [id(4)]: 'Desk', // seat ended
      [id(5)]: 'Desk', // seat revoked
      [id(6)]: 'Desk', // a role with no seat
      [id(7)]: 'user',
      [id(8)]: 'SuperAdmin',
      [id(9)]: 'user',
      [id(10)]: 'user',
      [id(11)]: 'user',
    });
  });

  it('keeps every seat row, for history', async () => {
    const [{ count }] = await owner.$queryRawUnsafe<{ count: bigint }[]>(`SELECT count(*) FROM tenant.tenant_staff_member`);
    expect(Number(count)).toBe(PEOPLE.filter((p) => p[3]).length);
  });
});
