import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { METER_KEYS, meterNameKey } from './meter';

/**
 * A meter's name ships with the code that adds it (F-118-s, D-59 (a)).
 *
 * A meter exists only where code reports it, so no screen writes its name:
 * `catalog.meter.<key>.name` is committed in `locales/shareds/<lang>/catalog.json`
 * for every language the panel has, in the commit that adds the meter. A key
 * with no text reaches the package and variant forms as the raw key.
 */

const LOCALES = join(__dirname, '../../../../../locales');
const MIGRATIONS = join(__dirname, '../../../../prisma/domains/migrations');

const languages = readdirSync(join(LOCALES, 'frontend', 'langs')).filter((d) =>
  statSync(join(LOCALES, 'frontend', 'langs', d)).isDirectory(),
);

/** `catalog.meter.vpn.traffic.name` in a nested namespace file, the way locale-service flattens it. */
function textAt(lang: string, key: string): unknown {
  const file = join(LOCALES, 'shareds', lang, 'catalog.json');
  let node: unknown = JSON.parse(readFileSync(file, 'utf8'));
  for (const part of key.replace(/^catalog\./, '').split('.')) {
    node = node !== null && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined;
  }
  return node;
}

/** Every `INSERT INTO "catalog"."meter"` a migration makes: its key and nameKey. */
function seededMeters(): { key: string; nameKey: string }[] {
  const out: { key: string; nameKey: string }[] = [];
  const insert = /INSERT INTO "catalog"\."meter"\s*\([^)]*\)\s*VALUES\s*\(gen_random_uuid\(\),\s*'([^']+)',\s*'[^']+',\s*'[^']+',\s*'([^']+)'\)/g;
  for (const dir of readdirSync(MIGRATIONS)) {
    const sql = join(MIGRATIONS, dir, 'migration.sql');
    let text: string;
    try {
      text = readFileSync(sql, 'utf8');
    } catch {
      continue;
    }
    for (const m of text.matchAll(insert)) out.push({ key: m[1], nameKey: m[2] });
  }
  return out;
}

describe('meter names ship with the code (F-118-s)', () => {
  it('reads fa and en at least', () => {
    expect(languages).toEqual(expect.arrayContaining(['fa', 'en']));
  });

  it.each(Object.values(METER_KEYS))('names %s in every language', (key) => {
    for (const lang of languages) {
      const text = textAt(lang, meterNameKey(key));
      expect({ lang, key, text: typeof text === 'string' && text.trim() !== '' && text !== key }).toEqual({ lang, key, text: true });
    }
  });

  it('seeds each meter under the key code names it by, with the nameKey the panel reads', () => {
    const seeded = seededMeters();
    expect(seeded.map((m) => m.key).sort()).toEqual(Object.values(METER_KEYS).sort());
    for (const m of seeded) expect(m.nameKey).toBe(meterNameKey(m.key));
  });
});
