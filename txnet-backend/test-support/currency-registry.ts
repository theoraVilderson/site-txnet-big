/**
 * The currency registry a fake transaction answers with (ADR-0153): every
 * money path reads its currency's `decimalPlaces`, so a spec's `tx` spreads
 * this in instead of each spec inventing one. The places are the seed's.
 */
const PLACES: Readonly<Record<string, number>> = { IRR: 0, IRT: 0, JPY: 0, KRW: 0, KWD: 3, BHD: 3, OMR: 3 };
const placesOf = (code: string) => PLACES[code] ?? 2;

export const currencyRegistry = {
  currency: {
    findUnique: async ({ where }: { where: { code: string } }) => ({ code: where.code, decimalPlaces: placesOf(where.code) }),
    findMany: async (args?: { where?: { code?: { in?: string[] } } }) =>
      (args?.where?.code?.in ?? Object.keys(PLACES).concat('USD', 'EUR')).map((code) => ({ code, decimalPlaces: placesOf(code) })),
  },
};

/** `currencyPlacesMap`'s answer for a pure function's spec. */
export const currencyPlaces = { of: placesOf };
