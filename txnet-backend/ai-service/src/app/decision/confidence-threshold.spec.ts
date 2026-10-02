import { AI_SETTING_DEFAULTS } from '../policy/ai-defaults';
import { thresholdVerdict } from './confidence-threshold';

/**
 * F-1503 / ADR-0109 point 8: a candidate whose confidence is below the
 * tenant's threshold is dropped — the engine stays silent rather than send
 * an irrelevant suggestion.
 *
 * The failures worth a spec: the boundary read the wrong way (a candidate at
 * exactly the threshold dropped), a float artefact deciding it (0.6 computed
 * as 0.59999…), a confidence that is not a number sent anyway, and a drop
 * that does not say which step stopped it (`action.suppressedBy`, CHECKed).
 */
describe('the confidence threshold (F-1503)', () => {
  it('defaults to 0.6 for a tenant that set nothing', () => {
    expect(AI_SETTING_DEFAULTS.confidenceThreshold).toBe(0.6);
  });

  it('drops a candidate below the threshold and names the step', () => {
    expect(thresholdVerdict(0.59, 0.6)).toEqual({ pass: false, suppressedBy: 'confidence_threshold' });
  });

  it('keeps a candidate exactly at the threshold — only below is dropped', () => {
    expect(thresholdVerdict(0.6, 0.6)).toEqual({ pass: true });
  });

  it('compares at the stored precision, so a float artefact does not decide it', () => {
    // 0.7 - 0.1 is 0.59999999999999998 in a double; stored as Decimal(5,4) it is 0.6000.
    expect(thresholdVerdict(0.7 - 0.1, 0.6)).toEqual({ pass: true });
  });

  it("follows the tenant's own threshold", () => {
    expect(thresholdVerdict(0.75, 0.8)).toMatchObject({ pass: false });
    expect(thresholdVerdict(0.35, 0.3)).toEqual({ pass: true });
  });

  it('drops a confidence that is not a number', () => {
    expect(thresholdVerdict(Number.NaN, 0)).toMatchObject({ pass: false });
  });
});
