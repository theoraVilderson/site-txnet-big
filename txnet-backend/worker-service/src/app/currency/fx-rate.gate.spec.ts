import { Prisma } from '@prisma/client';
import { accepted, gateFxDeviation } from './fx-rate.gate';

/**
 * F-0605 — step 3 of the FX loop: **a move beyond `maxDeviationPercent` is
 * rejected.**
 *
 * F-0604's band is absolute and answers "can this be a price at all". This gate
 * is relative and answers a different question — "can the price have *moved*
 * this far since the last one we accepted" — and it is the only step that can
 * catch the failure F-0604's own contract says its band deliberately does not:
 * a toman book read as rial, which is in-band, agreed on by a median, and ten
 * times wrong.
 *
 * The tests below are written around the three things that make it either
 * work or quietly not:
 *
 * 1. **Cold start accepts.** There is no previous rate to move away from on the
 *    first poll after a boot, and a gate that refused would mean the loop could
 *    never publish anything at all.
 * 2. **The comparison is against the last *accepted* rate.** A rejected reading
 *    must not become the baseline — otherwise two polls of a broken source walk
 *    the gate to the wrong rate in 5% steps, which is precisely the attack the
 *    row exists to stop. That rule lives in the job, but it is only safe
 *    because this function never mutates anything and takes `previous` as an
 *    argument.
 * 3. **"Beyond" is strict, and symmetric.** Exactly 5% is not beyond 5%, and a
 *    crash is as suspicious as a spike — the tenfold unit error shows up as a
 *    fall, not a rise.
 */
describe('gateFxDeviation', () => {
  const D = (v: string) => new Prisma.Decimal(v);
  const max = D('5');

  it('accepts on a cold start, because there is nothing to compare against', () => {
    const gated = gateFxDeviation(D('600000'), null, max);

    expect(accepted(gated)).toBe(true);
    if (!accepted(gated)) return;
    expect(gated.rialPerUsdt.toString()).toBe('600000');
    expect(gated.deviationPercent).toBeNull();
  });

  it('accepts an ordinary move and reports how far it went', () => {
    const gated = gateFxDeviation(D('612000'), D('600000'), max);

    expect(accepted(gated)).toBe(true);
    if (!accepted(gated)) return;
    expect(gated.deviationPercent.toString()).toBe('2');
  });

  it('rejects a move beyond the band and says by how much', () => {
    const gated = gateFxDeviation(D('660000'), D('600000'), max);

    expect(accepted(gated)).toBe(false);
    if (accepted(gated)) return;
    expect(gated.deviationPercent.toString()).toBe('10');
    expect(gated.previous.toString()).toBe('600000');
    expect(gated.rialPerUsdt.toString()).toBe('660000');
    expect(gated.reason).toContain('10');
    expect(gated.reason).toContain('5');
  });

  it('rejects a fall as readily as a rise — a unit error reads as a crash', () => {
    // A toman book parsed as rial: exactly the tenfold error F-0604's band is
    // documented as unable to catch, arriving in-band and agreed on.
    const gated = gateFxDeviation(D('60000'), D('600000'), max);

    expect(accepted(gated)).toBe(false);
    if (accepted(gated)) return;
    expect(gated.deviationPercent.toString()).toBe('90');
  });

  it('treats exactly maxDeviationPercent as a move, not as beyond one', () => {
    const gated = gateFxDeviation(D('630000'), D('600000'), max);

    expect(accepted(gated)).toBe(true);
    if (!accepted(gated)) return;
    expect(gated.deviationPercent.toString()).toBe('5');
  });

  it('accepts an unchanged rate at a zero band', () => {
    // maxDeviationPercent of 0 is a legal, if unwise, configuration: it pins
    // the rate to whatever was accepted first. It must not be a special case.
    expect(accepted(gateFxDeviation(D('600000'), D('600000'), D('0')))).toBe(
      true,
    );
    expect(accepted(gateFxDeviation(D('600001'), D('600000'), D('0')))).toBe(
      false,
    );
  });

  it('is total: a non-positive previous rate is no baseline, not a division', () => {
    // Nothing should ever hand this a zero — F-0604's band floor is 100000 —
    // but a gate that throws is a gate that takes the loop down with it, and
    // the answer to "how far from zero" has no useful value.
    const gated = gateFxDeviation(D('600000'), D('0'), max);

    expect(accepted(gated)).toBe(true);
    if (!accepted(gated)) return;
    expect(gated.deviationPercent).toBeNull();
  });

  it('does not let a rounding tail turn a 5% move into a rejection', () => {
    // 5% of 617283 is not an integer. The deviation is computed as a Decimal
    // ratio rather than in fixed places, so the boundary is the boundary.
    const previous = D('617283');
    const exactly5 = previous.mul(D('1.05'));

    expect(accepted(gateFxDeviation(exactly5, previous, max))).toBe(true);
  });
});
