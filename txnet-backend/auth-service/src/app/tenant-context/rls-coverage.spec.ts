import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * F-066-m-b turns on one guarantee that nothing else in this repo can hold: a
 * table with a `tenantId` column is covered by a Row-Level Security policy.
 *
 * This is the failure worth a spec because it is the one that is *silent*. A
 * migration that forgets a table is green; a model that gains a `tenantId`
 * next month is green; `prisma migrate` mentions neither, because RLS is not
 * something Prisma models at all. The result reads exactly like a working
 * system, and the first sign of the gap is one tenant reading another's rows.
 *
 * So the schema asks the question and the migration history answers it: every
 * `@@map`ped model carrying a `tenantId` must be named by a policy under
 * `prisma/domains/migrations/`. Both sides are read off disk rather than
 * listed here — a hand-written list would have to be edited by the same person
 * who forgot the policy, on the same day.
 */

const DOMAINS = join(__dirname, '../../../../prisma/domains');
const MIGRATIONS = join(DOMAINS, 'migrations');

/** `schema.table` for every model in `prisma/domains/*.prisma` with a `tenantId`. */
function tenantScopedTables(): string[] {
  const tables: string[] = [];
  for (const file of readdirSync(DOMAINS).filter((f) => f.endsWith('.prisma'))) {
    const src = readFileSync(join(DOMAINS, file), 'utf8');
    for (const model of src.matchAll(/^model\s+\w+\s*\{([\s\S]*?)^\}/gm)) {
      const body = model[1];
      if (!/^\s*tenantId\s/m.test(body)) continue;
      const table = /@@map\("([^"]+)"\)/.exec(body)?.[1];
      const schema = /@@schema\("([^"]+)"\)/.exec(body)?.[1];
      if (table && schema) tables.push(`${schema}.${table}`);
    }
  }
  return tables.sort();
}

/** Every `migration.sql` in the history, concatenated. */
function migrationSql(): string {
  return readdirSync(MIGRATIONS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      try {
        return readFileSync(join(MIGRATIONS, entry.name, 'migration.sql'), 'utf8');
      } catch {
        // A migration directory with no `migration.sql` is not this spec's
        // problem; `prisma migrate` is the thing that complains about it.
        return '';
      }
    })
    .join('\n');
}

/**
 * The tables the history names as policy targets.
 *
 * The statements are built by `EXECUTE format(...)` inside a `FOREACH … ARRAY`
 * loop, so a table appears as a quoted SQL literal rather than after the word
 * `TABLE`. Both spellings of a name count — `identity."user"` has to be quoted
 * because `user` is reserved, and the rest are bare — because what is asserted
 * here is coverage, not formatting.
 */
function tablesNamedByPolicies(sql: string): Set<string> {
  const named = new Set<string>();
  for (const m of sql.matchAll(/'([a-z_]+)\.("?)([a-z_]+)\2'/g)) {
    named.add(`${m[1]}.${m[3]}`);
  }
  for (const m of sql.matchAll(
    /ALTER\s+TABLE\s+([a-z_]+)\.("?)([a-z_]+)\2\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY/gi,
  )) {
    named.add(`${m[1]}.${m[3]}`);
  }
  return named;
}

const SQL = migrationSql();
const NAMED = tablesNamedByPolicies(SQL);

describe('Row-Level Security covers the schema (catalog 20.2 layer 1, F-1202)', () => {
  it('finds the tenant-scoped tables in the schema at all', () => {
    // A guard on the guard. If the parse above ever stops matching, every
    // assertion below passes over an empty list and this file becomes
    // decoration that reads like proof.
    const tables = tenantScopedTables();
    expect(tables).toContain('identity.user');
    expect(tables).toContain('tenant.tenant_domain');
    expect(tables.length).toBeGreaterThan(20);
  });

  it.each(tenantScopedTables())('%s is policied', (table) => {
    expect([...NAMED]).toContain(table);
  });

  it('serves the escape with a policy, never a bypass', () => {
    // `txnet_cross_tenant` sees every row because a policy says so, not
    // because RLS was turned off for it. The difference is the whole of
    // F-1202's "bypassing RLS on the normal pool is not possible": a role
    // holding BYPASSRLS would make one connection-string typo enough.
    expect(SQL).toMatch(/CREATE\s+POLICY\s+cross_tenant/i);
    expect(SQL).toMatch(/USING\s*\(\s*true\s*\)/i);
    // Comments are stripped first: these files explain *why* neither role may
    // hold `BYPASSRLS`, and prose about an attribute is not the attribute.
    const statements = SQL.replace(/--[^\n]*/g, '');
    expect(statements).not.toMatch(/(?<!NO)BYPASSRLS/);
  });
});
