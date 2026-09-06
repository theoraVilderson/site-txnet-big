import { buildDeepLink, DEEP_LINK_BASE, parseStart, parseStartPayload } from './deep-link';

describe('deep links', () => {
  it('builds each platform its own host, from one place', () => {
    expect(buildDeepLink(DEEP_LINK_BASE.telegram, 'txnetbot', 'trial')).toBe(
      'https://t.me/txnetbot?start=trial',
    );
    expect(buildDeepLink(DEEP_LINK_BASE.bale, 'txnetbot', 'trial')).toBe(
      'https://ble.ir/txnetbot?start=trial',
    );
  });

  it('tolerates a trailing slash on the configured base', () => {
    expect(buildDeepLink('https://t.me/', 'txnetbot', 'x')).toBe(
      'https://t.me/txnetbot?start=x',
    );
  });

  it('tells a bare /start from /start <payload> from other text', () => {
    expect(parseStart('/start')).toBe('');
    expect(parseStart('/start abc')).toBe('abc');
    expect(parseStart('/start@txnetbot abc')).toBe('abc');
    expect(parseStart('hello')).toBeNull();
  });

  it('classifies the F-314 payloads and the live F-0203 link token', () => {
    expect(parseStartPayload('')).toEqual({ kind: 'none' });
    expect(parseStartPayload('buy_pro-30')).toEqual({ kind: 'buy', sku: 'pro-30' });
    expect(parseStartPayload('ref_AB12')).toEqual({ kind: 'ref', code: 'AB12' });
    expect(parseStartPayload('trial')).toEqual({ kind: 'trial' });
    expect(parseStartPayload('Zm9vYmFyYmF6cXV4MTIzNA')).toEqual({
      kind: 'link',
      token: 'Zm9vYmFyYmF6cXV4MTIzNA',
    });
  });

  it('reports an unrecognised payload instead of failing on it', () => {
    // It comes from outside: untrusted input, not a command.
    expect(parseStartPayload('../../etc/passwd')).toEqual({
      kind: 'unknown',
      raw: '../../etc/passwd',
    });
  });
});
