/**
 * A wallet address as its payer reads it (F-803-j, contract.manual-transfer.md
 * "Wallet"): the ends a person compares with their own wallet's screen, and
 * the middle in short groups so the eye does not lose its place.
 */

/** The characters at each end a payer compares — what clipboard-swapping malware has to forge. */
export const ADDRESS_ENDS = 6;
/** The middle's group length: short enough to read aloud, as a card's 4-4-4-4. */
const GROUP = 4;

/** One group of the middle, with its offset in the address — its identity, as a group's text can repeat. */
export interface AddressGroup {
  at: number;
  text: string;
}

export interface AddressSegments {
  head: string;
  middle: readonly AddressGroup[];
  tail: string;
}

/** The address split for drawing; joined back it is the address, unchanged. One too short to split is all `head`. */
export function addressSegments(raw: string): AddressSegments {
  const address = raw.trim();
  if (address.length <= ADDRESS_ENDS * 2) return { head: address, middle: [], tail: "" };
  const inner = address.slice(ADDRESS_ENDS, -ADDRESS_ENDS);
  const middle: AddressGroup[] = [];
  for (let i = 0; i < inner.length; i += GROUP) middle.push({ at: ADDRESS_ENDS + i, text: inner.slice(i, i + GROUP) });
  return { head: address.slice(0, ADDRESS_ENDS), middle, tail: address.slice(-ADDRESS_ENDS) };
}
