/**
 * Every route that accepts a proof of an account is captcha-gated (F-0201).
 *
 * `@RequireCaptcha` is opt-in per handler, so the way it breaks is silent: a
 * route that takes a phone number, a password or a one-time code and carries no
 * decorator is simply ungated, and nothing about the route says so. That is how
 * `POST /auth/accounts/add/*` shipped with the rate limit its catalog row asks
 * for and none of the bot check its sibling `login` routes have — the two proofs
 * F-0205 calls "rate-limited exactly like a login" were, for a scripted caller,
 * strictly cheaper than one.
 *
 * So the expectation is a **list**, not a scan: no property of a handler says
 * whether it proves a credential, and guessing from its name would either miss
 * the next one or gate a read. Naming them means adding a proof route without a
 * gate is a deliberate edit to this file and shows up in a diff as one — and the
 * equality assertion catches the reverse too, a gate quietly dropped from a
 * route that still has one here.
 *
 * The service-caller exemption (ADR-0011) is not in scope here: it is decided
 * inside `CaptchaGuard` and covered by `captcha.guard.spec.ts`. This file only
 * asks which routes the guard is asked about at all.
 */
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';

import { AuthController } from '../../auth/auth.controller';
import { RegisterController } from '../../auth/register/register.controller';
import { AccountSwitchController } from '../../account-switch/account-switch.controller';
import { REQUIRE_CAPTCHA_KEY } from '../../auth/decorators/require-captcha.decorator';

/** Importing a controller pulls in its whole Nest module graph — see the
 *  budget `billing-service`'s `rate-limit-coverage.spec.ts` explains. */
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const CONTROLLERS = [AuthController, RegisterController, AccountSwitchController];

/**
 * Every route a browser may use to offer a credential — a password, a phone
 * number that causes a code to be sent, or an identifier that says whether an
 * account exists.
 *
 * The `verify` halves are deliberately absent. A caller reaches them holding a
 * code that was already gated on its way out, they spend a single-use secret
 * rather than guessing one, and each has a tighter per-caller limit of its own;
 * requiring a second pass there would cost a re-slide mid-flow for nothing.
 */
const MUST_BE_GATED = [
  'POST auth/register',
  'POST auth/login/password',
  'POST auth/login/otp/request',
  'POST auth/password/forgot',
  'POST auth/accounts/add/otp/request',
  'POST auth/accounts/add/password',
];

type Route = { name: string; gated: boolean };

function routesOf(controller: new (...args: any[]) => unknown): Route[] {
  const prefix = Reflect.getMetadata(PATH_METADATA, controller) ?? '';
  const proto = controller.prototype;
  return Object.getOwnPropertyNames(proto)
    .filter((key) => key !== 'constructor')
    .map((key) => Reflect.getOwnPropertyDescriptor(proto, key)!.value)
    .filter((handler) => typeof handler === 'function')
    .filter((handler) => Reflect.getMetadata(PATH_METADATA, handler) !== undefined)
    .map((handler) => {
      const path = Reflect.getMetadata(PATH_METADATA, handler);
      const method = Reflect.getMetadata(METHOD_METADATA, handler);
      const verb = RequestMethod[method] ?? 'ALL';
      const full = [prefix, path].filter((p) => p && p !== '/').join('/');
      return {
        name: `${verb} ${full}`,
        gated: Reflect.getMetadata(REQUIRE_CAPTCHA_KEY, handler) === true,
      };
    });
}

describe('captcha coverage', () => {
  const routes = CONTROLLERS.flatMap(routesOf);

  it('finds the routes it means to check', () => {
    // A rename that empties the scan would otherwise make every assertion
    // below pass by describing nothing.
    const names = routes.map((r) => r.name);
    for (const expected of MUST_BE_GATED) expect(names).toContain(expected);
  });

  it.each(MUST_BE_GATED)('%s carries @RequireCaptcha', (name) => {
    expect(routes.find((r) => r.name === name)?.gated).toBe(true);
  });

  it('gates nothing else — the list is the whole gated surface', () => {
    const gated = routes.filter((r) => r.gated).map((r) => r.name).sort();
    expect(gated).toEqual([...MUST_BE_GATED].sort());
  });
});
