import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { BackendI18nKeys } from './keys.backend.generated';

/**
 * The committed backend key catalogue (F-080, ADR-0036).
 *
 * CI already fails when this file is stale (`make i18n-keys && git diff
 * --exit-code`). This spec covers what that check cannot: that the generated
 * object actually *is* `locales/backend` — every key present, nothing invented,
 * every leaf equal to its own path — so a hand edit to the "do not edit" file
 * that happens to be regenerated consistently is still caught.
 *
 * It reads `locales/` directly on purpose. No other test in the repo did, which
 * is how a key could be renamed in JSON with every suite staying green.
 */

const LOCALES = join(__dirname, '../../../../../locales');
const REFERENCE = join(LOCALES, 'backend', 'langs', 'fa');

type Tree = { [k: string]: Tree | string };

function flatten(prefix: string, value: unknown, out: Set<string>): void {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const [k, child] of Object.entries(value)) {
      flatten(prefix ? `${prefix}.${k}` : k, child, out);
    }
  } else if (['string', 'number', 'boolean'].includes(typeof value)) {
    out.add(prefix);
  }
}

function leaves(tree: Tree, out: Array<[path: string, value: string]>, prefix = ''): void {
  for (const [k, v] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'string') out.push([path, v]);
    else leaves(v, out, path);
  }
}

const namespaces = readdirSync(REFERENCE)
  .filter((f) => f.endsWith('.json') && f !== 'metadata.json')
  .map((f) => f.slice(0, -'.json'.length))
  .sort();

describe('BackendI18nKeys', () => {
  it('has exactly the namespaces locales/backend has', () => {
    expect(Object.keys(BackendI18nKeys).sort()).toEqual(namespaces);
  });

  it.each(namespaces)('holds every key of %s, and nothing else', (ns) => {
    const onDisk = new Set<string>();
    flatten('', JSON.parse(readFileSync(join(REFERENCE, `${ns}.json`), 'utf8')), onDisk);

    const generated: Array<[string, string]> = [];
    leaves((BackendI18nKeys as unknown as Record<string, Tree>)[ns], generated);

    expect(generated.map(([path]) => path).sort()).toEqual([...onDisk].sort());
  });

  it('makes every leaf the key string itself', () => {
    // The whole contract of the generated object: passing a constant to the
    // translator passes exactly the string a literal used to.
    for (const ns of namespaces) {
      const generated: Array<[string, string]> = [];
      leaves((BackendI18nKeys as unknown as Record<string, Tree>)[ns], generated);
      for (const [path, value] of generated) expect(value).toBe(path);
    }
  });

  it('exposes the keys the gateway and auth-api both depend on', () => {
    // F-081 moves these off literals in two languages. They are named here so a
    // regeneration that dropped one fails with the reason attached.
    expect(BackendI18nKeys.errors.auth.invalidToken).toBe('auth.invalidToken');
    expect(BackendI18nKeys.errors.permissions.forbidden).toBe('permissions.forbidden');
    expect(BackendI18nKeys.errors.system.unexpected).toBe('system.unexpected');
  });
});
