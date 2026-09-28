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
 * How the mid of one source's book becomes "units of its currency per one
 * USD" — the one shape every `currency_exchange_rate` row is in (ADR-0098
 * part 6, USDT read as USD).
 *
 * - `per-usdt` — the book prices one USDT in the currency (USDT/IRT in rial,
 *   USDT/EUR, USDT/TRY): the mid as it stands.
 * - `toman-per-usdt` — the same, in toman: the mid times ten. IRR only.
 * - `usdt-per-unit` — the book prices one unit of the currency in USDT
 *   (EUR/USDT): one over the mid.
 * - `rial-per-unit` — an Iranian market's rial price of one unit (D-51): this
 *   tick's accepted USDT/IRT rate divided by it. The domestic path that keeps a
 *   foreign currency rated when the international internet is cut.
 * - `toman-per-unit` — the same in toman: divided by the mid times ten.
 */
export type FxReads =
  | 'per-usdt'
  | 'toman-per-usdt'
  | 'usdt-per-unit'
  | 'rial-per-unit'
  | 'toman-per-unit';

/**
 * One place a USD→currency rate can be read from (D-22 for IRR, D-51 for
 * every other currency).
 *
 * **Why an order book and not a "price".** D-22 chose the domestic exchanges'
 * public USDT/IRT books because they need no API key and stay reachable from
 * inside Iran during a national-internet shutdown. A book has two sides and
 * the mid of the best bid and the best ask is the number that means "what one
 * USDT costs right now"; a `lastTradePrice` is whatever the last person
 * happened to pay, which on a thin book is a different thing. The one
 * exception is a market that publishes a single quote and no book (`tgju`):
 * its quote is both sides.
 *
 * **`reads` is not decoration.** These exchanges quote in toman and in rial
 * interchangeably and the difference is exactly tenfold; EUR/USDT and USDT/EUR
 * are each other's inverse. A source read the wrong way passes every sanity
 * check that looks at one source in isolation, and F-0605's 5% deviation gate
 * would then reject the *correct* rate for ever while reporting nothing more
 * useful than "moved too far". So it is a property of the source, declared
 * once, next to its URL.
 */
export interface FxSource {
  /** Stable id. It is what `FX_SOURCES*` names and what a run log reports. */
  readonly key: string;
  /** The `currency.code` this source rates. It is read for no other. */
  readonly currency: string;
  readonly url: string;
  readonly reads: FxReads;
  /** Throws with a readable reason if the body is not the shape it expects. */
  parse(body: unknown): FxBookTop;
}

const TEN = new Prisma.Decimal(10);
const ONE = new Prisma.Decimal(1);

/**
 * The mid of `source`'s book as units of its currency per one USD. Throws
 * with a readable reason — the poller turns it into that source's failure.
 * `rialPerUsdt` is this tick's **accepted** USDT/IRT rate, or null when the
 * tick has none; a `rial-per-unit` source cannot be read without it.
 */
export function rateOf(
  source: FxSource,
  mid: Prisma.Decimal,
  rialPerUsdt: Prisma.Decimal | null,
): Prisma.Decimal {
  switch (source.reads) {
    case 'per-usdt':
      return mid;
    case 'toman-per-usdt':
      return mid.mul(TEN);
    case 'usdt-per-unit':
      return ONE.div(mid);
    case 'rial-per-unit':
    case 'toman-per-unit':
      if (!rialPerUsdt)
        throw new Error('no USDT/IRT rate accepted this tick to divide by');
      return rialPerUsdt.div(source.reads === 'toman-per-unit' ? mid.mul(TEN) : mid);
  }
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

/** `[[price, amount], …]` — the shape most of these APIs answer in. */
const topOfPairArrays = (body: unknown, key: string): Prisma.Decimal => {
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
  currency: 'IRR',
  url: 'https://apiv2.nobitex.ir/v3/orderbook/USDTIRT',
  reads: 'per-usdt',
  parse: (body) => ({
    bestBid: topOfPairArrays(body, 'bids'),
    bestAsk: topOfPairArrays(body, 'asks'),
  }),
};

/** Tabdeal — the second endpoint D-22 states, quoting in toman. */
export const tabdeal: FxSource = {
  key: 'tabdeal',
  currency: 'IRR',
  url: 'https://api.tabdeal.org/r/api/v1/depth?symbol=USDTIRT',
  reads: 'toman-per-usdt',
  parse: (body) => ({
    bestBid: topOfPairArrays(body, 'bids'),
    bestAsk: topOfPairArrays(body, 'asks'),
  }),
};

/**
 * Wallex. **The endpoint below is not from D-22** — D-22 names the exchange
 * and leaves the URL open. Watched answering on 2026-09-28 (F-116-i), a
 * toman book in line with the other two, and on by default since.
 */
export const wallex: FxSource = {
  key: 'wallex',
  currency: 'IRR',
  url: 'https://api.wallex.ir/v1/depth?symbol=USDTTMN',
  reads: 'toman-per-usdt',
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

/**
 * Bitpin. **Unverified and off by default**: this URL answered 404 on
 * 2026-09-28. A source that can only fail is a permanently red line in the
 * run log, which is noise an operator learns to ignore; turn it on in the
 * change that finds its real endpoint and watches it answer.
 */
export const bitpin: FxSource = {
  key: 'bitpin',
  currency: 'IRR',
  url: 'https://api.bitpin.ir/v1/mth/orderbook/USDT_IRT/',
  reads: 'toman-per-usdt',
  parse: (body) => ({
    bestBid: topOfPairArrays(body, 'bids'),
    bestAsk: topOfPairArrays(body, 'asks'),
  }),
};

/** A book whose two sides sit one object down (`{data: {bids, asks}}` and the like). */
const bookAt =
  (inner: (body: unknown) => unknown, bid = 'bids', ask = 'asks') =>
  (body: unknown): FxBookTop => {
    const b = inner(body);
    return { bestBid: topOfPairArrays(b, bid), bestAsk: topOfPairArrays(b, ask) };
  };

const itself = (body: unknown) => body;

// ---------------------------------------------------------------------------
// Foreign books (D-51, ADR-0098 part 8). Public, no API key, and every URL
// below was watched answering on 2026-09-28 (F-116-i). Reachable only from a
// node with international internet — the other half of the node question in
// `currency/open-questions.md`; `tgju` is the domestic half.
// ---------------------------------------------------------------------------

/** Binance EUR/USDT — USDT per euro, so it is inverted. */
export const binanceEur: FxSource = {
  key: 'binance-eur',
  currency: 'EUR',
  url: 'https://api.binance.com/api/v3/depth?symbol=EURUSDT&limit=5',
  reads: 'usdt-per-unit',
  parse: bookAt(itself),
};

/** Kraken USDT/EUR — `{error: [], result: {USDTEUR: {bids, asks}}}`. */
export const krakenEur: FxSource = {
  key: 'kraken-eur',
  currency: 'EUR',
  url: 'https://api.kraken.com/0/public/Depth?pair=USDTEUR&count=5',
  reads: 'per-usdt',
  parse: bookAt((body) => {
    const b = body as { error?: unknown[]; result?: Record<string, unknown> };
    if (Array.isArray(b?.error) && b.error.length > 0)
      throw new Error(`answered an error: ${b.error.join('; ')}`);
    const pair = b?.result && Object.values(b.result)[0];
    if (!pair) throw new Error('result has no pair');
    return pair;
  }),
};

/** Bitstamp USDT/EUR. */
export const bitstampEur: FxSource = {
  key: 'bitstamp-eur',
  currency: 'EUR',
  url: 'https://www.bitstamp.net/api/v2/order_book/usdteur/',
  reads: 'per-usdt',
  parse: bookAt(itself),
};

/** Coinbase USDT-EUR, level 1 — the top of the book only. */
export const coinbaseEur: FxSource = {
  key: 'coinbase-eur',
  currency: 'EUR',
  url: 'https://api.exchange.coinbase.com/products/USDT-EUR/book?level=1',
  reads: 'per-usdt',
  parse: bookAt(itself),
};

/** Binance USDT/TRY. */
export const binanceTry: FxSource = {
  key: 'binance-try',
  currency: 'TRY',
  url: 'https://api.binance.com/api/v3/depth?symbol=USDTTRY&limit=5',
  reads: 'per-usdt',
  parse: bookAt(itself),
};

/** BtcTurk USDT/TRY — the domestic Turkish exchange, `{data: {bids, asks}}`. */
export const btcturkTry: FxSource = {
  key: 'btcturk-try',
  currency: 'TRY',
  url: 'https://api.btcturk.com/api/v2/orderbook?pairSymbol=USDTTRY&limit=5',
  reads: 'per-usdt',
  parse: bookAt((body) => (body as { data?: unknown })?.data),
};

/** OKX USDT-TRY — `{data: [{bids, asks}]}`. */
export const okxTry: FxSource = {
  key: 'okx-try',
  currency: 'TRY',
  url: 'https://www.okx.com/api/v5/market/books?instId=USDT-TRY&sz=5',
  reads: 'per-usdt',
  parse: bookAt((body) => (body as { data?: unknown[] })?.data?.[0]),
};

/** Bybit spot USDT/TRY — `{result: {b, a}}`. */
export const bybitTry: FxSource = {
  key: 'bybit-try',
  currency: 'TRY',
  url: 'https://api.bybit.com/v5/market/orderbook?category=spot&symbol=USDTTRY&limit=5',
  reads: 'per-usdt',
  parse: bookAt((body) => (body as { result?: unknown })?.result, 'b', 'a'),
};

// ---------------------------------------------------------------------------
// The domestic path for a foreign currency (D-51): an Iranian market's rial
// price of one unit, divided into this tick's USDT/IRT. Reachable from inside
// Iran when the foreign books are not.
// ---------------------------------------------------------------------------

/**
 * tgju's live market table, the free-market rial price of one unit. **A
 * quote, not a book** — one price, so it is both sides — and an unofficial
 * endpoint of a public site, which is why it is one voice in a median and
 * never a currency's only source.
 */
const tgju = (currency: string, item: string): FxSource => ({
  key: `tgju-${currency.toLowerCase()}`,
  currency,
  url: 'https://call1.tgju.org/ajax.json',
  reads: 'rial-per-unit',
  parse: (body) => {
    const p = (body as { current?: Record<string, { p?: unknown }> })?.current?.[item]?.p;
    const q = price(typeof p === 'string' ? p.replace(/,/g, '') : p, `current.${item}.p`);
    return { bestBid: q, bestAsk: q };
  },
});

export const tgjuEur = tgju('EUR', 'price_eur');
export const tgjuTry = tgju('TRY', 'price_try');

/**
 * Abantether's coin list — its euro, bought and sold in **toman**
 * (`price_buy` is the ask, `price_sell` the bid). Watched answering from
 * inside Iran with no proxy on 2026-09-28, which is what makes it the second
 * domestic voice for EUR next to `tgju`. Its `tether_price` field is ignored:
 * that is a foreign cross, and the point of this source is not to need one.
 */
export const abantetherEur: FxSource = {
  key: 'abantether-eur',
  currency: 'EUR',
  url: 'https://api.abantether.com/manager/coins/data',
  reads: 'toman-per-unit',
  parse: (body) => {
    const coins = (body as { data?: unknown })?.data;
    if (!Array.isArray(coins)) throw new Error('data is not a list');
    const eur = coins.find((c) => (c as { symbol?: unknown })?.symbol === 'EUR') as
      | { price_buy?: unknown; price_sell?: unknown }
      | undefined;
    if (!eur) throw new Error('data has no EUR');
    return {
      bestBid: price(eur.price_sell, 'EUR.price_sell'),
      bestAsk: price(eur.price_buy, 'EUR.price_buy'),
    };
  },
};

/**
 * Every source this build knows how to read. Which of them are *used* is
 * config (`FX_SOURCES` for IRR, `FX_SOURCES_<CODE>` for the others), because
 * D-22 ends on a compliance note rather than a technical one: three of the
 * Iranian exchanges were put on the US OFAC list in June 2026, and dropping
 * one has to be a config change an operator makes, not a release.
 */
export const FX_SOURCES: readonly FxSource[] = [
  nobitex,
  tabdeal,
  wallex,
  bitpin,
  binanceEur,
  krakenEur,
  bitstampEur,
  coinbaseEur,
  tgjuEur,
  abantetherEur,
  binanceTry,
  btcturkTry,
  okxTry,
  bybitTry,
  tgjuTry,
];

/**
 * The sources `keys` names for `currency`. Throws on a key this build does
 * not implement, and on one that rates another currency — a USDT/IRT book
 * listed under EUR would be a rial price read as a euro one.
 */
export function fxSourcesFor(currency: string, keys: readonly string[]): FxSource[] {
  return keys.map((key) => {
    const source = FX_SOURCES.find((s) => s.key === key);
    if (!source)
      throw new Error(
        `'${key}' is listed for ${currency}, and no source in this build implements it (known: ${FX_SOURCES.filter((s) => s.currency === currency).map((s) => s.key).join(', ') || 'none'})`,
      );
    if (source.currency !== currency)
      throw new Error(`'${key}' rates ${source.currency}, not ${currency}`);
    return source;
  });
}
