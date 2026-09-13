/**
 * The trigger behind ADR-0043 §4, against the database we actually ship
 * (F-101-b).
 *
 * The unit spec proves what the listener does with a notification. Nothing
 * there can prove the notification exists: that is a trigger in a migration,
 * and a trigger is only a claim until Postgres runs it. So this starts the same
 * Postgres the isolation harness does — **the committed migration history**,
 * read off disk — and drives the **production listener** over a real `pg`
 * connection as the service's own least-privileged login, while the migration
 * role writes the rows the way SQL and migrations do.
 *
 * What each case would catch if it went wrong:
 *
 *   * connect — the listener could not read the roles as `txnet_app`, or LISTENs
 *     on a channel the trigger does not write;
 *   * a grant — the trigger is missing, on the wrong table, or names the wrong
 *     column, and a changed role is honoured until tokens expire;
 *   * a user moving role — the second trigger is missing, which no role's own
 *     fingerprint can see;
 *   * a rollback — the notification was sent before commit, so Redis would hold
 *     a set Postgres never kept.
 *
 *   npx vitest run -c auth-service/vitest.int.config.mts permission-notifications
 */
import { PrismaClient } from '@prisma/client';
import { Client } from 'pg';
import { PrismaService } from '../../prisma/prisma.service';
import { permissionFingerprint } from './permission-fingerprint';
import { PermissionNotificationsListener } from './permission-notifications.listener';
import type { PermissionStateStore } from './permission-state.store';
import {
  HARNESS_TIMEOUT_MS,
  PostgresFixture,
  startPostgresFixture,
} from '../../../../../test-support/postgres-fixture';

vi.setConfig({ testTimeout: HARNESS_TIMEOUT_MS, hookTimeout: HARNESS_TIMEOUT_MS });

const TENANT = '44444444-4444-4444-8444-444444444444';
const USER = '55555555-5555-4555-8555-555555555555';
const ROLE_OPERATOR = '66666666-6666-4666-8666-666666666666';
const ROLE_PLAIN = '77777777-7777-4777-8777-777777777777';
const PERM_WORKERS = '88888888-8888-4888-8888-888888888888';
const PERM_USERS = '99999999-9999-4999-8999-999999999999';

let pg: PostgresFixture;
let prisma: PrismaService;
let owner: PrismaClient;
let listener: PermissionNotificationsListener;

const roleWrites: Array<[string, string]> = [];
const userWrites: Array<[string, string]> = [];

const store = {
  writeRole: async (roleId: string, fingerprint: string) => void roleWrites.push([roleId, fingerprint]),
  writeUserRole: async (userId: string, roleId: string) => void userWrites.push([userId, roleId]),
} as unknown as PermissionStateStore;

beforeAll(async () => {
  pg = await startPostgresFixture();
  prisma = new PrismaService(pg.appUrl);
  owner = new PrismaClient({ datasourceUrl: pg.ownerUrl });

  await owner.$executeRawUnsafe(`
    INSERT INTO identity.role (id, name, "isSystemRole") VALUES
      ('${ROLE_OPERATOR}', 'notify_operator', false),
      ('${ROLE_PLAIN}', 'notify_plain', false)
  `);
  await owner.$executeRawUnsafe(`
    INSERT INTO identity.permission (id, key) VALUES
      ('${PERM_WORKERS}', 'worker.manage'),
      ('${PERM_USERS}', 'user.read')
  `);
  await owner.$executeRawUnsafe(`
    INSERT INTO identity.role_permission ("roleId", "permissionId") VALUES ('${ROLE_OPERATOR}', '${PERM_WORKERS}')
  `);
  await owner.$executeRawUnsafe(`
    INSERT INTO tenant.tenant (id, "tenantType", "ownerUserId", slug, status, "billingModel", "updatedAt")
    VALUES ('${TENANT}', 'reseller', '${USER}', 'notify', 'active', 'pay_as_you_go_metered', now())
  `);
  await owner.$executeRawUnsafe(`
    INSERT INTO identity."user" (id, "tenantId", "fullName", "passwordHash", "roleId", "updatedAt")
    VALUES ('${USER}', '${TENANT}', 'notify person', 'x', '${ROLE_OPERATOR}', now())
  `);

  listener = new PermissionNotificationsListener(
    prisma,
    store,
    () => new Client({ connectionString: pg.appUrl }),
  );
  await listener.start();
});

afterAll(async () => {
  await listener?.onModuleDestroy();
  await Promise.allSettled([prisma?.$disconnect(), owner?.$disconnect()]);
  await pg?.stop();
});

const latestFor = (roleId: string) =>
  [...roleWrites].reverse().find(([id]) => id === roleId)?.[1];

describe('the permission trigger, on the committed migration history', () => {
  it('recomputes every role from the committed rows when the listener connects', () => {
    expect(latestFor(ROLE_OPERATOR)).toBe(permissionFingerprint(['worker.manage']));
    expect(latestFor(ROLE_PLAIN)).toBe(permissionFingerprint([]));
  });

  it("rewrites a role's fingerprint once a grant commits", async () => {
    await owner.$executeRawUnsafe(`
      INSERT INTO identity.role_permission ("roleId", "permissionId") VALUES ('${ROLE_OPERATOR}', '${PERM_USERS}')
    `);

    await vi.waitFor(
      () => expect(latestFor(ROLE_OPERATOR)).toBe(permissionFingerprint(['worker.manage', 'user.read'])),
      { timeout: 5_000 },
    );
  });

  it('writes the role a user moved to', async () => {
    await owner.$executeRawUnsafe(`UPDATE identity."user" SET "roleId" = '${ROLE_PLAIN}' WHERE id = '${USER}'`);

    await vi.waitFor(() => expect(userWrites).toContainEqual([USER, ROLE_PLAIN]), { timeout: 5_000 });
  });

  it('notifies nothing for a change that rolls back', async () => {
    const before = roleWrites.length;

    await owner
      .$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`
          INSERT INTO identity.role_permission ("roleId", "permissionId") VALUES ('${ROLE_PLAIN}', '${PERM_WORKERS}')
        `);
        throw new Error('roll back');
      })
      .catch(() => undefined);

    // Long enough for a notification sent before commit to have arrived; the
    // grant case above shows a real one lands well inside this.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(roleWrites.slice(before).filter(([id]) => id === ROLE_PLAIN)).toEqual([]);
  });
});
