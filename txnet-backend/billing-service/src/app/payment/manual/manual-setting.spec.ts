/**
 * A manual gateway's admin rules (F-803-c, contract.manual-transfer.md
 * "Gateway admin"): provider `manual_transfer`, category `manual` and the
 * `manual` body go together; the body names a registered kind, proof fields
 * that kind declares and a window of 10..1440 minutes; nothing is confirmed
 * or priced automatically without something to do it (no watcher, no fee
 * quote); a destination's fields are its kind's, every refused one named.
 */
import { GatewayAdminRefused } from '../gateway-admin/gateway-admin.refusal';
import type { DestinationFields } from './manual-method';
import { manualMethod } from './manual-methods';
import { checkedDestination, checkManualShape, settleManualSetting } from './manual-setting';

const CARD = { cardNumber: '6037991234567893', holderName: 'Sara Ahmadi' };
const MANUAL = { providerName: 'manual_transfer', gatewayCategory: 'manual', feeCalculationMode: 'manual' };
const ZARINPAL = { providerName: 'zarinpal', gatewayCategory: 'domestic_rial', feeCalculationMode: 'manual' };

/** The refusal `run` threw, as `{reason, detail}`; fails when it threw nothing. */
function refusal(run: () => unknown): { reason: string; message: string; refusals?: unknown } {
  try {
    run();
  } catch (e) {
    if (e instanceof GatewayAdminRefused) return { reason: e.reason, message: e.message, refusals: e.refusals };
    throw e;
  }
  throw new Error('nothing was refused');
}

describe('which gateway carries a manual body', () => {
  it('is a manual_transfer gateway of category manual, and only that', () => {
    expect(() => checkManualShape(MANUAL, { kind: 'card_to_card' })).not.toThrow();
    expect(refusal(() => checkManualShape({ ...MANUAL, gatewayCategory: 'domestic_rial' }, { kind: 'card_to_card' })).reason).toBe('manual_setting_mismatch');
    expect(refusal(() => checkManualShape({ ...ZARINPAL, gatewayCategory: 'manual' }, undefined)).reason).toBe('manual_setting_mismatch');
    expect(refusal(() => checkManualShape(ZARINPAL, { kind: 'card_to_card' })).reason).toBe('manual_setting_mismatch');
    expect(() => checkManualShape(ZARINPAL, undefined)).not.toThrow();
  });

  it('never changes provider to or from manual_transfer: the setting and destinations would be orphaned or missing', () => {
    expect(refusal(() => checkManualShape(MANUAL, { kind: 'card_to_card' }, 'zarinpal')).reason).toBe('manual_setting_mismatch');
    expect(refusal(() => checkManualShape(ZARINPAL, undefined, 'manual_transfer')).reason).toBe('manual_setting_mismatch');
  });

  it('refuses an automatic fee: there is no provider to quote one', () => {
    const r = refusal(() => checkManualShape({ ...MANUAL, feeCalculationMode: 'automatic' }, { kind: 'card_to_card' }));
    expect(r.reason).toBe('automatic_unavailable');
    expect(r.message).toContain('feeCalculationMode');
  });
});

describe('the manual setting', () => {
  it('takes the column defaults on create, given a kind', () => {
    expect(settleManualSetting(null, { kind: 'card_to_card' }, [])).toEqual({
      kind: 'card_to_card',
      confirmationMode: 'manual_admin_required',
      requiredProof: [],
      windowMinutes: 30,
    });
  });

  it('needs a registered kind', () => {
    expect(refusal(() => settleManualSetting(null, {}, [])).message).toContain('kind');
    expect(refusal(() => settleManualSetting(null, { kind: 'paypal_manual' }, [])).reason).toBe('invalid_manual_setting');
  });

  it("requires proof only from the kind's own fields, each once", () => {
    expect(settleManualSetting(null, { kind: 'card_to_card', requiredProof: ['trackingCode', 'receiptImage', 'trackingCode'] }, []).requiredProof).toEqual([
      'trackingCode',
      'receiptImage',
    ]);
    const r = refusal(() => settleManualSetting(null, { kind: 'card_to_card', requiredProof: ['txHash'] }, []));
    expect(r.reason).toBe('invalid_manual_setting');
    expect(r.message).toContain('txHash');
  });

  it('keeps the window to 10..1440 minutes', () => {
    expect(refusal(() => settleManualSetting(null, { kind: 'card_to_card', windowMinutes: 5 }, [])).reason).toBe('invalid_manual_setting');
    expect(refusal(() => settleManualSetting(null, { kind: 'card_to_card', windowMinutes: 1441 }, [])).reason).toBe('invalid_manual_setting');
    expect(settleManualSetting(null, { kind: 'card_to_card', windowMinutes: 1440 }, []).windowMinutes).toBe(1440);
  });

  it('patches only what it names', () => {
    const before = { kind: 'crypto_wallet', confirmationMode: 'manual_admin_required', requiredProof: ['txHash'], windowMinutes: 60 };
    expect(settleManualSetting(before, { windowMinutes: 90 }, [])).toEqual({ ...before, windowMinutes: 90 });
  });

  it('refuses automatic confirmation while a destination has no watcher — none has one yet (principle 7)', () => {
    const active: DestinationFields[] = [{ asset: 'USDT', network: 'TRC20', address: 'TQ5NqEdFHaRZXTDxWHxQFuZ3DtGVu8yXhR', decimals: 6 }];
    expect(refusal(() => settleManualSetting(null, { kind: 'crypto_wallet', confirmationMode: 'automatic' }, active)).reason).toBe('automatic_unavailable');
    // No active destination is not a pass: nothing would be watched either.
    expect(refusal(() => settleManualSetting(null, { kind: 'crypto_wallet', confirmationMode: 'automatic' }, [])).reason).toBe('automatic_unavailable');
  });
});

describe('a destination', () => {
  const card = manualMethod('card_to_card');
  if (!card) throw new Error('card_to_card is not registered');

  it("is stored as its kind's checked fields, the bank derived from the BIN", () => {
    expect(checkedDestination(card, CARD)).toMatchObject({ cardNumber: '6037991234567893', holderName: 'Sara Ahmadi', bankId: expect.any(String) });
  });

  it('names every refused field at once', () => {
    const r = refusal(() => checkedDestination(card, { cardNumber: '6037991234567890', colour: 'red' }));
    expect(r.reason).toBe('invalid_destination');
    expect(r.refusals).toEqual([
      { field: 'cardNumber', reason: 'checksum' },
      { field: 'holderName', reason: 'missing' },
      { field: 'colour', reason: 'unknown_field' },
    ]);
  });
});
