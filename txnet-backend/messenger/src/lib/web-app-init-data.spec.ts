import { createHmac } from 'crypto';
import {
  verifyWebAppInitData,
  WEB_APP_INIT_DATA_MAX_AGE_SEC,
} from './web-app-init-data';

/**
 * This is the one thing in `F-310` that fails silently.
 *
 * Everything else about the Mini App announces its own breakage — a missing
 * button is missing, a failed sign-in lands on the login screen. A signature
 * check that is subtly wrong keeps working for every honest caller and stops
 * being a check: it is the whole reason a webview may mint a session, so what
 * is asserted here is that a string this code did not sign is refused, in each
 * of the ways it can be unsigned.
 */

const TOKEN = '123456:AAH-test-bot-token';

/** Sign a payload exactly the way a platform does, so the test is not simply
 * the implementation read back to itself. */
function sign(fields: Record<string, string>, token = TOKEN): string {
  const checkString = Object.keys(fields)
    .sort()
    .map((key) => `${key}=${fields[key]}`)
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  const hash = createHmac('sha256', secret).update(checkString).digest('hex');
  const params = new URLSearchParams({ ...fields, hash });
  return params.toString();
}

const now = new Date('2026-09-08T12:00:00Z');
const authDate = String(Math.floor(now.getTime() / 1000) - 60);
const user = JSON.stringify({ id: 5501, first_name: 'Ava', username: 'ava' });

describe('verifyWebAppInitData', () => {
  it('accepts what the platform signed, and reads the user out of it', () => {
    const initData = sign({ auth_date: authDate, user, query_id: 'AAF' });

    const result = verifyWebAppInitData('telegram', TOKEN, initData, undefined, now);

    expect(result).toMatchObject({
      ok: true,
      data: {
        platform: 'telegram',
        authDate: Number(authDate),
        user: { id: '5501', firstName: 'Ava', username: 'ava' },
      },
    });
  });

  it('refuses a string signed with another bot token', () => {
    const initData = sign({ auth_date: authDate, user }, '999:someone-elses');

    expect(
      verifyWebAppInitData('telegram', TOKEN, initData, undefined, now),
    ).toEqual({ ok: false, reason: 'badSignature' });
  });

  it('refuses a field edited after signing', () => {
    // The exact attack the signature exists for: a valid string whose `user`
    // has been swapped for somebody else's id.
    const initData = sign({ auth_date: authDate, user }).replace(
      encodeURIComponent('5501'),
      encodeURIComponent('9999'),
    );

    expect(
      verifyWebAppInitData('telegram', TOKEN, initData, undefined, now),
    ).toEqual({ ok: false, reason: 'badSignature' });
  });

  it('refuses a signature older than the replay window', () => {
    const stale = String(
      Math.floor(now.getTime() / 1000) - WEB_APP_INIT_DATA_MAX_AGE_SEC - 1,
    );
    const initData = sign({ auth_date: stale, user });

    expect(
      verifyWebAppInitData('telegram', TOKEN, initData, undefined, now),
    ).toEqual({ ok: false, reason: 'expired' });
  });

  it('refuses a correctly signed string that names nobody', () => {
    // Signed by the bot, so the signature passes — and it still says nothing
    // about who is looking at the page.
    const initData = sign({ auth_date: authDate, query_id: 'AAF' });

    expect(
      verifyWebAppInitData('telegram', TOKEN, initData, undefined, now),
    ).toEqual({ ok: false, reason: 'noUser' });
  });

  it('refuses an empty string and an unconfigured bot', () => {
    expect(verifyWebAppInitData('bale', TOKEN, '', undefined, now)).toEqual({
      ok: false,
      reason: 'malformed',
    });
    expect(
      verifyWebAppInitData('bale', '', sign({ auth_date: authDate, user }), undefined, now),
    ).toEqual({ ok: false, reason: 'malformed' });
  });
});
