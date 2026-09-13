import { ALL_PERMISSIONS, holdsPermission } from './permissions';

/**
 * F-101-d — the one place a held permission list is asked "may this caller".
 * Every TypeScript check site calls this, so what `*` means is decided here
 * once. The cases that would break silently are the ones that grant too much:
 * a pattern that looks like a wildcard and is not, and a required `*` treated
 * as satisfied by an ordinary key.
 */
describe('holdsPermission', () => {
  it('is the literal "*"', () => {
    expect(ALL_PERMISSIONS).toBe('*');
  });

  it('matches a held key exactly, case included', () => {
    expect(holdsPermission(['user.read'], 'user.read')).toBe(true);
    expect(holdsPermission(['user.read'], 'User.Read')).toBe(false);
    expect(holdsPermission(['user.read'], 'user.write')).toBe(false);
  });

  it('lets "*" satisfy any key, including one no role file has seen yet', () => {
    expect(holdsPermission([ALL_PERMISSIONS], 'settlement.manage')).toBe(true);
    expect(holdsPermission([ALL_PERMISSIONS], 'feature.added.tomorrow')).toBe(true);
  });

  it('treats only the bare "*" as the wildcard — never a prefix pattern', () => {
    expect(holdsPermission(['user.*'], 'user.read')).toBe(false);
    expect(holdsPermission(['*.read'], 'user.read')).toBe(false);
    expect(holdsPermission([' *'], 'user.read')).toBe(false);
  });

  it('refuses a caller with no list at all', () => {
    expect(holdsPermission(undefined, 'user.read')).toBe(false);
    expect(holdsPermission([], 'user.read')).toBe(false);
  });
});
