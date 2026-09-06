import { CanActivate, ForbiddenException } from '@nestjs/common';
import { SensitiveActionGuard } from './sensitive-action.guard';
import { SensitiveActionGuard as ImpersonationSensitiveActionGuard } from '../../impersonation/guards/sensetive-action.guard';
import { fakeExecutionContext } from '../../../test-support/execution-context';

/**
 * As with PermissionsGuard, this class exists twice — here and in
 * `impersonation/guards/sensetive-action.guard.ts` (the filename typo is in
 * the tree). The two are identical copies today, so both are held to the same
 * expectations; a future divergence has to break a test to happen.
 */
const implementations: Array<[string, new () => CanActivate]> = [
  ['auth', SensitiveActionGuard],
  ['impersonation', ImpersonationSensitiveActionGuard],
];

describe.each(implementations)('SensitiveActionGuard (%s)', (_name, Guard) => {
  const contextFor = (user: unknown) => fakeExecutionContext({ user }).context;
  let guard: CanActivate;

  beforeEach(() => {
    guard = new Guard();
  });

  it('blocks an impersonated caller', () => {
    expect(() =>
      guard.canActivate(contextFor({ sub: 'user-1', isImpersonated: true })),
    ).toThrow(ForbiddenException);
  });

  it('says why it blocked, and answers 403', () => {
    expect(() =>
      guard.canActivate(contextFor({ isImpersonated: true })),
    ).toThrow('Sensitive actions are not allowed during impersonation');
    expect(() =>
      guard.canActivate(contextFor({ isImpersonated: true })),
    ).toThrow(expect.objectContaining({ status: 403 }));
  });

  it('lets a real signed-in user through', () => {
    expect(
      guard.canActivate(contextFor({ sub: 'user-1', isImpersonated: false })),
    ).toBe(true);
  });

  it('lets a user with no impersonation flag through', () => {
    expect(guard.canActivate(contextFor({ sub: 'user-1' }))).toBe(true);
  });

  // This guard only answers "is this an impersonated session"; whether there
  // is a session at all is AuthGuard's question, and it runs first.
  it('lets a request with no user through', () => {
    expect(guard.canActivate(contextFor(undefined))).toBe(true);
  });

  // `isImpersonated` arrives from JSON token claims, so a truthy non-boolean
  // is reachable. It must be treated as impersonation, not shrugged off.
  it.each([['the string "true"', 'true'], ['1', 1]])(
    'blocks when isImpersonated is %s',
    (_label, flag) => {
      expect(() =>
        guard.canActivate(contextFor({ isImpersonated: flag })),
      ).toThrow(ForbiddenException);
    },
  );

  it.each([
    ['false', false],
    ['undefined', undefined],
    ['null', null],
  ])('allows when isImpersonated is %s', (_label, flag) => {
    expect(guard.canActivate(contextFor({ isImpersonated: flag }))).toBe(true);
  });
});
