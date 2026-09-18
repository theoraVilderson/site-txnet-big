import { describe, expect, it } from 'vitest';
import { API_BASE, realtimeUrl } from './api-origin';

/**
 * F-066-u, ADR-0060: the panel talks to the services on the domain it was
 * loaded from. A reseller's customer on `ali.example.com` must reach the
 * backend *as* `ali.example.com` — that host is what resolves the tenant, and
 * it is the only host a first-party cookie can be stored for. One origin baked
 * in at build time made every panel talk as the platform's own host.
 */
describe('the API is same-origin', () => {
  it('is a path, never an origin — so it follows whatever domain served the page', () => {
    expect(API_BASE).toBe('/api');
    expect(API_BASE).not.toMatch(/^[a-z]+:/i);
  });
});

describe('realtimeUrl', () => {
  it('opens the socket on the page’s own host, over TLS when the page is', () => {
    expect(realtimeUrl({ protocol: 'https:', host: 'ali.example.com' }, '/realtime')).toBe(
      'wss://ali.example.com/realtime',
    );
  });

  it('keeps a plain page on a plain socket, port included', () => {
    expect(realtimeUrl({ protocol: 'http:', host: 'localhost:3000' }, '/realtime')).toBe(
      'ws://localhost:3000/realtime',
    );
  });

  it('adds the leading slash a configured path left out', () => {
    expect(realtimeUrl({ protocol: 'https:', host: 'panel.example.com' }, 'ws')).toBe(
      'wss://panel.example.com/ws',
    );
  });

  it('is empty where there is no page — no socket rather than one to a guessed host', () => {
    expect(realtimeUrl(null, '/realtime')).toBe('');
  });
});
