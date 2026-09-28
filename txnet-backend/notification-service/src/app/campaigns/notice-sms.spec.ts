/**
 * A notice's SMS (F-601-t, ADR-0097 part 2): the line the recipient's tenant
 * sends on, through the campaigns' own `SmsLineResolver`.
 *
 * What would break silently here, and nowhere else:
 *  - **the platform's line is the platform owner's alone** (D-41): a
 *    reseller's user is told on that reseller's own line, or not by SMS at
 *    all — never on the platform's number, at the platform's cost;
 *  - **no line is an answer, not a failure**: the worker must not retry a
 *    notice forever because a reseller never set a line up;
 *  - **a line that cannot send is owed**: a vault outage or a line down
 *    throws, so the worker's event stays owed, while a number the gateway
 *    refuses is final.
 */
import { ServiceUnavailableException } from '@nestjs/common';

import { NoticeSmsService } from './notice-sms';
import { SmsLineResolver, type SmsLine, type SmsLineSource, type SmsSend } from './sms-line';

const OWNER = '11111111-1111-4111-8111-111111111111';
const RESELLER = '22222222-2222-4222-8222-222222222222';
const BARE = '33333333-3333-4333-8333-333333333333';
const USER = '44444444-4444-4444-8444-444444444444';

const line = (answer: SmsSend = { status: 'sent' }) => ({ send: vi.fn(async () => answer) }) satisfies SmsLine;

function build({
  platform = line() as SmsLine | null,
  own = new Map<string, SmsLine | null>(),
  owner = OWNER as string | null,
} = {}) {
  const lines = { resolverFor: vi.fn(async () => new SmsLineResolver(platform, own)) };
  const db = { tenant: { findFirst: vi.fn(async () => (owner ? { id: owner } : null)) } };
  return { service: new NoticeSmsService(lines as unknown as SmsLineSource, db as never), lines };
}

const to = (tenantId: string) => ({ tenantId, userId: USER, to: '09120000000', text: 'Your service stopped.' });

describe('NoticeSmsService — which line a notice goes out on', () => {
  it('the platform owner’s user is told on the platform’s line', async () => {
    const platform = line();
    const { service, lines } = build({ platform });

    await expect(service.send(to(OWNER))).resolves.toEqual({ sent: true });
    expect(platform.send).toHaveBeenCalledWith('09120000000', 'Your service stopped.');
    expect(lines.resolverFor).toHaveBeenCalledWith(OWNER, []);
  });

  it('a reseller’s user is told on that reseller’s own line, never the platform’s', async () => {
    const platform = line();
    const own = line();
    const { service, lines } = build({ platform, own: new Map([[RESELLER, own]]) });

    await expect(service.send(to(RESELLER))).resolves.toEqual({ sent: true });
    expect(own.send).toHaveBeenCalledTimes(1);
    expect(platform.send).not.toHaveBeenCalled();
    expect(lines.resolverFor).toHaveBeenCalledWith(null, [RESELLER]);
  });

  it('a reseller with no line of its own sends none, and that is an answer', async () => {
    const platform = line();
    const { service } = build({ platform });

    await expect(service.send(to(BARE))).resolves.toEqual({ sent: false, reason: 'no_line' });
    expect(platform.send).not.toHaveBeenCalled();
  });

  it('a number the gateway refuses is final', async () => {
    const { service } = build({ platform: line({ status: 'refused', description: 'InvalidReceiverNumber' }) });
    await expect(service.send(to(OWNER))).resolves.toEqual({ sent: false, reason: 'refused' });
  });

  it('a line that could not be opened, or cannot send, stays owed', async () => {
    await expect(build({ platform: null }).service.send(to(OWNER))).rejects.toBeInstanceOf(ServiceUnavailableException);
    const down = build({ platform: line({ status: 'line_down', description: 'NoCredit' }) });
    await expect(down.service.send(to(OWNER))).rejects.toBeInstanceOf(ServiceUnavailableException);
    const retry = build({ platform: line({ status: 'retry', description: 'transport' }) });
    await expect(retry.service.send(to(OWNER))).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
