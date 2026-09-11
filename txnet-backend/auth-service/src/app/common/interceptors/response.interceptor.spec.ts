import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { dirname, join } from 'path';
import { of } from 'rxjs';
import { ResponseInterceptor } from './response.interceptor';

/**
 * The response-message contract.
 *
 * Every `ok()` / `err()` in this service answers with an i18n **key**, and
 * `ResponseInterceptor` is the only thing that turns it into a sentence. When
 * it looked the key up in a namespace no locale file defines, the `|| msgKey`
 * fallback did what a fallback does — it kept working, and shipped
 * `register.duplicateUser` to the user's screen. Nothing was red.
 *
 * So this spec asserts the two things that failure needed: the namespace the
 * interceptor reads, and that every key the code returns actually exists in
 * both languages. A new `err('some.new.key')` with no translation is now a
 * failing test rather than a raw key on someone's screen.
 *
 * The bot's copy is held the same way — `bot-copy.spec.ts`, same reasoning.
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
const SRC = join(ROOT, 'txnet-backend', 'auth-service', 'src');

function flatten(obj: Record<string, unknown>, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v && typeof v === 'object') Object.assign(out, flatten(v as Record<string, unknown>, `${prefix}${k}.`));
    else out[`${prefix}${k}`] = String(v);
  }
  return out;
}

function errorsFile(lang: string): Record<string, string> {
  const path = join(ROOT, 'locales', 'backend', 'langs', lang, 'errors.json');
  return flatten(JSON.parse(readFileSync(path, 'utf-8')));
}

/**
 * Every key this service can put in front of a user, plus the two defaults
 * `ok()` / `err()` fall back to when a call site names none.
 *
 * A returned envelope is only half of them. The other half is *thrown*: a
 * `BadRequestException('otp.smsNotConfigured')`, an `i18nKey` on an exception
 * body, and — the ones a form shows under its own inputs — the zod messages
 * that `ZodValidationPipe` copies into `fieldErrors[].i18nKey`. Both halves
 * land in the same `errors` namespace and both are translated by the same
 * `|| key` fallback, so a missing sentence in either is the same raw dotted
 * key on the same screen.
 */
const KEY = "'([a-zA-Z][a-zA-Z0-9]*(?:\\.[a-zA-Z0-9_]+){0,5})'";
const EMITTERS = [
  // throw new BadRequestException('key') and its siblings
  `new (?:BadRequest|Unauthorized|Forbidden|NotFound|Conflict|TooManyRequests|ServiceUnavailable|InternalServerError)Exception\\(\\s*${KEY}`,
  // an explicit key on an exception body, or on an error class
  `i18nKey[:=]\\s*${KEY}`,
  // zod messages — these become fieldErrors[].i18nKey
  `\\.(?:min|max|regex|length|email|nonempty)\\([^)]*?,\\s*${KEY}\\s*\\)`,
  `\\bmessage:\\s*${KEY}`,
];

/**
 * The key argument of every `ok(...)` / `err(...)` in a file.
 *
 * Read by walking the call's parentheses rather than by one regex: the data
 * argument is routinely an object literal spread over a dozen lines, and a
 * pattern that stops at the first `(` or `;` silently skips those call sites.
 * `auth.refreshSuccess` was skipped that way, and shipped untranslated.
 */
function envelopeKeys(source: string): string[] {
  const out: string[] = [];
  const call = /\b(ok|err)\(/g;
  for (const m of source.matchAll(call)) {
    const start = (m.index ?? 0) + m[0].length;
    let depth = 1;
    let i = start;
    for (; i < source.length && depth > 0; i++) {
      const c = source[i];
      if (c === '(' || c === '{' || c === '[') depth++;
      else if (c === ')' || c === '}' || c === ']') depth--;
    }
    // The key is the call's last string literal argument: `err('k')`,
    // `ok(data, 'k')`, or `ok(data, cond ? 'a' : 'b')`.
    const args = source.slice(start, i - 1);
    const literals = [...args.matchAll(new RegExp(KEY, 'g'))].map((l) => l[1]);
    out.push(...literals);
  }
  return out;
}

function keysReturnedByCode(): string[] {
  const found = new Set<string>(['successful', 'failed']);
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith('.ts') && !name.endsWith('.spec.ts')) {
        const source = readFileSync(path, 'utf-8');
        const keys = [...envelopeKeys(source)];
        for (const pattern of EMITTERS) {
          for (const m of source.matchAll(new RegExp(pattern, 'g'))) keys.push(m[1]);
        }
        // A one-segment name is a local label, not a key in this namespace.
        for (const key of keys) if (key.includes('.')) found.add(key);
      }
    }
  };
  walk(SRC);
  return [...found].sort();
}

const fa = errorsFile('fa');
const en = errorsFile('en');

describe('the messages a response carries', () => {
  it('translates every key the code returns, in both languages', () => {
    const used = keysReturnedByCode();

    expect(used.filter((k) => !(k in fa))).toEqual([]);
    expect(used.filter((k) => !(k in en))).toEqual([]);
  });

  it('keeps fa and en on one key set', () => {
    expect(Object.keys(fa).sort()).toEqual(Object.keys(en).sort());
  });

  it('leaves no key without a sentence behind it', () => {
    expect(Object.entries(fa).filter(([, v]) => !v.trim())).toEqual([]);
    expect(Object.entries(en).filter(([, v]) => !v.trim())).toEqual([]);
  });
});

describe('ResponseInterceptor', () => {
  const context = (lang?: string) =>
    ({
      switchToHttp: () => ({ getRequest: () => ({ language: lang }) }),
    }) as never;

  function harness(catalog: Record<string, string> = {}) {
    const getKey = jest.fn((_lang: string, ns: string, key: string) =>
      ns === 'errors' ? catalog[key] : undefined,
    );
    const locale = { getKey, getDefaultLanguage: () => 'fa' };
    return { locale, interceptor: new ResponseInterceptor(locale as never) };
  }

  const run = (i: ResponseInterceptor, data: unknown, lang = 'fa') =>
    new Promise((resolve) =>
      i.intercept(context(lang), { handle: () => of(data) } as never).subscribe(resolve),
    );

  it('reads the shared `errors` namespace, not one of its own', async () => {
    const h = harness({ 'register.success': 'کد تایید برای شما ارسال شد' });

    const out = await run(h.interceptor, {
      ok: true,
      msg: 'register.success',
      data: null,
    });

    expect(h.locale.getKey).toHaveBeenCalledWith('fa', 'errors', 'register.success');
    expect(out).toMatchObject({ msg: 'کد تایید برای شما ارسال شد' });
  });

  it('leaves the key in place when the catalog has no sentence for it', async () => {
    const h = harness();

    const out = await run(h.interceptor, { ok: false, msg: 'never.translated', error: null });

    expect(out).toMatchObject({ msg: 'never.translated' });
  });

  it('wraps a bare payload and translates the default key', async () => {
    const h = harness({ successful: 'انجام شد' });

    expect(await run(h.interceptor, { id: 'u-1' })).toEqual({
      ok: true,
      msg: 'انجام شد',
      data: { id: 'u-1' },
    });
  });
});
