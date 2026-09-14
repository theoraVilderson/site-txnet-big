import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { BackendI18nKeys } from '@txnet-backend/shared-core';
import { BotCopy } from './bot-copy';
import { BOT_COPY_FALLBACKS } from './bot-copy.fallbacks';
import { BotKeys, botLinkMessageKey } from './bot-keys';
import { BotFlow } from '../conversation/nav.types';
import { CHANNEL_NAME_KEY } from '../flows/otp.step';
import { CHANNEL_SUMMARY_KEY, PROGRESS_KEY, stepsOf } from '../flows/steps';

/**
 * The copy contract.
 *
 * Every sentence this bot says lives in three places that have to move
 * together: `locales/backend/langs/fa/bot.json`, its English twin, and
 * `bot-copy.fallbacks.ts`. `locales/scripts/validate.ts` already holds fa and
 * en to each other; nothing held either of them to the fallback table, or to
 * the keys the code actually asks for. A rewrite of the *values* — which is
 * the whole point of this copy — must not be able to rename, drop or orphan a
 * key without a red test, because every one of those failures is silent at
 * runtime: `BotCopy` renders the raw key and the bot keeps answering.
 */

/** Walk up to the repo root — the spec must survive the unit moving. */
function repoRoot(): string {
  let dir = __dirname;
  while (!existsSync(join(dir, 'locales', 'backend', 'langs'))) {
    const up = dirname(dir);
    if (up === dir) throw new Error('locales/backend/langs not found above ' + __dirname);
    dir = up;
  }
  return dir;
}

const ROOT = repoRoot();

/** `bot.json` is nested; every key the bot uses is the flat `bot.`-prefixed one. */
function flatten(obj: Record<string, unknown>, prefix: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v && typeof v === 'object') Object.assign(out, flatten(v as Record<string, unknown>, `${prefix}${k}.`));
    else out[`${prefix}${k}`] = String(v);
  }
  return out;
}

function langFile(lang: string): Record<string, string> {
  const path = join(ROOT, 'locales', 'backend', 'langs', lang, 'bot.json');
  return flatten(JSON.parse(readFileSync(path, 'utf-8')), 'bot.');
}

const fa = langFile('fa');
const en = langFile('en');
const fallback = BOT_COPY_FALLBACKS;

/**
 * Every key the code can ask for. Flows reach keys only through `BotKeys`
 * (C-07 forbids a literal), so its leaves are the whole set the code can
 * name; the keys chosen at runtime go through exhaustive `Record`s of a union,
 * which do not compile until each member has a key.
 */
function leaves(tree: object, out: string[] = []): string[] {
  for (const value of Object.values(tree)) {
    if (typeof value === 'string') out.push(value);
    else leaves(value as object, out);
  }
  return out;
}
const botKeys = leaves(BotKeys).sort();

function placeholders(text: string): string[] {
  return [...text.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort();
}

describe('bot copy — the three files move together', () => {
  it('fa carries exactly the keys the fallback table does', () => {
    expect(Object.keys(fa).sort()).toEqual(Object.keys(fallback).sort());
  });

  it('en carries exactly the keys the fallback table does', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(fallback).sort());
  });

  it.each(Object.keys(fallback).sort())('%s says something in every language', (key) => {
    // A blank string passes `locales/scripts/validate.ts` and reaches the user
    // as an empty message — the exact failure the fallback table exists for.
    expect(fa[key].trim()).not.toEqual('');
    expect(en[key].trim()).not.toEqual('');
    expect(fallback[key].trim()).not.toEqual('');
  });
});

describe('bot copy — placeholders survive a rewrite', () => {
  it.each(Object.keys(fallback).sort())('%s interpolates the same values everywhere', (key) => {
    // `BotCopy.interpolate` is a plain `{{var}}` substitution against the
    // values the *flow* passed. A translation that invents `{{n}}` renders it
    // literally; one that drops `{{name}}` silently loses the account name.
    const expected = placeholders(fallback[key]);
    expect(placeholders(fa[key])).toEqual(expected);
    expect(placeholders(en[key])).toEqual(expected);
  });
});

describe('bot copy — every key the code asks for exists', () => {
  it('the fallback table is exactly the generated bot namespace', () => {
    expect(Object.keys(fallback).sort()).toEqual(botKeys);
  });

  it.each(Object.entries(PROGRESS_KEY))('the %s flow counts steps only when it has a progress line', (flow, key) => {
    // `accounts` is one screen: no steps, so no key — and a flow with steps
    // and no key would silently lose its progress line.
    const steps = stepsOf({ flow: flow as BotFlow, step: '', data: {} });
    expect(key === null).toBe(steps.length === 0);
  });

  it.each(Object.keys(CHANNEL_NAME_KEY))('%s has a channel name and a summary line', (channel) => {
    for (const key of [
      CHANNEL_NAME_KEY[channel as keyof typeof CHANNEL_NAME_KEY],
      CHANNEL_SUMMARY_KEY[channel as keyof typeof CHANNEL_SUMMARY_KEY],
    ]) {
      expect(Object.keys(fa)).toContain(key);
    }
  });

  it('maps a link outcome to its notifications key, and an unknown one to try-again', () => {
    expect(botLinkMessageKey('linked')).toBe(BackendI18nKeys.notifications.otp.botLink.linked);
    expect(botLinkMessageKey('noSuchOutcome')).toBe(BotKeys.common.tryAgain);
    expect(botLinkMessageKey('toString')).toBe(BotKeys.common.tryAgain);
  });
});

describe('BotCopy renders what the copy promises', () => {
  const copy = (served: Record<string, string>) =>
    new BotCopy({ getKey: (_l: string, _ns: string, k: string) => served[k] } as never);

  it('takes the translation locale-service serves', () => {
    const text = copy({ 'accounts.switched': 'حالا {{name}} هستید.' }).text('fa', {
      key: 'bot.accounts.switched',
      values: { name: 'مریم' },
    });
    expect(text).toBe('حالا مریم هستید.');
  });

  it('falls back to English rather than saying nothing', () => {
    // The key reached production before its translation did. The fallback is
    // the whole reason a rewrite may not rename a key.
    const text = copy({}).text('fa', { key: 'bot.accounts.switched', values: { name: 'Maryam' } });
    expect(text).toBe(BOT_COPY_FALLBACKS['bot.accounts.switched'].replace('{{name}}', 'Maryam'));
  });

  it('leaves a placeholder the flow did not fill visible', () => {
    const text = copy({ 'progress.login': 'step {{n}} of {{total}}' }).text('fa', {
      key: 'bot.progress.login',
      values: { n: 2 },
    });
    expect(text).toBe('step 2 of {{total}}');
  });

  it('passes an already-localized `raw` sentence through', () => {
    const text = copy({}).text('fa', { raw: 'کد اشتباه است.' });
    expect(text).toBe('کد اشتباه است.');
  });
});
