import { REFRESH_TOKEN_LIFETIME_SEC } from '../http/cookies';
import { RedisTtl } from './ttl';

/**
 * The TTL catalogue (F-078, ADR-0036).
 *
 * Most of these assertions are **ordering relationships**, not values. That is
 * the whole reason the numbers had to come into one file: a rule like "the
 * pending registration must outlast the code that unlocks it" cannot be
 * checked while the two numbers live in different services, and both of the
 * ones below were previously only prose in a doc comment.
 *
 * A TTL that breaks one of these does not throw. It produces a user holding a
 * valid OTP that verifies nothing, or a socket waiting for an event that can
 * never arrive — failures that look like flakiness and get retried rather than
 * reported.
 */
describe('RedisTtl', () => {
  it('never lets a pending registration expire before the OTP that unlocks it', () => {
    // identity/invariants.md #11: the `user` row is created by verify-phone
    // from the pending payload. If the payload goes first, a valid code
    // arrives with nothing left to register.
    expect(RedisTtl.registerPending).toBeGreaterThanOrEqual(RedisTtl.otpCode);
  });

  it('never lets a delivery status outlive the code it describes', () => {
    // A status readable after its code is dead answers a question about a
    // send that can no longer be used — which is the account-existence probe
    // the 202 routes exist to refuse.
    expect(RedisTtl.otpDelivery).toBeLessThanOrEqual(RedisTtl.otpCode);
  });

  it('never lets a realtime channel outlive the result it carries', () => {
    // A subscription past this point is a socket held open for an event that
    // can never come.
    expect(RedisTtl.otpChannel).toBeLessThanOrEqual(RedisTtl.otpDelivery);
  });

  it('keeps the OTP lock far shorter than the cooldown it guards', () => {
    // The lock is idempotency for the seconds a send takes; the cooldown is
    // the actual policy. A lock approaching the cooldown would start refusing
    // legitimate retries as if they were duplicates.
    expect(RedisTtl.otpLock).toBeLessThan(RedisTtl.otpCooldown);
  });

  it('expires a negative tenant resolution much sooner than a positive one', () => {
    // An unknown host is what a stranger sends, so this bounds how many keys a
    // flood of invented hostnames can hold at once (ADR-0025).
    expect(RedisTtl.tenantResolutionMiss).toBeLessThan(
      RedisTtl.tenantResolution,
    );
  });

  it('lets a chat keep its language long after its session is gone', () => {
    // A preference that expires with the conversation that set it is one the
    // user has to set again every time.
    expect(RedisTtl.botLang).toBeGreaterThan(RedisTtl.botSession);
    expect(RedisTtl.botSession).toBeGreaterThan(RedisTtl.botNav);
  });

  it('keeps an impersonated session far shorter than an ordinary one', () => {
    // identity/invariants.md #7. The whole point of the limit is that a
    // support agent's borrowed session cannot quietly become a long-lived one.
    expect(RedisTtl.impersonation).toBeLessThan(RedisTtl.refreshToken);
  });

  it('takes the refresh lifetime from the cookie declaration, not a copy', () => {
    // One lifetime for the cookie and the token it carries (F-073). A second
    // number here is exactly the split this catalogue exists to close.
    expect(RedisTtl.refreshToken).toBe(REFRESH_TOKEN_LIFETIME_SEC);
  });

  it('gives every entry a positive whole number of seconds', () => {
    for (const [name, value] of Object.entries(RedisTtl)) {
      expect(`${name}=${value}`).toBe(`${name}=${Math.floor(value)}`);
      expect(value).toBeGreaterThan(0);
    }
  });

  it('records the whole catalogue in one place', () => {
    expect(RedisTtl).toMatchSnapshot();
  });
});
