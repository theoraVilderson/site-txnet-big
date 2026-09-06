import { CanActivate, ForbiddenException } from '@nestjs/common';
import { PermissionsGuard } from './permissions.guard';
import { PermissionsGuard as ImpersonationPermissionsGuard } from '../../impersonation/guards/permissions.guard';
import { fakeExecutionContext } from '../../../test-support/execution-context';

/**
 * There are two PermissionsGuard classes in this service — this one and
 * `impersonation/guards/permissions.guard.ts`. They are, today, identical
 * copies. Every case below runs against both, so the day one of them grows an
 * impersonation-specific rule (say, refusing a permission the impersonator
 * only holds through the impersonated user) the shared expectations fail and
 * the difference has to be stated rather than drifting in silently.
 */
const implementations: Array<[string, new (perms: string[]) => CanActivate]> = [
  ['auth', PermissionsGuard],
  ['impersonation', ImpersonationPermissionsGuard],
];

describe.each(implementations)('PermissionsGuard (%s)', (_name, Guard) => {
  const contextFor = (user: unknown) => fakeExecutionContext({ user }).context;

  it('lets a user holding the single required permission through', () => {
    const guard = new Guard(['user.read']);

    expect(guard.canActivate(contextFor({ permissions: ['user.read'] }))).toBe(
      true,
    );
  });

  it('requires every listed permission, not just one of them', () => {
    const guard = new Guard(['user.read', 'user.write']);

    expect(() =>
      guard.canActivate(contextFor({ permissions: ['user.read'] })),
    ).toThrow('Insufficient permissions');
  });

  it('passes when the user holds all of them plus more', () => {
    const guard = new Guard(['user.read', 'user.write']);

    expect(
      guard.canActivate(
        contextFor({ permissions: ['user.write', 'billing.read', 'user.read'] }),
      ),
    ).toBe(true);
  });

  it('lets an empty requirement list through', () => {
    const guard = new Guard([]);

    expect(guard.canActivate(contextFor({ permissions: [] }))).toBe(true);
  });

  // A missing user means AuthGuard never ran on this route — a wiring mistake,
  // not a permission decision. It must still not fall open.
  it('rejects a request with no user attached', () => {
    const guard = new Guard(['user.read']);

    expect(() => guard.canActivate(contextFor(undefined))).toThrow(
      ForbiddenException,
    );
  });

  it.each([
    ['a user with no permissions field', {}],
    ['a user whose permissions are empty', { permissions: [] }],
    ['a user holding only unrelated permissions', { permissions: ['tenant.read'] }],
  ])('rejects %s', (_label, user) => {
    const guard = new Guard(['user.read']);

    expect(() => guard.canActivate(contextFor(user))).toThrow(
      ForbiddenException,
    );
  });

  // Permission names are compared verbatim; there is no wildcard or prefix
  // expansion anywhere in this guard.
  it.each([
    ['a prefix of the required name', 'user'],
    ['a wildcard', 'user.*'],
    ['a differently-cased name', 'User.Read'],
    ['a longer name that starts the same', 'user.readAll'],
  ])('does not accept %s as the required permission', (_label, held) => {
    const guard = new Guard(['user.read']);

    expect(() => guard.canActivate(contextFor({ permissions: [held] }))).toThrow(
      ForbiddenException,
    );
  });

  it('answers 403 in both the no-user and the wrong-permission case', () => {
    const guard = new Guard(['user.read']);

    expect(() => guard.canActivate(contextFor(undefined))).toThrow(
      expect.objectContaining({ status: 403 }),
    );
    expect(() =>
      guard.canActivate(contextFor({ permissions: [] })),
    ).toThrow(expect.objectContaining({ status: 403 }));
  });
});
