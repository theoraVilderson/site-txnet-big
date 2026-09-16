/**
 * Machine translation as a port (ADR-0050 decision 1, F-1533-a).
 *
 * The engine only drafts text a human then publishes, so a failure costs a
 * draft and nothing else: every method answers `null` / `[]` and never throws.
 * A catalog write that asked for drafts is saved whether the engine is up,
 * slow, missing a language pair, or not deployed at all.
 *
 * No language list lives here (§1.1): which pairs exist is the engine's answer
 * from `languages()`, and which languages exist is locale-service's.
 */
export interface TranslatorLanguage {
  code: string;
  /** Languages this one can be translated into. */
  targets: string[];
}

export interface Translator {
  /** The translation, the text itself when `from === to`, or `null`. */
  translate(text: string, from: string, to: string): Promise<string | null>;
  languages(): Promise<TranslatorLanguage[]>;
}

/** Nest injection token for the configured {@link Translator}. */
export const TRANSLATOR = Symbol('TRANSLATOR');

/** No engine configured: every draft is skipped and readers get the fallback. */
export class NullTranslator implements Translator {
  async translate(): Promise<string | null> {
    return null;
  }

  async languages(): Promise<TranslatorLanguage[]> {
    return [];
  }
}

export interface LibreTranslateOptions {
  /** e.g. `http://translator:5000` — the self-hosted container, never a public instance. */
  baseUrl: string;
  apiKey?: string;
  /** Per request. A draft is not worth holding an admin's save for longer. */
  timeoutMs?: number;
  fetch?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/** LibreTranslate (Argos models), self-hosted: nothing leaves the deployment. */
export class LibreTranslateTranslator implements Translator {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;

  constructor(private readonly options: LibreTranslateOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchFn = options.fetch ?? fetch;
  }

  async translate(text: string, from: string, to: string): Promise<string | null> {
    if (!text.trim()) return null;
    if (from === to) return text;
    const body = { q: text, source: from, target: to, format: 'text', ...(this.options.apiKey ? { api_key: this.options.apiKey } : {}) };
    const answer = await this.request('/translate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const translated = (answer as { translatedText?: unknown } | null)?.translatedText;
    return typeof translated === 'string' && translated.trim() ? translated : null;
  }

  async languages(): Promise<TranslatorLanguage[]> {
    const answer = await this.request('/languages', { method: 'GET' });
    if (!Array.isArray(answer)) return [];
    return answer
      .filter((l): l is { code: string; targets?: unknown } => typeof l?.code === 'string')
      .map((l) => ({ code: l.code, targets: Array.isArray(l.targets) ? l.targets.filter((c): c is string => typeof c === 'string') : [] }));
  }

  /** The parsed JSON body of a 2xx answer, or `null` for anything else. */
  private async request(path: string, init: RequestInit): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchFn(`${this.baseUrl}${path}`, { ...init, signal: controller.signal });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * `TRANSLATOR_URL` set → the LibreTranslate driver (`TRANSLATOR_API_KEY`,
 * `TRANSLATOR_TIMEOUT_MS` optional); unset → {@link NullTranslator}.
 */
export function translatorFromEnv(env: Record<string, string | undefined> = process.env): Translator {
  const baseUrl = env['TRANSLATOR_URL']?.trim();
  if (!baseUrl) return new NullTranslator();
  const timeoutMs = Number(env['TRANSLATOR_TIMEOUT_MS']);
  return new LibreTranslateTranslator({
    baseUrl,
    apiKey: env['TRANSLATOR_API_KEY']?.trim() || undefined,
    timeoutMs: Number.isInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : undefined,
  });
}
