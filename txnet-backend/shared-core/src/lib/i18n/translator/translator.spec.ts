import {
  FallbackTranslator,
  LibreTranslateTranslator,
  NullTranslator,
  OpenAiCompatibleTranslator,
  translatorFromEnv,
} from './translator';

/**
 * The machine translator only ever produces a *draft* (ADR-0050): a human
 * publishes it, and until then a reader sees the en → fa fallback. So the one
 * thing this port must never do is fail the catalog write that asked for a
 * draft. Every way the engine can let us down — down, slow, an unsupported
 * pair, a garbage answer — is `null`, and the admin's product is still saved.
 */
type Call = { url: string; init?: RequestInit };

function fakeFetch(respond: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn = (async (url: string, init?: RequestInit) => {
    const call = { url: String(url), init };
    calls.push(call);
    return respond(call);
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('LibreTranslateTranslator', () => {
  it('posts plain text to /translate and returns the translation', async () => {
    const f = fakeFetch(() => json({ translatedText: 'VPN Premium' }));
    const t = new LibreTranslateTranslator({ baseUrl: 'http://translator:5000/', apiKey: 'k', fetch: f.fn });

    await expect(t.translate('وی‌پی‌ان ویژه', 'fa', 'en')).resolves.toBe('VPN Premium');

    expect(f.calls[0].url).toBe('http://translator:5000/translate');
    expect(JSON.parse(String(f.calls[0].init?.body))).toEqual({
      q: 'وی‌پی‌ان ویژه',
      source: 'fa',
      target: 'en',
      format: 'text',
      api_key: 'k',
    });
  });

  it('never calls the engine for the same language or empty text', async () => {
    const f = fakeFetch(() => json({ translatedText: 'x' }));
    const t = new LibreTranslateTranslator({ baseUrl: 'http://translator:5000', fetch: f.fn });

    await expect(t.translate('Premium', 'en', 'en')).resolves.toBe('Premium');
    await expect(t.translate('   ', 'en', 'de')).resolves.toBeNull();
    expect(f.calls).toHaveLength(0);
  });

  it('answers null, never throws, whenever the engine lets us down', async () => {
    const cases: Array<() => Response | Promise<Response>> = [
      () => json({ error: 'fa is not supported' }, 400), // unsupported pair
      () => json({ error: 'boom' }, 500),
      () => json({ nothing: true }), // an answer without the field
      () => json({ translatedText: '  ' }), // an empty draft is no draft
      () => new Response('<html>proxy error</html>', { status: 200 }),
      () => Promise.reject(new TypeError('fetch failed')), // container down
    ];
    for (const respond of cases) {
      const t = new LibreTranslateTranslator({ baseUrl: 'http://translator:5000', fetch: fakeFetch(respond).fn });
      await expect(t.translate('Premium', 'en', 'de')).resolves.toBeNull();
    }
  });

  it('gives up after its timeout instead of holding the catalog write', async () => {
    const hang = ((_url: string, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      })) as unknown as typeof fetch;
    const t = new LibreTranslateTranslator({ baseUrl: 'http://translator:5000', timeoutMs: 20, fetch: hang });

    await expect(t.translate('Premium', 'en', 'de')).resolves.toBeNull();
  });

  it('reads the pairs the engine supports, and an empty list when it cannot', async () => {
    const ok = fakeFetch(() =>
      json([
        { code: 'en', name: 'English', targets: ['de', 'fa'] },
        { code: 'fa', name: 'Persian', targets: ['en'] },
      ]),
    );
    const t = new LibreTranslateTranslator({ baseUrl: 'http://translator:5000', fetch: ok.fn });
    await expect(t.languages()).resolves.toEqual([
      { code: 'en', targets: ['de', 'fa'] },
      { code: 'fa', targets: ['en'] },
    ]);
    expect(ok.calls[0].url).toBe('http://translator:5000/languages');

    const down = new LibreTranslateTranslator({
      baseUrl: 'http://translator:5000',
      fetch: fakeFetch(() => Promise.reject(new TypeError('fetch failed'))).fn,
    });
    await expect(down.languages()).resolves.toEqual([]);
  });
});

describe('OpenAiCompatibleTranslator (a local LLM: Ollama, llama.cpp, vLLM)', () => {
  const reply = (content: string) => json({ choices: [{ message: { role: 'assistant', content } }] });
  const llm = (respond: (call: Call) => Response | Promise<Response>) => {
    const f = fakeFetch(respond);
    return { f, t: new OpenAiCompatibleTranslator({ baseUrl: 'http://ollama:11434/v1/', model: 'qwen2.5:3b', fetch: f.fn }) };
  };

  it('asks the model for a store-name translation between named languages, deterministically', async () => {
    const { f, t } = llm(() => reply('Premium VPN'));

    await expect(t.translate('وی‌پی‌ان ویژه', 'fa', 'en')).resolves.toBe('Premium VPN');

    expect(f.calls[0].url).toBe('http://ollama:11434/v1/chat/completions');
    const body = JSON.parse(String(f.calls[0].init?.body));
    expect(body).toMatchObject({ model: 'qwen2.5:3b', temperature: 0, stream: false });
    const system = body.messages[0];
    expect(system.role).toBe('system');
    expect(system.content).toContain('Persian');
    expect(system.content).toContain('English');
    expect(body.messages.at(-1)).toEqual({ role: 'user', content: 'وی‌پی‌ان ویژه' });
  });

  it('keeps only the translation when a small model wraps it in quotes or adds a note', async () => {
    for (const content of ['"Premium VPN"', '«Premium VPN»', 'Premium VPN\n\nNote: kept the brand.', '  Translation: Premium VPN ']) {
      await expect(llm(() => reply(content)).t.translate('وی‌پی‌ان ویژه', 'fa', 'en')).resolves.toBe('Premium VPN');
    }
  });

  it('keeps every line of a multi-line description', async () => {
    const { t } = llm(() => reply('Fast.\nUnlimited.'));
    await expect(t.translate('سریع.\nنامحدود.', 'fa', 'en')).resolves.toBe('Fast.\nUnlimited.');
  });

  it('refuses an answer in a script neither language uses — a small model drifting into Chinese is no draft', async () => {
    await expect(llm(() => reply('高级 VPN')).t.translate('وی‌پی‌ان ویژه', 'fa', 'en')).resolves.toBeNull();
  });

  it('answers null, never throws, whenever the model lets us down', async () => {
    const cases: Array<() => Response | Promise<Response>> = [
      () => json({ error: 'model not found' }, 404),
      () => json({ choices: [] }),
      () => reply('   '),
      () => Promise.reject(new TypeError('fetch failed')),
    ];
    for (const respond of cases) await expect(llm(respond).t.translate('Premium', 'en', 'fa')).resolves.toBeNull();
  });

  it('never calls the model for the same language or empty text', async () => {
    const { f, t } = llm(() => reply('x'));
    await expect(t.translate('Premium', 'en', 'en')).resolves.toBe('Premium');
    await expect(t.translate(' ', 'en', 'fa')).resolves.toBeNull();
    expect(f.calls).toHaveLength(0);
  });
});

describe('FallbackTranslator', () => {
  const fixed = (answer: string | null, languages: { code: string; targets: string[] }[] = []) => ({
    translate: vi.fn(async () => answer),
    languages: vi.fn(async () => languages),
  });

  it('takes the first engine that drafts, and asks the next only when one does not', async () => {
    const first = fixed(null);
    const second = fixed('VPN');
    const third = fixed('never');
    await expect(new FallbackTranslator([first, second, third]).translate('وی‌پی‌ان', 'fa', 'en')).resolves.toBe('VPN');
    expect(third.translate).not.toHaveBeenCalled();
    await expect(new FallbackTranslator([fixed(null), fixed(null)]).translate('a', 'en', 'fa')).resolves.toBeNull();
  });

  it('reports the first non-empty language list', async () => {
    const pairs = [{ code: 'en', targets: ['fa'] }];
    await expect(new FallbackTranslator([fixed(null), fixed(null, pairs)]).languages()).resolves.toEqual(pairs);
  });
});

describe('translatorFromEnv', () => {
  it('is the null translator when no engine is configured — a deployment without one still runs', async () => {
    const t = translatorFromEnv({});
    expect(t).toBeInstanceOf(NullTranslator);
    await expect(t.translate('Premium', 'en', 'de')).resolves.toBeNull();
    await expect(t.languages()).resolves.toEqual([]);
  });

  it('builds the LibreTranslate driver from TRANSLATOR_URL', () => {
    expect(translatorFromEnv({ TRANSLATOR_URL: 'http://translator:5000' })).toBeInstanceOf(LibreTranslateTranslator);
  });

  it('puts the local LLM first and LibreTranslate behind it when both are configured', () => {
    const t = translatorFromEnv({ TRANSLATOR_LLM_URL: 'http://ollama:11434/v1', TRANSLATOR_LLM_MODEL: 'qwen2.5:3b', TRANSLATOR_URL: 'http://translator:5000' });
    expect(t).toBeInstanceOf(FallbackTranslator);
    expect((t as FallbackTranslator).engines.map((e) => e.constructor)).toEqual([OpenAiCompatibleTranslator, LibreTranslateTranslator]);
  });

  it('uses the LLM alone without TRANSLATOR_URL, and never an LLM URL with no model', () => {
    expect(translatorFromEnv({ TRANSLATOR_LLM_URL: 'http://ollama:11434/v1', TRANSLATOR_LLM_MODEL: 'qwen2.5:3b' })).toBeInstanceOf(OpenAiCompatibleTranslator);
    expect(translatorFromEnv({ TRANSLATOR_LLM_URL: 'http://ollama:11434/v1' })).toBeInstanceOf(NullTranslator);
  });
});
