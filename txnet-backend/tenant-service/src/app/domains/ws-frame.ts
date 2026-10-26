import { createHash } from 'node:crypto';

/**
 * The few bytes of RFC 6455 the domain check's WebSocket line needs (NIN-1-e2):
 * a handshake and one short unmasked text frame from the server. No library:
 * the probe sends one message and closes, and nothing here carries user data.
 */

/** The RFC's fixed GUID, appended to the client's key before hashing (section 1.3). */
const HANDSHAKE_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** A text frame with the FIN bit, as the first byte of a frame. */
const FIN_TEXT = 0x81;

/** The largest payload a one-byte length holds (lengths 126 and 127 announce wider ones). */
const SHORT_PAYLOAD_MAX = 125;

/** A close frame with no status: the probe is done. */
export const CLOSE_FRAME = Buffer.from([0x88, 0x00]);

/** `Sec-WebSocket-Accept` for a client's `Sec-WebSocket-Key`. */
export function acceptOf(key: string): string {
  return createHash('sha1').update(key + HANDSHAKE_GUID).digest('base64');
}

/** One unmasked text frame, server to client; the probe's message is a short nonce. */
export function textFrame(text: string): Buffer {
  const payload = Buffer.from(text, 'utf8');
  if (payload.length > SHORT_PAYLOAD_MAX) throw new Error(`probe frame of ${payload.length} bytes; at most ${SHORT_PAYLOAD_MAX}`);
  return Buffer.concat([Buffer.from([FIN_TEXT, payload.length]), payload]);
}

/** The first frame's text, when `buf` holds a whole short text frame from a server; else null. */
export function readTextFrame(buf: Buffer): string | null {
  if (buf.length < 2 || buf[0] !== FIN_TEXT || buf[1] > SHORT_PAYLOAD_MAX) return null;
  const end = 2 + buf[1];
  return buf.length >= end ? buf.subarray(2, end).toString('utf8') : null;
}
