import { Prisma } from '@prisma/client';

/**
 * The top of one side of an order book, as the source published it — in the
 * source's **own** unit, not normalised. Normalising is `FxRatePoller`'s job,
 * so a parser stays a pure reading of one API's shape and nothing else.
 */
export interface FxBookTop {
  bestBid: Prisma.Decimal;
  bestAsk: Prisma.Decimal;
}

/**
 * One place the USD→IRR rate can be read from (D-22).
 *
 * **Why an order book and not a "price".** D-22 chose the domestic exchanges'
 * public USDT/IRT books because they need no API key and stay reachable from
 * inside Iran during a national-internet shutdown. A book has two sides and
 * the mid of the best bid and the best ask is the number that means "what one
 * USDT costs right now"; a `lastTradePrice` is whatever the last person
 * happened to pay, which on a thin book is a different thing.
 *
 * **`unit` is not decoration.** These exchanges quote in toman and in rial
 * interchangeably and the difference is exactly tenfold. A toman source read
 * as rial passes every sanity check that looks at one source in isolation, and
 * F-0605's 5% deviation gate would then reject the *correct* rate for ever
 * while reporting nothing more useful than "moved too far". So the unit is a
 * property of the source, declared once, next to its URL.
 */
export interface FxSource {
  /** Stable id. It is what `FX_SOURCES` names and what a run log reports. */
  readonly key: string;
  readonly url: string;
  readonly unit: 'rial' | 'toman';
  /** Throws with a readable reason if the body is not the shape it expects. */
  parse(body: unknown): FxBookTop;
}

/** A price level, however the API spells one. */
const price = (v: unknown, where: string): Prisma.Decimal => {
  if (typeof v !== 'string' && typeof v !== 'number')
    throw new Error(`${where} is not a price`);
  let d: Prisma.Decimal;
  try {
    d = new Prisma.Decimal(v);
  } catch {
    throw new Error(`${where} is not a number: ${String(v)}`);
  }
  if (!d.isFinite() || d.lte(0))
    throw new Error(`${where} is not a positive price: ${d.toString()}`);
  return d;
};

/** `[[price, amount], …]` — the shape three of these four APIs answer in. */
const topOfPairArrays = (body: unknown, key: 'bids' | 'asks'): Prisma.Decimal => {
  const levels = (body as Record<string, unknown>)?.[key];
  if (!Array.isArray(levels) || levels.length === 0)
    throw new Error(`${key} is missing or empty`);
  const level = levels[0];
  if (!Array.isArray(level) || level.length === 0)
    throw new Error(`${key}[0] is not a [price, amount] pair`);
  return price(level[0], `${key}[0][0]`);
};

/**
 * Nobitex — the one endpoint D-22 states in full, and the only one of the four
 * that quotes in **rial**.
 */
export const nobitex: FxSource = {
  key: 'nobitex',
  url: 'https://apiv2.nobitex.ir/v3/orderbook/USDTIRT',
  unit: 'rial',
  parse: (body) => ({
    bestBid: topOfPairArrays(body, 'bids'),
    bestAsk: topOfPairArrays(body, 'asks'),
  }),
};

/** Tabdeal — the second endpoint D-22 states, quoting in toman. */
export const tabdeal: FxSource = {
  key: 'tabdeal',
  url: 'https://api.tabdeal.org/r/api/v1/depth?symbol=USDTIRT',
  unit: 'toman',
  parse: (body) => ({
    bestBid: topOfPairArrays(body, 'bids'),
    bestAsk: topOfPairArrays(body, 'asks'),
  }),
};

/**
 * Wallex. **The endpoint below is not from D-22** — D-22 names the exchange
 * and leaves the URL open — so it is off by default in `FX_SOURCES` until
 * someone has watched it answer. A source whose URL or body shape is wrong is
 * not dangerous (it fails and is discarded, `FxRatePoller`), but it is a
 * permanently failing source in the run log, which is noise an operator learns
 * to ignore. Turn it on in the same change that confirms it.
 */
export const wallex: FxSource = {
  key: 'wallex',
  url: 'https://api.wallex.ir/v1/depth?symbol=USDTTMN',
  unit: 'toman',
  parse: (body) => {
    const result = (body as { result?: unknown })?.result ?? body;
    const side = (name: 'bid' | 'ask'): Prisma.Decimal => {
      const levels = (result as Record<string, unknown>)?.[name];
      if (!Array.isArray(levels) || levels.length === 0)
        throw new Error(`result.${name} is missing or empty`);
      return price(
        (levels[0] as { price?: unknown })?.price,
        `result.${name}[0].price`,
      );
    };
    return { bestBid: side('bid'), bestAsk: side('ask') };
  },
};

/** Bitpin. Unverified endpoint, off by default — see `wallex` above. */
export const bitpin: FxSource = {
  key: 'bitpin',
  url: 'https://api.bitpin.ir/v1/mth/orderbook/USDT_IRT/',
  unit: 'toman',
  parse: (body) => ({
    bestBid: topOfPairArrays(body, 'bids'),
    bestAsk: topOfPairArrays(body, 'asks'),
  }),
};

/**
 * Every source this build knows how to read. Which of them are *used* is
 * `FX_SOURCES`, because D-22 ends on a compliance note rather than a technical
 * one: three of these four were put on the US OFAC list in June 2026, and
 * dropping one has to be a config change an operator makes, not a release.
 */
export const FX_SOURCES: readonly FxSource[] = [
  nobitex,
  tabdeal,
  wallex,
  bitpin,
];

export function fxSourcesByKey(keys: readonly string[]): FxSource[] {
  return keys.map((key) => {
    const source = FX_SOURCES.find((s) => s.key === key);
    if (!source)
      throw new Error(
        `FX_SOURCES names '${key}', which no source in this build implements (known: ${FX_SOURCES.map((s) => s.key).join(', ')})`,
      );
    return source;
  });
}
