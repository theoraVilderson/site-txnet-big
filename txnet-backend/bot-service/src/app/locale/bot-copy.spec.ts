import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { dirname, join } from 'path';
import { BotCopy } from './bot-copy';
import { BOT_COPY_FALLBACKS } from './bot-copy.fallbacks';
import { BotFlow } from '../conversation/nav.types';
import { OtpChannelName } from '../auth-api/auth-api.types';
import { stepsOf } from '../flows/steps';

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
const SRC = join(ROOT, 'txnet-backend', 'bot-service', 'src');

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

/** Every `'bot.*'` literal in shipped code — what the flows and views ask for. */
function keysUsedInCode(): string[] {
  const found = new Set<string>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith('.ts') && !name.endsWith('.spec.ts')) {
        for (const m of readFileSync(path, 'utf-8').matchAll(/'(bot\.[A-Za-z.]+)'/g)) found.add(m[1]);
      }
    }
  };
  walk(SRC);
  return [...found].sort();
}

/**
 * The keys code builds at runtime instead of spelling out, so the scan above
 * cannot see them. Both are `Record`s of a union: adding a flow or an OTP
 * channel stops compiling here until its key exists.
 */
const FLOWS: Record<BotFlow, true> = {
  login: true,
  register: true,
  forgot: true,
  accounts: true,
  accountAdd: true,
};
const CHANNELS: Record<OtpChannelName, true> = { sms: true, telegram: true, bale: true };

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
  const used = keysUsedInCode();

  it('finds the keys at all (guards the scan itself)', () => {
    expect(used.length).toBeGreaterThan(50);
  });

  it.each(used)('%s is a real key', (key) => {
    expect(Object.keys(fallback)).toContain(key);
    expect(Object.keys(fa)).toContain(key);
    expect(Object.keys(en)).toContain(key);
  });

  it.each(Object.keys(FLOWS))('progress line exists for the %s flow', (flow) => {
    // `progressOf` returns nothing for a flow with no steps (`accounts` is one
    // screen), so that flow needs no key and must not be asked for one.
    const steps = stepsOf({ flow: flow as BotFlow, step: '', data: {} });
    if (steps.length === 0) return;
    expect(Object.keys(fallback)).toContain(`bot.progress.${flow}`);
    expect(Object.keys(fa)).toContain(`bot.progress.${flow}`);
  });

  it.each(Object.keys(CHANNELS))('%s has a channel name and a summary line', (channel) => {
    for (const key of [`bot.channel.${channel}`, `bot.field.channel.${channel}`]) {
      expect(Object.keys(fallback)).toContain(key);
      expect(Object.keys(fa)).toContain(key);
    }
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
