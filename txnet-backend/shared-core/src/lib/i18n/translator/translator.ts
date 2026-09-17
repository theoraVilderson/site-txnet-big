/**
 * Machine translation as a port (ADR-0050 decision 1, F-1533-a).
 *
 * The engine only drafts text a human then publishes, so a failure costs a
 * draft and nothing else: every method answers `null` / `[]` and never throws.
 * A catalog write that asked for drafts is saved whether the engine is up,
 * slow, missing a language pair, or not deployed at all.
 *
 * Drivers: a local LLM over the OpenAI chat API (Ollama) and LibreTranslate,
 * chained by {@link FallbackTranslator}.
 *
 * No language list lives here (§1.1): which pairs exist is the engine's answer
 * from `languages()`, and which languages exist is locale-service's.
 */
export interface TranslatorLanguage {
  code: string;
  /** Languages this one can be translated into. */
  targets: string[];
}

/**
 * What the text is, for an engine that is told (the LLM): a catalog item's name
 * or description (the default), or a message an admin sends users (F-035-h).
 */
export type TranslationKind = 'catalog' | 'message';

export interface Translator {
  /** The translation, the text itself when `from === to`, or `null`. */
  translate(text: string, from: string, to: string, kind?: TranslationKind): Promise<string | null>;
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

const LLM_TIMEOUT_MS = 60_000;

/** CJK scripts: a small model that loses the thread tends to answer in them. */
const CJK = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/;
const CJK_LANGS = new Set(['zh', 'ja', 'ko']);
const base = (code: string) => code.toLowerCase().split(/[-_]/)[0];

/** `fa` → `Persian`: a model follows a language's name far better than its code. */
function languageName(code: string): string {
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) ?? code;
  } catch {
    return code;
  }
}

export interface OpenAiCompatibleOptions {
  /** Up to and including `/v1`, e.g. `http://ollama:11434/v1` — a model on this deployment. */
  baseUrl: string;
  /** e.g. `qwen2.5:3b` — must already be pulled into the engine. */
  model: string;
  apiKey?: string;
  /** Per request. Drafting never holds a write (it runs after it), so a CPU model gets a minute. */
  timeoutMs?: number;
  fetch?: typeof fetch;
}

/**
 * A local LLM behind the OpenAI chat API — Ollama, llama.cpp's server or vLLM
 * (ADR-0050 amendment 3). Free, offline once the model is pulled, and far
 * better than Argos on short store names, because it is told what the text is.
 * Its answer is still only a draft a human publishes.
 */
export class OpenAiCompatibleTranslator implements Translator {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;

  constructor(private readonly options: OpenAiCompatibleOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? LLM_TIMEOUT_MS;
    this.fetchFn = options.fetch ?? fetch;
  }

  async translate(text: string, from: string, to: string, kind: TranslationKind = 'catalog'): Promise<string | null> {
    if (!text.trim()) return null;
    if (from === to) return text;
    const what =
      kind === 'message'
        ? `You translate messages that an online store selling VPN and internet services sends to its customers. Keep the tone, line breaks, emoji and links. `
        : `You translate the names and descriptions of products and categories in an online store that sells VPN and internet services. `;
    const system =
      what +
      `Translate the user's message from ${languageName(from)} to ${languageName(to)}. ` +
      `Keep brand names, numbers, units (GB, Mbps, days) and Latin product codes unchanged. ` +
      `Reply with the translation only: no quotes, no explanation, no notes.`;
    const body = {
      model: this.options.model,
      temperature: 0,
      stream: false,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: text },
      ],
    };
    const answer = await this.request(body);
    const content = (answer as { choices?: { message?: { content?: unknown } }[] } | null)?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') return null;
    const cleaned = clean(content, text.includes('\n'));
    if (!cleaned) return null;
    if (CJK.test(cleaned) && !CJK.test(text) && !CJK_LANGS.has(base(from)) && !CJK_LANGS.has(base(to))) return null;
    return cleaned;
  }

  /** A model has no fixed pair list; which languages exist is locale-service's answer. */
  async languages(): Promise<TranslatorLanguage[]> {
    return [];
  }

  private async request(body: unknown): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchFn(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {}) },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}

const QUOTES: [string, string][] = [
  ['"', '"'],
  ["'", "'"],
  ['«', '»'],
  ['“', '”'],
  ['`', '`'],
];

/** The translation alone: no label, no wrapping quotes, and for a one-line source no trailing note. */
function clean(content: string, multiline: boolean): string {
  let out = content.trim();
  if (!multiline) out = out.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  out = out.replace(/^(translation|translated text)\s*:\s*/i, '').trim();
  for (const [open, close] of QUOTES) {
    if (out.length > 1 && out.startsWith(open) && out.endsWith(close)) out = out.slice(open.length, -close.length).trim();
  }
  return out;
}

/** Engines in order: the first draft wins, so a stopped LLM falls back to LibreTranslate. */
export class FallbackTranslator implements Translator {
  constructor(readonly engines: readonly Translator[]) {}

  async translate(text: string, from: string, to: string, kind?: TranslationKind): Promise<string | null> {
    for (const engine of this.engines) {
      const draft = await engine.translate(text, from, to, kind);
      if (draft) return draft;
    }
    return null;
  }

  async languages(): Promise<TranslatorLanguage[]> {
    for (const engine of this.engines) {
      const list = await engine.languages();
      if (list.length) return list;
    }
    return [];
  }
}

const positive = (v: string | undefined) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : undefined;
};

/**
 * `TRANSLATOR_LLM_URL` + `TRANSLATOR_LLM_MODEL` → a local LLM
 * (`TRANSLATOR_LLM_API_KEY`, `TRANSLATOR_LLM_TIMEOUT_MS` optional);
 * `TRANSLATOR_URL` → LibreTranslate (`TRANSLATOR_API_KEY`,
 * `TRANSLATOR_TIMEOUT_MS`). Both → the LLM first, LibreTranslate behind it.
 * Neither → {@link NullTranslator}.
 */
export function translatorFromEnv(env: Record<string, string | undefined> = process.env): Translator {
  const engines: Translator[] = [];
  const llmUrl = env['TRANSLATOR_LLM_URL']?.trim();
  const model = env['TRANSLATOR_LLM_MODEL']?.trim();
  if (llmUrl && model) {
    engines.push(
      new OpenAiCompatibleTranslator({
        baseUrl: llmUrl,
        model,
        apiKey: env['TRANSLATOR_LLM_API_KEY']?.trim() || undefined,
        timeoutMs: positive(env['TRANSLATOR_LLM_TIMEOUT_MS']),
      }),
    );
  }
  const baseUrl = env['TRANSLATOR_URL']?.trim();
  if (baseUrl) {
    engines.push(
      new LibreTranslateTranslator({
        baseUrl,
        apiKey: env['TRANSLATOR_API_KEY']?.trim() || undefined,
        timeoutMs: positive(env['TRANSLATOR_TIMEOUT_MS']),
      }),
    );
  }
  if (engines.length === 0) return new NullTranslator();
  return engines.length === 1 ? engines[0] : new FallbackTranslator(engines);
}
