/**
 * Money holds four places (ADR-0153 point 6, F-116-q), on a database every
 * migration ran on from empty. What breaks quietly:
 *
 *  - **a column left at two.** Postgres rounds a third place away on write,
 *    with no error: a dinar amount loses its fils in exactly that table;
 *  - **a currency finer than the columns.** Registered at five places, every
 *    write of it would be rounded by the database, not by the writer;
 *  - **a view rebuilt with more rights.** The AI reader's views were dropped to
 *    retype what they read; rebuilt, they must still be the reader's alone.
 */
import { PrismaClient } from '@prisma/client';

import { HARNESS_TIMEOUT_MS, PostgresFixture, prismaAt, startPostgresFixture } from '../../../../test-support/postgres-fixture';

vi.setConfig({ testTimeout: HARNESS_TIMEOUT_MS, hookTimeout: HARNESS_TIMEOUT_MS });

const READER_VIEWS = ['reader_billing_event', 'reader_reseller', 'reader_wallet', 'reader_wholesale_spend'];

let pg: PostgresFixture;
let owner: PrismaClient;

const rows = <T>(q: string) => owner.$queryRawUnsafe(q) as Promise<T[]>;
const register = (code: string, places: number) =>
  owner.$executeRawUnsafe(`INSERT INTO currency.currency (id, code, name, symbol, "decimalPlaces") VALUES (gen_random_uuid(), '${code}', '${code}', '${code}', ${places})`);

beforeAll(async () => {
  pg = await startPostgresFixture();
  owner = prismaAt(pg.ownerUrl);
});

afterAll(async () => {
  await owner?.$disconnect();
  await pg?.stop();
});

describe('money holds four places (F-116-q)', () => {
  it('leaves no column, nor array of amounts, at two places', async () => {
    const left = await rows<{ col: string }>(`
      SELECT a.attrelid::regclass || '.' || a.attname AS col
        FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
       WHERE c.relkind IN ('r', 'v') AND a.attnum > 0 AND NOT a.attisdropped
         AND format_type(a.atttypid, a.atttypmod) IN ('numeric(18,2)', 'numeric(18,2)[]')`);
    expect(left).toEqual([]);
    const [wallet] = await rows<{ type: string }>(`SELECT format_type(atttypid, atttypmod) AS type FROM pg_attribute WHERE attrelid = 'billing.wallet'::regclass AND attname = 'cachedBalance'`);
    expect(wallet.type).toBe('numeric(20,4)');
  });

  it('registers a three-place currency and refuses one finer than the columns', async () => {
    await expect(register('KWD', 3)).resolves.toBe(1);
    await expect(register('ZZF', 5)).rejects.toThrow(/currency_decimal_places_fit_money/);
  });

  it('keeps the rebuilt AI reader views the reader’s alone', async () => {
    for (const view of READER_VIEWS) {
      const [rights] = await rows<{ reads: boolean; app: boolean; cross: boolean }>(`
        SELECT has_table_privilege('txnet_ai_reader', 'ai.${view}', 'SELECT') AS reads,
               has_table_privilege('txnet_app', 'ai.${view}', 'SELECT') AS app,
               has_table_privilege('txnet_cross_tenant', 'ai.${view}', 'SELECT') AS cross`);
      expect({ view, ...rights }).toEqual({ view, reads: true, app: false, cross: false });
    }
  });
});
