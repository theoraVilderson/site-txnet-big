import { LibreTranslateTranslator, NullTranslator, translatorFromEnv } from './translator';

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
});
