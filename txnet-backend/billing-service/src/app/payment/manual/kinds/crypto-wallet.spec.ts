/**
 * The `crypto_wallet` kind (F-803-b): a wallet the seller enters — asset,
 * network, address, memo, decimals — and the proof a payer sends. Nothing is
 * preset (D-60 part 3): the network is the seller's words, shown verbatim.
 */
import { manualMethod, parseDestination, parseProof, publicDestination } from '../manual-methods';

const WALLET = manualMethod('crypto_wallet');
const TRON_ADDRESS = 'TQ5NqEdFHaRZXTDxWHxQFuZ3DtGVu8yXhR';
const TX_HASH = `0x${'ab12'.repeat(16)}`;

const destination = (fields: Record<string, unknown>) => {
  if (!WALLET) throw new Error('crypto_wallet is not registered');
  return parseDestination(WALLET, fields);
};
const usdt = { asset: 'usdt', network: ' Tron (TRC20) ', address: TRON_ADDRESS, decimals: 6 };

describe('a wallet destination', () => {
  it('is registered under its kind', () => {
    expect(WALLET?.kind).toBe('crypto_wallet');
  });

  it('upper-cases the asset and keeps the seller\'s network words', () => {
    expect(destination(usdt)).toEqual({ ok: true, fields: { asset: 'USDT', network: 'Tron (TRC20)', address: TRON_ADDRESS, decimals: 6 } });
  });

  it('takes an optional memo, and decimals as a number or a digit string within 0..18', () => {
    expect(destination({ ...usdt, memo: '104233', decimals: '8' })).toMatchObject({ ok: true, fields: { memo: '104233', decimals: 8 } });
    expect(destination({ ...usdt, decimals: 19 })).toEqual({ ok: false, refusals: [{ field: 'decimals', reason: 'invalid' }] });
    expect(destination({ ...usdt, decimals: 2.5 })).toEqual({ ok: false, refusals: [{ field: 'decimals', reason: 'invalid' }] });
  });

  it('refuses an asset outside ^[A-Z0-9]{2,10}$ and an address with spaces', () => {
    expect(destination({ ...usdt, asset: 'U$' })).toEqual({ ok: false, refusals: [{ field: 'asset', reason: 'invalid' }] });
    expect(destination({ ...usdt, address: 'TQ5N qEdF HaRZ XTDx' })).toEqual({ ok: false, refusals: [{ field: 'address', reason: 'invalid' }] });
  });

  it('requires asset, network, address and decimals', () => {
    expect(destination({})).toEqual({
      ok: false,
      refusals: ['asset', 'network', 'address', 'decimals'].map((field) => ({ field, reason: 'missing' })),
    });
  });

  it('charges the asset at its own decimals, with a unique step four places above the smallest unit', () => {
    const parsed = destination(usdt);
    const btc = destination({ ...usdt, asset: 'BTC', decimals: 2 });
    if (!WALLET || !parsed.ok || !btc.ok) throw new Error('expected a wallet');
    expect([WALLET.chargeCurrency(parsed.fields), WALLET.chargeDecimals(parsed.fields), WALLET.uniqueStep(parsed.fields)]).toEqual(['USDT', 6, BigInt(100)]);
    expect(WALLET.uniqueStep(btc.fields)).toBe(BigInt(1));
  });

  it('keeps a reference once per network, whatever case the seller typed, and has no watcher yet', () => {
    const parsed = destination(usdt);
    if (!WALLET || !parsed.ok) throw new Error('expected a wallet');
    expect([WALLET.refNetwork(parsed.fields), WALLET.watcherFor(parsed.fields), WALLET.refProofField]).toEqual(['TRON (TRC20)', null, 'txHash']);
    expect(publicDestination(WALLET, parsed.fields)).toEqual(parsed.fields);
  });
});

describe('a wallet payment\'s proof', () => {
  const proof = (input: unknown, required: readonly string[]) => {
    if (!WALLET) throw new Error('crypto_wallet is not registered');
    return parseProof(WALLET, input, required);
  };

  it('holds a transaction hash', () => {
    expect(proof({ txHash: ` ${TX_HASH} ` }, ['txHash'])).toEqual({ ok: true, fields: { txHash: TX_HASH } });
  });

  it('refuses a hash too short to be one, and a card\'s tracking code', () => {
    expect(proof({ txHash: 'abc', trackingCode: '123456' }, ['txHash'])).toEqual({
      ok: false,
      refusals: [{ field: 'txHash', reason: 'invalid' }, { field: 'trackingCode', reason: 'unknown_field' }],
    });
  });
});
