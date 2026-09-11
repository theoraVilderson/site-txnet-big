import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { BOT_LINK_MESSAGE_KEY } from '../auth/bot-link/bot-link.messages';
import { OtpPurpose } from '../auth/otp/otp.interface';
import { OTP_TITLE_KEY } from '../auth/otp/senders/otp-message.util';

/**
 * Keys chosen at runtime (F-084, ADR-0036).
 *
 * Generated constants make a *renamed* key a compile error only where the key
 * is spelled out. Where the code picks one from a union — an OTP purpose, a
 * bot-link outcome — the exhaustive maps next to that code are the
 * compile-time half, and this file is the other: every member has a sentence
 * in every language, because a missing one renders as the raw key and throws
 * nothing. It is the pattern `bot-copy.spec.ts` already established.
 */

const LOCALES = join(__dirname, '../../../../../locales/backend/langs');

function namespace(lang: string, ns: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (prefix: string, v: unknown) => {
    if (v && typeof v === 'object') {
      for (const [k, c] of Object.entries(v)) walk(prefix ? `${prefix}.${k}` : k, c);
    } else if (typeof v === 'string') out.set(prefix, v);
  };
  walk('', JSON.parse(readFileSync(join(LOCALES, lang, `${ns}.json`), 'utf8')));
  return out;
}

describe.each(['fa', 'en'])('runtime-chosen keys in %s', (lang) => {
  const notifications = namespace(lang, 'notifications');

  it.each(Object.entries(OTP_TITLE_KEY))('OTP purpose %s has a title', (_purpose, key) => {
    expect(notifications.get(key)?.trim()).toBeTruthy();
  });

  it.each(Object.entries(BOT_LINK_MESSAGE_KEY))('bot-link message %s has a sentence', (_m, key) => {
    expect(notifications.get(key)?.trim()).toBeTruthy();
  });
});

describe('the map and the runtime lookup name the same key', () => {
  it('reads each OTP title under its own purpose', () => {
    // `resolveTitle` reads `otp.title[purpose]`. If a row here pointed at a
    // different key, the build would pass and the lookup would still miss.
    for (const purpose of Object.values(OtpPurpose)) {
      expect(OTP_TITLE_KEY[purpose]).toBe(`otp.title.${purpose}`);
    }
  });
});

/**
 * `otp.botLink.*` exists in two namespaces on purpose, and this pins that it is
 * on purpose. Five failure names are thrown as `errors` — the site shows them —
 * and sent to the chat from `notifications`, where the sentence also says what
 * to do next ("use the button below"). The texts already differ in every case,
 * so collapsing them is a copy decision, not a refactor
 * (`identity/open-questions.md`, 2026-09-11).
 *
 * What must not happen is the *names* drifting: a failure renamed in one file
 * and not the other shows the raw key on whichever surface was missed.
 */
describe('the bot-link failures both surfaces show', () => {
  const FAILURES = ['expired', 'noAccount', 'phoneMismatch', 'senderMismatch', 'takenByAnotherAccount'];

  it.each(['fa', 'en'])('every failure has a site sentence and a chat sentence in %s', (lang) => {
    const errors = namespace(lang, 'errors');
    const notifications = namespace(lang, 'notifications');
    for (const name of FAILURES) {
      expect(errors.get(`otp.botLink.${name}`)?.trim()).toBeTruthy();
      expect(notifications.get(`otp.botLink.${name}`)?.trim()).toBeTruthy();
    }
  });

  it('the errors family holds exactly the failures, nothing conversational', () => {
    const errors = [...namespace('fa', 'errors').keys()]
      .filter((k) => k.startsWith('otp.botLink.'))
      .map((k) => k.slice('otp.botLink.'.length))
      .sort();
    expect(errors).toEqual([...FAILURES].sort());
  });
});
