import { trustProxySetting } from './trust-proxy';

/**
 * Express reads `trust proxy` by **type**, and an environment variable is
 * always a string. That one mismatch silently switched off every
 * `X-Forwarded-*` header this platform depends on.
 *
 * `app.set('trust proxy', 1)` means *trust one hop*.
 * `app.set('trust proxy', '1')` means *trust the IP address list ["1"]*, which
 * matches nothing — so `req.hostname` falls back to the raw `Host` header.
 *
 * Nothing failed loudly. Public requests still resolved their tenant, because
 * Traefik preserves the real `Host` and the raw header was already right. Only
 * the **internal** hop broke, where `panel-web`'s proxy calls auth-service
 * directly at `http://auth-service:3000` and the true host travels in
 * `X-Forwarded-Host` (`panel-web/contract.session-guard.md`, F-066-r). There
 * the host read as `auth-service`, resolved to no tenant, and the neutral 404
 * (ADR-0025) made the session guard fail open — so a signed-in visitor was
 * shown the login screen.
 */
describe('trustProxySetting', () => {
  it('turns a hop count into a number, which is the whole bug', () => {
    // `TRUST_PROXY=1` in `.env`, commented there as "1 hop".
    expect(trustProxySetting('1')).toBe(1);
    expect(trustProxySetting('2')).toBe(2);
    expect(trustProxySetting(' 1 ')).toBe(1);
    // Not the string: that is an IP list to Express and matches no proxy.
    expect(trustProxySetting('1')).not.toBe('1');
  });

  it('reads the booleans Express also accepts', () => {
    expect(trustProxySetting('true')).toBe(true);
    expect(trustProxySetting('false')).toBe(false);
    expect(trustProxySetting('TRUE')).toBe(true);
  });

  it('leaves every other form alone, because Express means them as written', () => {
    // Named subnets and address lists are legitimate values and must stay
    // strings — coercing them would break the deployments that use them.
    expect(trustProxySetting('loopback')).toBe('loopback');
    expect(trustProxySetting('10.0.0.0/8, 172.16.0.0/12')).toBe('10.0.0.0/8, 172.16.0.0/12');
    expect(trustProxySetting('uniquelocal')).toBe('uniquelocal');
  });

  it('falls back to one hop when nothing is configured', () => {
    // One hop is this platform's shape: exactly one Traefik in front of every
    // service. An unset variable must not silently mean "trust nothing".
    expect(trustProxySetting(undefined)).toBe(1);
    expect(trustProxySetting('')).toBe(1);
    expect(trustProxySetting('   ')).toBe(1);
  });

  it('refuses a negative hop count rather than passing it to Express', () => {
    // `-1` compiles to a function that trusts everything below index -1, i.e.
    // nothing, which is the same silent failure in a new disguise.
    expect(trustProxySetting('-1')).toBe(1);
  });
});
