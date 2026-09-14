import { envelopeData } from './internal-answer';

/**
 * Every internal route a job calls answers through shared-core's
 * `ResponseInterceptor`: `{ ok, msg, data }`. The three HTTP jobs read their
 * counts off the top level instead, so billing's real answer
 * `{"ok":true,"msg":"انجام شد","data":{"scanned":0,...}}` failed every
 * expiry run (2026-09-14). This is the one reader they share.
 */
describe('envelopeData', () => {
  it('returns the payload of a success envelope', () => {
    expect(envelopeData({ ok: true, msg: 'انجام شد', data: { scanned: 1 } })).toEqual({ scanned: 1 });
  });

  it.each([
    ['a bare body', { scanned: 1 }],
    ['a failure envelope', { ok: false, msg: 'failed', data: { scanned: 1 } }],
    ['an envelope with no object payload', { ok: true, msg: 'ok', data: 3 }],
    ['null', null],
    ['an array', [{ ok: true, data: {} }]],
  ])('returns null for %s', (_label, body) => {
    expect(envelopeData(body)).toBeNull();
  });
});
