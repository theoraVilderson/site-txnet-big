// @vitest-environment node
//
// The panel's brand is the domain's (F-066-v, ADR-0059): whoever is signed in —
// the reseller's customer or the reseller's owner, whose session is their own
// platform tenant — the page wears the brand of the host it was loaded on. So
// the read names the visitor's host and never a session, and what comes back is
// data this app checks again before a byte of it reaches a style or an <img>.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  brandStyle,
  clearBrandingCache,
  fetchBranding,
  parseBranding,
} from './branding';
import { visitorHost } from './visitor-host';

const VIEW = {
  brandName: 'Acme VPN',
  logoLightUrl: 'https://panel.acme.test/api/files/tenants/t1/branding/logo-light',
  logoDarkUrl: null,
  faviconUrl: 'https://panel.acme.test/api/files/tenants/t1/branding/favicon',
  ogImageUrl: null,
  primaryColorHex: '#123abc',
  secondaryColorHex: '#00ff00',
  supportEmail: 'help@acme.test',
  updatedAt: '2026-09-18T00:00:00.000Z',
};

describe('parseBranding', () => {
  it('keeps the fields the panel renders from an ok envelope', () => {
    expect(parseBranding({ ok: true, data: VIEW })).toEqual({
      brandName: 'Acme VPN',
      logoLightUrl: VIEW.logoLightUrl,
      logoDarkUrl: null,
      faviconUrl: VIEW.faviconUrl,
      ogImageUrl: null,
      primaryColorHex: '#123abc',
      secondaryColorHex: '#00ff00',
    });
  });

  it('drops a colour that is not #rrggbb and a URL that is not https', () => {
    const b = parseBranding({
      ok: true,
      data: {
        ...VIEW,
        primaryColorHex: 'red;}body{display:none',
        logoLightUrl: 'javascript:alert(1)',
        faviconUrl: 'http://panel.acme.test/f',
      },
    });
    expect(b?.primaryColorHex).toBeNull();
    expect(b?.logoLightUrl).toBeNull();
    expect(b?.faviconUrl).toBeNull();
  });

  it('is null for a refusal, a missing name or a body that is not an envelope', () => {
    expect(parseBranding({ ok: false, msg: 'not found' })).toBeNull();
    expect(parseBranding({ ok: true, data: { ...VIEW, brandName: '' } })).toBeNull();
    expect(parseBranding('<html>')).toBeNull();
    expect(parseBranding(null)).toBeNull();
  });

  // Rule 1 (panel-web contract.branding.md): a name past 64 is not this tenant's
  // checked brand, so the whole brand is dropped, never shown cut; a colour is
  // `#rrggbb` as tenant-service's CHECK keeps it, never a shorthand.
  it('drops the whole brand for a name past 64, and a colour that is not #rrggbb', () => {
    expect(parseBranding({ ok: true, data: { ...VIEW, brandName: 'x'.repeat(65) } })).toBeNull();
    expect(parseBranding({ ok: true, data: { ...VIEW, primaryColorHex: '#abc' } })?.primaryColorHex).toBeNull();
  });
});

describe('brandStyle', () => {
  it('sets the accent tokens from the brand colours, nothing without them', () => {
    const b = parseBranding({ ok: true, data: VIEW })!;
    expect(brandStyle(b)).toMatchObject({
      '--accent-primary': '#123abc',
      '--card-gradient': 'linear-gradient(135deg, #123abc 0%, #00ff00 100%)',
    });
    expect(brandStyle({ ...b, primaryColorHex: null, secondaryColorHex: null })).toEqual({});
    expect(brandStyle(null)).toEqual({});
  });
});

describe('visitorHost', () => {
  it('prefers the host Traefik forwarded, then Host', () => {
    expect(visitorHost(new Headers({ 'x-forwarded-host': 'panel.acme.test, x', host: 'site-pwa:3000' }))).toBe('panel.acme.test');
    expect(visitorHost(new Headers({ host: 'panel.acme.test' }))).toBe('panel.acme.test');
    expect(visitorHost(new Headers(), 'fallback.test')).toBe('fallback.test');
    expect(visitorHost(new Headers())).toBeNull();
  });
});

describe('fetchBranding — the host names the brand, never the session', () => {
  let server: http.Server;
  let origin: string;
  const seen: { host?: string; path?: string; cookie?: string }[] = [];
  let reply: (res: http.ServerResponse) => void;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      seen.push({ host: req.headers.host, path: req.url, cookie: req.headers.cookie });
      reply(res);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));
  beforeEach(() => {
    seen.length = 0;
    clearBrandingCache();
    reply = (res) => res.end(JSON.stringify({ ok: true, data: VIEW }));
  });

  it('asks /api/public/tenant/branding on the internal origin with the visitor host as Host, and no cookie', async () => {
    const b = await fetchBranding('panel.acme.test', origin);
    expect(b?.brandName).toBe('Acme VPN');
    expect(seen).toEqual([{ host: 'panel.acme.test', path: '/api/public/tenant/branding', cookie: undefined }]);
  });

  it('answers a second render for the same host from its cache, another host fresh', async () => {
    await fetchBranding('panel.acme.test', origin);
    await fetchBranding('panel.acme.test', origin);
    await fetchBranding('panel.other.test', origin);
    expect(seen.map((s) => s.host)).toEqual(['panel.acme.test', 'panel.other.test']);
  });

  // Every host reaches this app, so a scan of made-up hosts must not become one
  // upstream call per page: a host that is no tenant's is remembered too, but
  // briefly (10s, not 60s), so a tenant-service blip clears on its own.
  it('remembers a host that has no brand, but only for a short while', async () => {
    const realNow = Date.now;
    let now = realNow();
    Date.now = () => now;
    try {
      reply = (res) => { res.statusCode = 404; res.end(JSON.stringify({ ok: false, msg: 'x' })); };
      await fetchBranding('scan-1.test', origin);
      await fetchBranding('scan-1.test', origin);
      expect(seen).toHaveLength(1);
      now += 10_001;
      reply = (res) => res.end(JSON.stringify({ ok: true, data: VIEW }));
      expect((await fetchBranding('scan-1.test', origin))?.brandName).toBe('Acme VPN');
      expect(seen).toHaveLength(2);
    } finally {
      Date.now = realNow;
    }
  });

  it('is null — the neutral look — on a 404, a bad body or no service', async () => {
    reply = (res) => { res.statusCode = 404; res.end(JSON.stringify({ ok: false, msg: 'x' })); };
    expect(await fetchBranding('unknown.test', origin)).toBeNull();
    clearBrandingCache();
    reply = (res) => res.end('not json');
    expect(await fetchBranding('unknown.test', origin)).toBeNull();
    clearBrandingCache();
    expect(await fetchBranding('panel.acme.test', 'http://127.0.0.1:1')).toBeNull();
  });
});
