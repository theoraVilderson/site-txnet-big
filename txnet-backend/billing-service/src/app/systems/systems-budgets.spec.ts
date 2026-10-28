/**
 * The systems surface's two write budgets (LIVE-1-e).
 *
 * One budget of 30 per 15 minutes held every systems write, so setting up a
 * reseller with six panels — ~60 writes, most of them a group, a member or an
 * inbound list — waited on 429s and gave up once. A write that only changes
 * desired state in the database spends `SYSTEMS_ADMIN_SETTINGS`; one that
 * reaches a panel, the vault, or starts work over many configs keeps
 * `SYSTEMS_ADMIN_WRITE`. The way it goes wrong quietly is a heavy route moved
 * to the large budget, so both lists are named here.
 */
import { RATE_LIMIT_KEY, RateLimitOptions } from '@txnet-backend/shared-core';

import { GrantGroupMoveController } from './grant-group-move.controller';
import { InboundAudienceController } from './inbound-audience.controller';
import { PanelCostController } from './panel-cost.controller';
import { SystemsController } from './systems.controller';

vi.setConfig({ testTimeout: 30_000 });

const budgetOf = (controller: { prototype: object }, method: string) =>
  (Reflect.getMetadata(RATE_LIMIT_KEY, (controller.prototype as Record<string, object>)[method]) as RateLimitOptions<string>).configKey;

describe('the systems write budgets', () => {
  it('spends the settings budget on a write that only changes desired state', () => {
    for (const m of ['createGroup', 'updateGroup', 'removeGroup', 'addMember', 'updateMember', 'assignMemberInbounds', 'removeMember', 'updateInbounds', 'acknowledge']) {
      expect([m, budgetOf(SystemsController, m)]).toEqual([m, 'SYSTEMS_ADMIN_SETTINGS_RATE_LIMIT']);
    }
    for (const m of ['set', 'share']) expect([m, budgetOf(InboundAudienceController, m)]).toEqual([m, 'SYSTEMS_ADMIN_SETTINGS_RATE_LIMIT']);
    expect(budgetOf(PanelCostController, 'set')).toBe('SYSTEMS_ADMIN_SETTINGS_RATE_LIMIT');
  });

  it('keeps the write budget on a write that reaches a panel, the vault, money or many configs', () => {
    for (const m of ['register', 'resubmitCredentials', 'resubmitRadiusSecret', 'updatePanel', 'removePanel', 'restorePanel', 'refreshInbounds', 'drainMember', 'evictMember', 'release', 'writeOff']) {
      expect([m, budgetOf(SystemsController, m)]).toEqual([m, 'SYSTEMS_ADMIN_WRITE_RATE_LIMIT']);
    }
    for (const m of ['release', 'cancelRelease']) expect([m, budgetOf(InboundAudienceController, m)]).toEqual([m, 'SYSTEMS_ADMIN_WRITE_RATE_LIMIT']);
    for (const m of ['regroup', 'start', 'cancel']) expect([m, budgetOf(GrantGroupMoveController, m)]).toEqual([m, 'SYSTEMS_ADMIN_WRITE_RATE_LIMIT']);
  });
});
