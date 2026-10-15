import { type DestinationFields, type FieldCheck, type ManualMethod, PAID_AT, RECEIPT_IMAGE, textCheck } from '../manual-method';

/**
 * A crypto wallet: the payer sends an asset to the seller's address on the
 * seller's network (F-803-b, contract.manual-transfer.md "Method kinds").
 * Nothing is preset (D-60 part 3): asset, network and decimals are the
 * seller's, and the network is shown in the seller's words.
 */

const MAX_DECIMALS = 18;
/** A unique amount's offset sits this many places above the asset's smallest unit (F-804): 0.0001 USDT. */
const UNIQUE_STEP_PLACES = 4;

const decimals: FieldCheck = (raw) => {
  const n = typeof raw === 'string' && /^\d{1,2}$/.test(raw) ? Number(raw) : raw;
  return typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= MAX_DECIMALS ? { value: n } : { refused: 'invalid' };
};

const decimalsOf = (fields: DestinationFields) => Number(fields['decimals']);

export const CRYPTO_WALLET: ManualMethod = {
  kind: 'crypto_wallet',
  destinationFields: [
    { id: 'asset', type: 'text', public: true, check: textCheck({ pattern: /^[A-Z0-9]{2,10}$/, max: 10, fold: (t) => t.toUpperCase() }) },
    { id: 'network', type: 'text', public: true, check: textCheck({ pattern: /^[\p{L}\p{N}][\p{L}\p{N} ()._-]*$/u, max: 40 }) },
    { id: 'address', type: 'text', public: true, check: textCheck({ pattern: /^[A-Za-z0-9:._-]{10,128}$/, max: 128 }) },
    { id: 'memo', type: 'text', public: true, optional: true, check: textCheck({ pattern: /^[A-Za-z0-9 _-]+$/, max: 100 }) },
    { id: 'decimals', type: 'integer', public: true, check: decimals },
  ],
  proofFields: [
    { id: 'txHash', type: 'text', check: textCheck({ pattern: /^(0x)?[A-Za-z0-9]{16,128}$/, max: 130 }) },
    RECEIPT_IMAGE,
    PAID_AT,
  ],
  refProofField: 'txHash',
  // One hash is one transfer on its chain; the seller's casing of the network must not split it.
  refNetwork: (fields) => String(fields['network']).toUpperCase(),
  chargeCurrency: (fields) => String(fields['asset']),
  chargeDecimals: decimalsOf,
  uniqueStep: (fields) => BigInt(10 ** Math.max(0, decimalsOf(fields) - UNIQUE_STEP_PLACES)),
  // A watcher per network arrives with F-803-f (`tron-usdt` first).
  watcherFor: () => null,
};
