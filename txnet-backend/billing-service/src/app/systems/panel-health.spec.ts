/**
 * Whether a panel's stored health is current, on hold because the outage is
 * ours, or not being checked (F-027-em, ADR-0122). What breaks silently:
 *  - a `healthy` written three days ago by a collector that has since died,
 *    shown as healthy (the dev incident of 2026-10-06);
 *  - our egress cut shown as every reseller's panel down — or, the other way,
 *    a panel that kept answering through it shown as on hold;
 *  - a panel nothing is judging (the vault will not open it) shown as fine.
 */
import { judgePanelHealth, type CollectorBeat } from './panel-health';

const now = new Date('2026-10-06T07:00:00Z');
const ago = (s: number) => new Date(now.getTime() - s * 1000);
const accepted = { reviewState: 'accepted', panelState: 'healthy', panelCheckedAt: ago(30) } as const;
const running: CollectorBeat = { passAt: ago(20), egress: 'ok', egressSince: ago(86_400) };

describe('judgePanelHealth', () => {
  it('a panel judged recently by a running collector is current', () => {
    expect(judgePanelHealth(accepted, running, now)).toEqual({ view: 'current', heldBy: null });
  });

  it('every accepted panel is on hold while the collector is stopped, whatever it stores', () => {
    const stopped: CollectorBeat = { ...running, passAt: ago(3 * 86_400) };
    expect(judgePanelHealth(accepted, stopped, now)).toEqual({
      view: 'on_hold',
      heldBy: { reason: 'collector_stopped', since: stopped.passAt },
    });
  });

  it('on hold when no collector ever ran', () => {
    expect(judgePanelHealth(accepted, null, now)).toEqual({ view: 'on_hold', heldBy: { reason: 'collector_never_ran', since: null } });
  });

  it('on hold under our egress outage, unless the panel was judged since it began', () => {
    const cut: CollectorBeat = { passAt: ago(20), egress: 'down', egressSince: ago(600) };
    expect(judgePanelHealth({ ...accepted, panelCheckedAt: ago(900) }, cut, now)).toEqual({
      view: 'on_hold',
      heldBy: { reason: 'egress_down', since: cut.egressSince },
    });
    // It answered after our outage began: the panel spoke, so what it stores is current.
    expect(judgePanelHealth({ ...accepted, panelCheckedAt: ago(30) }, cut, now)).toEqual({ view: 'current', heldBy: null });
  });

  it('names a mass failure and a dead resolver as ours too', () => {
    const stale = { ...accepted, panelCheckedAt: ago(900) };
    expect(judgePanelHealth(stale, { ...running, egress: 'suspect', egressSince: ago(600) }, now).heldBy?.reason).toBe('egress_suspect');
    expect(judgePanelHealth(stale, { ...running, egress: 'dns_down', egressSince: ago(600) }, now).heldBy?.reason).toBe('dns_down');
  });

  it('a running collector that has not judged a panel for five passes is not checking it', () => {
    expect(judgePanelHealth({ ...accepted, panelCheckedAt: ago(301) }, running, now)).toEqual({ view: 'not_checked', heldBy: null });
    expect(judgePanelHealth({ ...accepted, panelCheckedAt: null }, running, now)).toEqual({ view: 'not_checked', heldBy: null });
  });

  it('a panel refusing us is not asked during its cool-off, which is not "not checked"', () => {
    expect(judgePanelHealth({ ...accepted, panelState: 'throttled_or_blocked', panelCheckedAt: ago(600) }, running, now).view).toBe('current');
  });

  it('a panel the collector does not read (pending, refused) is never held', () => {
    for (const reviewState of ['pending', 'refused'] as const) {
      expect(judgePanelHealth({ ...accepted, reviewState, panelCheckedAt: null }, null, now)).toEqual({ view: 'current', heldBy: null });
    }
  });
});
