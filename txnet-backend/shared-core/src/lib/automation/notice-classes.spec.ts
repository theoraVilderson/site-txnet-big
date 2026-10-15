/**
 * A notice's class decides its channels (F-601-s, ADR-0097 part 2).
 *
 * What would break silently here, and nowhere else:
 *  - **a missing notice is critical**: a new type is never quietly dropped
 *    from the bot, the same way a missing kind is `cutoff`;
 *  - **every retention kind has its class**: `cutoff` critical, `ending`,
 *    `connect` and `usage` important, except 50 % which is info;
 *  - **"active again" follows its alarm**: critical, while its mute switch
 *    stays the `reactivated` kind (F-601-m);
 *  - **a combined notice takes the stronger class**: 50 % carrying "3 days
 *    left" still reaches the bot.
 */
import { OutboxEventType } from './routing-keys';
import { NOTICE_CLASS_OF, noticeClassOf } from './notice-classes';
import { RETENTION_KIND_OF } from './retention-kinds';

describe('notice classes (F-601-s)', () => {
  it('tells a notice missing from the table as critical', () => {
    expect(noticeClassOf('entitlement.grant.something_new')).toBe('critical');
    expect(noticeClassOf('someNewTemplate')).toBe('critical');
  });

  it('classes every retention kind as ADR-0097 says', () => {
    const expected = { cutoff: 'critical', ending: 'important', connect: 'important', usage: 'important', reactivated: 'critical', suggestion: 'suggestion', lottery: 'important' };
    for (const [type, kind] of Object.entries(RETENTION_KIND_OF)) {
      const want = type === OutboxEventType.GRANT_USAGE_50 ? 'info' : expected[kind!];
      expect([type, noticeClassOf(type)]).toEqual([type, want]);
    }
  });

  it('has a row for every retention type', () => {
    expect(Object.keys(RETENTION_KIND_OF).filter((type) => !(type in NOTICE_CLASS_OF))).toEqual([]);
  });

  it('classes the purchase, payment and panel notices (user 2026-09-28)', () => {
    const by = (c: string) => Object.entries(NOTICE_CLASS_OF).filter(([k, v]) => v === c && !k.includes('.')).map(([k]) => k).sort();
    expect(by('critical')).toEqual([
      'paymentReversed',
      'purchaseRefunded',
      'purchaseStuckPanelUnavailable',
      'purchaseStuckStrategyNotBuilt',
      'purchaseStuckWriteUnconfirmed',
      'resellerDomainDropped',
      'resellerDomainFailed',
      'resellerEmergencyEntry',
      'resellerQuotaCapReached',
      'resellerQuotaStopped',
      'resellerQuotaUnpaid',
      'resellerWholesaleUnfunded',
      'subscriptionSuspended',
    ]);
    expect(by('important')).toEqual([
      // AC-1-s: the person's own access moved.
      'accessKeyWindow',
      'accessKeysChanged',
      'accessMembershipEnded',
      'accessRoleSet',
      'accessSeatRemoved',
      'accessSeatRestored',
      // F-707-q: an opt-in lottery opened — join before it closes.
      'lotteryOpened',
      // F-707-m: a lottery prize given.
      'lotteryWon',
      // F-027-el (ADR-0122): a panel went down, told by what the owner has to fix.
      'panelDownDns',
      'panelDownPath',
      'panelDownPort',
      'panelDownServer',
      'panelDownTls',
      'panelDownUnreachable',
      // F-027-fg (ADR-0130): a panel paused by a drift event, waiting for its owner.
      'panelHaltedAddress',
      'panelHaltedDrift',
      'panelHaltedForeign',
      'panelHaltedIdentity',
      'panelHaltedRestore',
      'panelLoginRefused',
      'panelRefused',
      'panelRefusingUs',
      'paymentCredited',
      'purchaseDelayed',
      'purchaseDelivered',
      // RT-1-e2: a reseller's custom domain went live.
      'resellerDomainLive',
      // F-019-v8: a reseller's quota at 80%, its overage started, and its daily digest.
      'resellerQuotaDigest',
      'resellerQuotaNearing',
      'resellerQuotaOverageStarted',
      // F-027-eo: a panel-side edit replaced a buyer's lines.
      'serviceLinesChanged',
      'subscriptionPaymentDue',
      // F-805-b: a transfer's receipt waits on a person who may confirm it.
      'transferProofSent',
      // F-707-e: the wheel's day at 80% of its cap.
      'wheelCapNearing',
    ]);
    // F-707-q: an automatic lottery asks nothing — the inbox's alone.
    expect(by('info')).toEqual(['lotteryOpenedAutomatic', 'panelAccepted', 'panelRecovered']);
  });

  it('gives a combined notice the stronger class', () => {
    expect(noticeClassOf(OutboxEventType.GRANT_USAGE_50, OutboxEventType.GRANT_ENDS_IN_3D)).toBe('important');
    expect(noticeClassOf(OutboxEventType.GRANT_USAGE_50)).toBe('info');
    expect(noticeClassOf(OutboxEventType.GRANT_ENDS_IN_1D, OutboxEventType.GRANT_ENDED)).toBe('critical');
  });
});
