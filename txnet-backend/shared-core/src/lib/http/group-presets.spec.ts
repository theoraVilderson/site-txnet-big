import { GROUP_PRESETS } from './group-presets';
import { PERMISSION_REGISTRY } from './permission-registry.generated';

/**
 * GR-1-h — the starting points the create-group wizard offers. A preset is a
 * template, never a group: what this pins is that it can only ever name a key
 * the policy file knows, and never one a reseller could not be given, so a
 * renamed or removed key fails here instead of vanishing from a preset.
 */
describe('GROUP_PRESETS', () => {
  const known = new Map(PERMISSION_REGISTRY.map((r) => [r.permission as string, r.platformOnly as boolean]));

  it('names each preset once', () => {
    const ids = GROUP_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(['support', 'finance', 'sales', 'look', 'admin']);
  });

  it('lists only registry keys, none of them platform-only, each once', () => {
    for (const preset of GROUP_PRESETS) {
      for (const key of preset.keys) {
        expect(known.has(key), `${preset.id}: ${key} is not in the registry`).toBe(true);
        expect(known.get(key), `${preset.id}: ${key} is platform-only`).toBe(false);
      }
      expect(new Set(preset.keys).size).toBe(preset.keys.length);
    }
  });

  it('adds platform keys only as `platformKeys`, every one platform-only — Support\'s `platform.support` (GR-1-s)', () => {
    for (const preset of GROUP_PRESETS) {
      for (const key of preset.platformKeys ?? []) expect(known.get(key), `${preset.id}: ${key}`).toBe(true);
    }
    expect(GROUP_PRESETS.find((p) => p.id === 'support')?.platformKeys).toEqual(['platform.support']);
  });

  it('lets Support see and change the person and fix their services (GR-1-t, user 2026-10-10)', () => {
    const support = GROUP_PRESETS.find((p) => p.id === 'support')?.keys ?? [];
    for (const key of ['user.read', 'user.write', 'grant.read', 'grant.repair', 'support.agent']) expect(support, key).toContain(key);
    // Money and gifts stay with finance and sales.
    for (const key of ['grant.assign', 'wallet.manual_adjust']) expect(support, key).not.toContain(key);
  });

  it('gives a listed preset at least one key, and the admin preset none of its own', () => {
    for (const preset of GROUP_PRESETS) {
      if (preset.every) expect(preset.keys).toEqual([]);
      else expect(preset.keys.length).toBeGreaterThan(0);
    }
    expect(GROUP_PRESETS.filter((p) => p.every).map((p) => p.id)).toEqual(['admin']);
  });
});
