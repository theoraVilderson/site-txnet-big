/**
 * Three-layer selling settings (F-027-cg, ADR-0090 decision 2): a selling
 * setting resolves group membership -> panel -> platform default. What would
 * break silently:
 *
 *  - **a setting nobody answers.** Every layer below the member may be unset,
 *    and the platform default still answers — never `undefined`, never a
 *    placement that reads a missing value as "no cap";
 *  - **the wrong layer winning.** A member's own value beats its panel's, the
 *    panel's beats the platform's, and an unset (null) layer is passed over —
 *    including `maxClients`, whose platform default is itself null (no cap);
 *  - **a read that hides where a value came from.** Each effective value names
 *    its layer, so the systems page can say "inherited" instead of guessing;
 *  - **a group overriding a server fact.** Addresses, credentials,
 *    `maxRequestsPerMinute`, `maxLineRateBps` are the panel's alone: a member
 *    body naming one is refused, not dropped.
 */
import { InboundPlacement } from '@prisma/client';

import { addPanelGroupMemberSchema, updatePanelGroupMemberSchema, updatePanelInboundsSchema } from '../systems/panel-registration.schema';
import { effectiveSellingSettings, PLATFORM_SELLING_DEFAULTS, sellingValues } from './selling-settings';

const UNSET = { inboundPlacement: null, maxClients: null, priority: null, weight: null };

describe('effectiveSellingSettings — member -> panel -> platform', () => {
  it('answers every setting from the platform when neither the member nor the panel sets one', () => {
    const effective = effectiveSellingSettings(UNSET, UNSET);
    expect(effective).toEqual({
      inboundPlacement: { value: InboundPlacement.all, layer: 'platform' },
      maxClients: { value: null, layer: 'platform' },
      priority: { value: 0, layer: 'platform' },
      weight: { value: 1, layer: 'platform' },
    });
    expect(sellingValues(effective)).toEqual(PLATFORM_SELLING_DEFAULTS);
  });

  it('takes the panel over the platform, and the member over both, setting by setting', () => {
    const panel = { inboundPlacement: InboundPlacement.spread, maxClients: 200, priority: null, weight: 5 };
    const member = { inboundPlacement: null, maxClients: 50, priority: 3, weight: null };
    expect(effectiveSellingSettings(member, panel)).toEqual({
      inboundPlacement: { value: InboundPlacement.spread, layer: 'panel' },
      maxClients: { value: 50, layer: 'member' },
      priority: { value: 3, layer: 'member' },
      weight: { value: 5, layer: 'panel' },
    });
  });

  it('reads a panel with no member (the panel\'s own view) as panel -> platform', () => {
    expect(effectiveSellingSettings(null, { ...UNSET, maxClients: 10 })).toMatchObject({
      maxClients: { value: 10, layer: 'panel' },
      inboundPlacement: { value: InboundPlacement.all, layer: 'platform' },
    });
  });

  it('passes over an absent key as over a null one: a row read before the column existed still resolves', () => {
    expect(effectiveSellingSettings({}, {})).toEqual(effectiveSellingSettings(UNSET, UNSET));
  });
});

describe('what a member may override', () => {
  it('sets or clears each selling setting; null hands it back to the panel', () => {
    expect(updatePanelGroupMemberSchema.safeParse({ maxClients: 20, inboundPlacement: 'spread', priority: 2, weight: 3 }).success).toBe(true);
    expect(updatePanelGroupMemberSchema.parse({ maxClients: null, inboundPlacement: null, priority: null, weight: null })).toEqual(UNSET);
    expect(addPanelGroupMemberSchema.safeParse({ panelId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', maxClients: 5, inboundPlacement: 'all' }).success).toBe(true);
  });

  it('refuses a server fact, an empty edit, and a value outside the table\'s CHECKs', () => {
    for (const body of [{ maxRequestsPerMinute: 10 }, { maxLineRateBps: 1 }, { apiBaseUrl: 'https://x' }, { credentials: 'x' }, { role: 'drain' }]) {
      expect(updatePanelGroupMemberSchema.safeParse(body).success).toBe(false);
    }
    expect(updatePanelGroupMemberSchema.safeParse({}).success).toBe(false);
    expect(updatePanelGroupMemberSchema.safeParse({ maxClients: 0 }).success).toBe(false);
    expect(updatePanelGroupMemberSchema.safeParse({ weight: 0 }).success).toBe(false);
    expect(updatePanelGroupMemberSchema.safeParse({ priority: -1 }).success).toBe(false);
  });

  it('lets the panel layer set priority and weight, and hand any setting back to the platform', () => {
    expect(updatePanelInboundsSchema.safeParse({ priority: 4, weight: 2 }).success).toBe(true);
    expect(updatePanelInboundsSchema.safeParse({ inboundPlacement: null, priority: null, weight: null }).success).toBe(true);
    expect(updatePanelInboundsSchema.safeParse({ weight: 0 }).success).toBe(false);
  });
});
