import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TimeZoneSource } from '@prisma/client';

import { PLATFORM_DEFAULT_TIMEZONE, TIME_ZONE_SOURCES } from './time-zone';

/**
 * The item's one spec (TZ-1-b, ADR-0108 point 2). The columns repeat two facts
 * the resolver owns, in places TypeScript cannot reach: the source enum, and
 * the tenant's default zone. A Prisma `@default` and a migration cannot import
 * `PLATFORM_DEFAULT_TIMEZONE`, so this is where the drift is caught.
 */

const DOMAINS = join(__dirname, '../../../../prisma/domains');
const migration = readdirSync(join(DOMAINS, 'migrations')).find((d) => d.endsWith('_a_person_has_a_time_zone'));

describe('the time-zone columns', () => {
  it('store exactly the sources the resolver knows', () => {
    expect(Object.values(TimeZoneSource).sort()).toEqual([...TIME_ZONE_SOURCES].sort());
  });

  it('default a tenant to the platform constant, in the schema and in the migration', () => {
    const tenantModel = readFileSync(join(DOMAINS, 'tenant.prisma'), 'utf8').split('model Tenant {')[1].split('\n}')[0];
    expect(tenantModel).toMatch(new RegExp(`timezone\\s+String\\s+@default\\("${PLATFORM_DEFAULT_TIMEZONE}"\\)`));
    expect(migration).toBeDefined();
    const sql = readFileSync(join(DOMAINS, 'migrations', migration as string, 'migration.sql'), 'utf8');
    expect(sql).toContain(`"timezone" TEXT NOT NULL DEFAULT '${PLATFORM_DEFAULT_TIMEZONE}'`);
  });
});
