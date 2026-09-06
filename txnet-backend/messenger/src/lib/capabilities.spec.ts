import { BOT_PLATFORMS } from './bot-platform';
import { capabilitiesOf } from './capabilities';

describe('capabilities', () => {
  // The contract's one hard rule: "a flag with no date is not a flag."
  it.each(BOT_PLATFORMS)('%s carries a verification date and its source', (p) => {
    const caps = capabilitiesOf(p);
    expect(caps.verifiedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(caps.source).toMatch(/^https:\/\//);
  });

  it('keeps the one axis where the platforms genuinely diverge', () => {
    // ADR-0009's amendment: presence is near-identical, payments is not.
    expect(capabilitiesOf('telegram').payment).toBe('provider-tokens');
    expect(capabilitiesOf('bale').payment).toBe('wallet');
    expect(capabilitiesOf('telegram').webAppGlobal).not.toBe(
      capabilitiesOf('bale').webAppGlobal,
    );
  });

  it('records that both platforms let a bot delete the user password message', () => {
    for (const p of BOT_PLATFORMS) {
      expect(capabilitiesOf(p).deleteIncomingMessage).toBe(true);
      expect(capabilitiesOf(p).deleteWindowSeconds).toBe(48 * 3600);
    }
  });
});
