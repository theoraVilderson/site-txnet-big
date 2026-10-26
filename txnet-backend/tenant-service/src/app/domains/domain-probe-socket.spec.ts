import { answerUpgrade } from './domain-probe-socket';
import { acceptOf, CLOSE_FRAME, readTextFrame, textFrame } from './ws-frame';

/**
 * The WebSocket line's other end (NIN-1-e2): an upgrade to the probe path on a
 * host with a row is answered 101 with the nonce as its one message, so the
 * check knows the reseller's edge carried both the upgrade and a frame back.
 * Anything else is the neutral 404 every unknown host gets (F-1210).
 */
describe('the domain probe over a WebSocket', () => {
  const NONCE = 'abcdef0123456789';
  const KEY = 'dGhlIHNhbXBsZSBub25jZQ==';
  const PATH = '/api/public/tenant/domain-probe';
  const headers = { host: 'ali-vpn.ir', upgrade: 'websocket', connection: 'Upgrade', 'sec-websocket-key': KEY, 'sec-websocket-version': '13' };
  const known = async (host: string | undefined, nonce: string) => (host === 'ali-vpn.ir' ? { host, nonce } : null);

  it('computes the accept value RFC 6455 gives for its sample key', () => {
    expect(acceptOf(KEY)).toBe('s3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
  });

  it('frames a short text message the client reads back, and waits for a whole one', () => {
    const frame = textFrame(NONCE);
    expect(readTextFrame(frame)).toBe(NONCE);
    expect(readTextFrame(frame.subarray(0, 5))).toBeNull();
    expect(readTextFrame(Buffer.concat([frame, CLOSE_FRAME]))).toBe(NONCE);
  });

  it('answers 101 with the accept value, then the nonce, then a close', async () => {
    const out = await answerUpgrade(`${PATH}?n=${NONCE}`, headers, PATH, known);
    const text = out.toString('latin1');
    expect(text.startsWith('HTTP/1.1 101 Switching Protocols\r\n')).toBe(true);
    expect(text).toContain(`Sec-WebSocket-Accept: ${acceptOf(KEY)}\r\n`);
    const body = out.subarray(out.indexOf('\r\n\r\n') + 4);
    expect(readTextFrame(body)).toBe(NONCE);
    expect(body.subarray(body.length - 2)).toEqual(CLOSE_FRAME);
  });

  it('is the neutral 404 for an unknown host, another path, a bad nonce or no key', async () => {
    const refusals = [
      answerUpgrade(`${PATH}?n=${NONCE}`, { ...headers, host: 'stranger.example' }, PATH, known),
      answerUpgrade(`/api/realtime?n=${NONCE}`, headers, PATH, known),
      answerUpgrade(`${PATH}?n=<script>`, headers, PATH, known),
      answerUpgrade(`${PATH}?n=${NONCE}`, { ...headers, 'sec-websocket-key': undefined }, PATH, known),
    ];
    for (const out of await Promise.all(refusals)) expect(out.toString('latin1')).toMatch(/^HTTP\/1\.1 404 Not Found\r\n/);
  });
});
