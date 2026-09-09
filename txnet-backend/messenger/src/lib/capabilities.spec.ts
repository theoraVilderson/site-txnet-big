import { BOT_PLATFORMS, BotPlatform } from './bot-platform';
import { capabilitiesOf, MessengerCapabilities } from './capabilities';

/**
 * The axes this spec makes claims about, stated once per platform.
 *
 * A `Record<BotPlatform, …>` and not a pair of hand-written `expect`s: a third
 * messenger added to `BotPlatform` fails to typecheck here until someone says
 * what it does. `it.each(BOT_PLATFORMS)` alone would have looped over it
 * silently and passed.
 */
const EXPECTED: Record<
  BotPlatform,
  Pick<
    MessengerCapabilities,
    | 'payment'
    | 'webAppGlobal'
    | 'deleteIncomingMessage'
    | 'deleteWindowSeconds'
  >
> = {
  telegram: {
    payment: 'provider-tokens',
    webAppGlobal: 'Telegram.WebApp',
    deleteIncomingMessage: true,
    deleteWindowSeconds: 48 * 3600,
  },
  bale: {
    payment: 'wallet',
    webAppGlobal: 'Bale.WebApp',
    deleteIncomingMessage: true,
    deleteWindowSeconds: 48 * 3600,
  },
};

describe('capabilities', () => {
  // The contract's one hard rule: "a flag with no date is not a flag."
  it.each(BOT_PLATFORMS)('%s carries a verification date and its source', (p) => {
    const caps = capabilitiesOf(p);
    expect(caps.verifiedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(caps.source).toMatch(/^https:\/\//);
  });

  it.each(BOT_PLATFORMS)('%s matches its stated capabilities', (p) => {
    expect(capabilitiesOf(p)).toMatchObject(EXPECTED[p]);
  });

  // ADR-0009's amendment: presence is near-identical, payments is not. Stated
  // about the two platforms the ADR actually compared — a third messenger is
  // free to share either rail, and would say so in the table above.
  it('keeps the one axis where telegram and bale genuinely diverge', () => {
    expect(capabilitiesOf('telegram').payment).not.toBe(
      capabilitiesOf('bale').payment,
    );
    expect(capabilitiesOf('telegram').webAppGlobal).not.toBe(
      capabilitiesOf('bale').webAppGlobal,
    );
  });

  it('records that every platform lets a bot delete the user password message', () => {
    for (const p of BOT_PLATFORMS) {
      expect(capabilitiesOf(p).deleteIncomingMessage).toBe(true);
      expect(capabilitiesOf(p).deleteWindowSeconds).toBe(48 * 3600);
    }
  });
});
