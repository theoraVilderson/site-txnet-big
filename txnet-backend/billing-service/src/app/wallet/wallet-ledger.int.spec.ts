/**
 * The wallet version race against a real Postgres (F-092-p, billing invariant 4).
 *
 * `wallet-ledger.spec.ts` proves the service writes `cachedBalance` under
 * `where { id, version }` and refuses on `count: 0`, against a fake store that
 * *models* how Postgres treats that `where`. What the fake cannot prove is the
 * model itself: that under READ COMMITTED a second `UPDATE` which waited on the
 * first one's row lock re-checks its `where` against the committed row, and so
 * matches nothing. If it did not, both debits would land and every row in the
 * ledger would still look consistent on its own.
 *
 * So two debits run here in two `tenantTransaction`s on the application's own
 * client — `DATABASE_APP_URL`'s role, `withTenant` applied as
 * `prisma.module.ts` applies it — against a database built from the committed
 * migration history and role script. Both read the wallet before either
 * writes; the interleaving is forced, not hoped for.
 *
 * The second half is the tenant: the ledger row is stamped by the extension and
 * admitted by the RLS `WITH CHECK`, and then shown to its own tenant only. The
 * raw count under the other tenant is what makes that a statement about the
 * policy rather than about the extension, and the owner's count is the
 * negative control — a probe that sees nothing anywhere proves nothing.
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
} from '../../../../test-support/postgres-fixture';
import { PrismaService } from '../prisma/prisma.service';
import { WalletLedgerService, WalletVersionConflict } from './wallet-ledger.service';

vi.setConfig({ testTimeout: HARNESS_TIMEOUT_MS, hookTimeout: HARNESS_TIMEOUT_MS });

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const ROLE_ID = '33333333-3333-4333-8333-333333333333';
const USER_A = '44444444-4444-4444-8444-444444444444';
const WALLET_A = '55555555-5555-4555-8555-555555555555';

let pg: PostgresFixture;
/** The application, exactly as `prisma.module.ts` builds it. */
let app: PrismaService;
/** The migration role, which RLS does not bind: the seeder and the negative control. */
let owner: PrismaClient;

const ledger = new WalletLedgerService();

beforeAll(async () => {
  pg = await startPostgresFixture();
  const base = new PrismaService(pg.appUrl);
  app = base.$extends(withTenant(base)) as unknown as PrismaService;
  owner = prismaAt(pg.ownerUrl);
  await seed();
});

afterAll(async () => {
  await Promise.allSettled([app?.$disconnect(), owner?.$disconnect()]);
  await pg?.stop();
});

async function seed() {
  await owner.$executeRawUnsafe(`
    INSERT INTO identity.role (id, name, "isSystemRole") VALUES ('${ROLE_ID}', 'harness_user', false)
  `);
  for (const [id, slug] of [[TENANT_A, 'alpha'], [TENANT_B, 'beta']]) {
    await owner.$executeRawUnsafe(`
      INSERT INTO tenant.tenant (id, "tenantType", "ownerUserId", slug, status, "billingModel", "updatedAt")
      VALUES ('${id}', 'reseller', '${id}', '${slug}', 'active', 'pay_as_you_go_metered', now())
    `);
  }
  await owner.$executeRawUnsafe(`
    INSERT INTO identity."user" (id, "tenantId", "fullName", "passwordHash", "roleId", "updatedAt")
    VALUES ('${USER_A}', '${TENANT_A}', 'alpha person', 'x', '${ROLE_ID}', now())
  `);
  await owner.$executeRawUnsafe(`
    INSERT INTO billing.wallet (id, "ownerUserId", "currencyCode", "cachedBalance", version)
    VALUES ('${WALLET_A}', '${USER_A}', 'USD', 100.00, 0)
  `);
}

/**
 * `tx` with `wallet.findUnique` held open until every expected reader has read.
 * Everything else — the update, the ledger insert, the tenant hook — is the
 * real transaction client, untouched.
 */
function heldAfterWalletRead(
  tx: Prisma.TransactionClient,
  barrier: { read(): void; gate: Promise<void> },
): Prisma.TransactionClient {
  const wallet = new Proxy(tx.wallet, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (prop !== 'findUnique') {
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return async (args: Prisma.WalletFindUniqueArgs) => {
        const row = await target.findUnique(args);
        barrier.read();
        await barrier.gate;
        return row;
      };
    },
  });
  return new Proxy(tx, {
    get: (target, prop) => (prop === 'wallet' ? wallet : Reflect.get(target, prop, target)),
  });
}

function barrierFor(readers: number) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let seen = 0;
  return {
    gate,
    read: () => {
      seen += 1;
      if (seen === readers) release();
    },
  };
}

describe('two debits on one wallet, both reading version 0', () => {
  let results: PromiseSettledResult<unknown>[];

  beforeAll(async () => {
    const barrier = barrierFor(2);
    const debit = (referenceId: string) =>
      runWithTenant({ id: TENANT_A }, () =>
        tenantTransaction(app, (tx) =>
          ledger.debit(heldAfterWalletRead(tx, barrier), {
            userId: USER_A,
            amount: new Prisma.Decimal('70.00'),
            currencyCode: 'USD',
            reasonType: 'traffic_consumption',
            referenceId,
          }),
        ),
      );
    results = await Promise.allSettled([
      debit('aaaaaaaa-0000-4000-8000-000000000001'),
      debit('aaaaaaaa-0000-4000-8000-000000000002'),
    ]);
  });

  it('lets exactly one land and refuses the other on the version', () => {
    const rejected = results.filter(
      (r): r is PromiseRejectedResult => r.status === 'rejected',
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(WalletVersionConflict);
  });

  it('commits one ledger row and a cache that agrees with it', async () => {
    const wallet = await owner.wallet.findUniqueOrThrow({ where: { id: WALLET_A } });
    const rows = await owner.walletTransaction.findMany({ where: { walletId: WALLET_A } });

    expect(wallet.cachedBalance.toFixed(2)).toBe('30.00');
    expect(wallet.version).toBe(1);
    expect(rows).toHaveLength(1);
    expect(rows[0].balanceAfter.toFixed(2)).toBe('30.00');
    expect(rows[0].tenantId).toBe(TENANT_A);
  });

  it('shows the ledger row to its own tenant only — by the policy, not only the extension', async () => {
    const rawCount = (tenantId: string) =>
      runWithTenant({ id: tenantId }, () =>
        tenantTransaction(app, async (tx) => {
          const [{ n }] = await tx.$queryRaw<{ n: number }[]>`
            SELECT count(*)::int AS n FROM billing.wallet_transaction`;
          return n;
        }),
      );

    expect(await rawCount(TENANT_A)).toBe(1);
    expect(await rawCount(TENANT_B)).toBe(0);
    // The negative control: the same table, through the role RLS does not bind.
    expect(await owner.walletTransaction.count()).toBe(1);
  });
});
