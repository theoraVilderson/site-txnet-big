import { RequestHeaders } from '../http/headers';
import { inMessageScope } from './message-scope';
import { currentRequestId } from './request-scope';

/**
 * H13 across the queue (OPS-1-z): a consumer handles a message with the
 * request id the message carries in scope, so its log lines and the calls it
 * makes join the request that caused it.
 */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function seenBy(message: { properties: { headers?: Record<string, unknown> } } | null) {
  let seen: string | undefined;
  const consume = inMessageScope(async () => {
    seen = currentRequestId();
  });
  return consume(message).then(() => seen);
}

describe('inMessageScope', () => {
  it('runs the handler with the message\'s x-request-id in scope', async () => {
    expect(await seenBy({ properties: { headers: { [RequestHeaders.requestId]: 'trace-0001' } } })).toBe('trace-0001');
  });

  it('gives a message with no id, or an unusable one, an id of its own', async () => {
    expect(await seenBy({ properties: {} })).toMatch(UUID_V4);
    expect(await seenBy({ properties: { headers: { [RequestHeaders.requestId]: 'bad id' } } })).toMatch(UUID_V4);
    expect(await seenBy({ properties: { headers: { [RequestHeaders.requestId]: 42 } } })).toMatch(UUID_V4);
  });

  it('passes a cancelled consumer\'s null through to the handler', async () => {
    let got: unknown = 'unset';
    await inMessageScope(async (message: null) => {
      got = message;
    })(null);
    expect(got).toBeNull();
  });
});
