/**
 * A lottery's draw, as the verify page can redo it (ADR-0111 point 5).
 *
 * The close (F-707-k) fixes the entrant list and its hash, then seals a seed.
 * The draw (F-707-l) opens the seed and runs `lotteryPlaces`; the result is
 * published beside the seed and the list. The user's verify page (F-707-n)
 * runs **this same file** over what was published: same list hash, same
 * permutation, or the draw was not the one published.
 *
 * So nothing here touches Node: only Web Crypto (`crypto.subtle`) and
 * `TextEncoder`, which a browser and Node both have. Every function is async
 * because `crypto.subtle` is.
 *
 * `hmac-sha256-fisher-yates-v1`, exactly:
 *  1. `block(i)` = HMAC-SHA256(key = the seed's 32 bytes, message =
 *     UTF-8 `<listHash>:<i>`), for i = 0, 1, 2, …; the stream is the blocks
 *     in order, read as big-endian unsigned 32-bit words.
 *  2. `below(m)`: the next word `u` with `u < 2^32 − (2^32 mod m)` (rejection
 *     sampling: every value `< m` equally likely), answered as `u mod m`.
 *  3. Tickets `[1..n]`; for i = 0 … k−1, swap place i with place
 *     `i + below(n − i)` (Fisher–Yates, stopped after k places).
 *  4. Places 1..W go to the prizes in rank order, each `winnersCount` times;
 *     the next `reservesCount` places are reserves, in order.
 *
 * A change to any step is a new algorithm name, never an edit of this one: a
 * published draw names the algorithm it was made with.
 */

export const LOTTERY_ALGORITHM = 'hmac-sha256-fisher-yates-v1';

const LIST_HASH_PREFIX = 'txnet-lottery-list-v1';
const TWO_32 = 0x1_0000_0000;

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
}

function bytesOfHex(value: string): Uint8Array<ArrayBuffer> {
  if (!/^(?:[0-9a-f]{2})+$/.test(value)) throw new Error('a lottery seed is lowercase hex');
  const out = new Uint8Array(value.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(value.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * SHA-256, hex, of `txnet-lottery-list-v1\n<lotteryId>\n` then one
 * `<ticket>:<entrantId>\n` per ticket in ticket order. Only what is published
 * goes in.
 */
export async function lotteryListHash(lotteryId: string, tickets: Array<{ ticketNumber: number; entrantId: string }>): Promise<string> {
  const lines = [...tickets].sort((a, b) => a.ticketNumber - b.ticketNumber).map((t) => `${t.ticketNumber}:${t.entrantId}\n`);
  const text = `${LIST_HASH_PREFIX}\n${lotteryId}\n${lines.join('')}`;
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}

/** The words of step 1, one HMAC block at a time. */
function wordStream(key: CryptoKey, listHash: string): () => Promise<number> {
  let block = 0;
  let words: DataView | null = null;
  let at = 0;
  return async () => {
    if (!words || at === words.byteLength) {
      const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${listHash}:${block}`));
      block += 1;
      words = new DataView(mac);
      at = 0;
    }
    const word = words.getUint32(at, false);
    at += 4;
    return word;
  };
}

/**
 * The first `k` places of the permutation of tickets 1..n (steps 1–3): the
 * ticket numbers, in place order. `k` is capped at `n`.
 */
export async function drawPermutation(seedHex: string, listHash: string, n: number, k: number): Promise<number[]> {
  if (!Number.isSafeInteger(n) || n < 0 || !Number.isSafeInteger(k) || k < 0) throw new Error('a draw takes whole counts');
  if (n >= TWO_32) throw new Error('a draw takes fewer than 2^32 tickets');
  const take = Math.min(n, k);
  if (take === 0) return [];
  const key = await crypto.subtle.importKey('raw', bytesOfHex(seedHex), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const next = wordStream(key, listHash);
  const below = async (m: number): Promise<number> => {
    const limit = TWO_32 - (TWO_32 % m);
    for (;;) {
      const u = await next();
      if (u < limit) return u % m;
    }
  };
  const tickets = Array.from({ length: n }, (_, i) => i + 1);
  for (let i = 0; i < take; i += 1) {
    const j = i + (await below(n - i));
    [tickets[i], tickets[j]] = [tickets[j], tickets[i]];
  }
  return tickets.slice(0, take);
}

export type LotteryPlace = {
  /** 1-based place in the permutation. */
  position: number;
  ticketNumber: number;
  /** The prize's rank for a winner; `null` for a reserve. */
  prizeRank: number | null;
};

/**
 * Every place of a draw (step 4): winners for the prizes in rank order, then
 * the reserves. With fewer tickets than places, the last prizes go unawarded
 * and reserves come only from what is left.
 */
export async function lotteryPlaces(draw: {
  seed: string;
  listHash: string;
  entrantCount: number;
  prizes: Array<{ rank: number; winnersCount: number }>;
  reservesCount: number;
}): Promise<LotteryPlace[]> {
  const ranks = [...draw.prizes].sort((a, b) => a.rank - b.rank).flatMap((p) => Array.from({ length: p.winnersCount }, () => p.rank));
  const tickets = await drawPermutation(draw.seed, draw.listHash, draw.entrantCount, ranks.length + draw.reservesCount);
  return tickets.map((ticketNumber, i) => ({ position: i + 1, ticketNumber, prizeRank: i < ranks.length ? ranks[i] : null }));
}
