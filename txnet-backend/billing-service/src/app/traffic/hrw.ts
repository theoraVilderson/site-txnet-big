/**
 * Weighted rendezvous (HRW) hashing, K of N (F-027-di, network
 * `contract.inbounds.md` rule 4b): which inbounds of a member's panel a buyer
 * is placed on under `hrw`. Deterministic — nothing is stored to remember the
 * pick — and minimal: an inbound lost moves only the buyers it held.
 *
 * A port of `network-service/internal/lease/hrw` (vendored from quotaengine,
 * ADR-0093), bit for bit: `contracts/network/hrw.json` holds cases the Go
 * package produced, and a test on each side reads it.
 */
export type HrwCandidate = {
  id: string;
  /** Capacity share; `<= 0` counts as 1. */
  weight: number;
  healthy: boolean;
  /** At its cap: skipped for a new buyer only. */
  full: boolean;
};

// BigInt(...), not `1n` literals: the build targets below ES2020.
const n = (text: string) => BigInt(text);
const MASK = n('0xffffffffffffffff');
const FNV_OFFSET = n('0xcbf29ce484222325');
const FNV_PRIME = n('0x100000001b3');
const [GOLDEN, MIX_1, MIX_2] = [n('0x9e3779b97f4a7c15'), n('0xbf58476d1ce4e5b9'), n('0x94d049bb133111eb')];
const [S11, S27, S30, S31] = [n('11'), n('27'), n('30'), n('31')];
const utf8 = new TextEncoder();

function fnv64a(bytes: Uint8Array, h: bigint): bigint {
  for (const b of bytes) h = ((h ^ BigInt(b)) * FNV_PRIME) & MASK;
  return h;
}

/** The splitmix64 finaliser: fnv alone mixes poorly in the high bits. */
function mix(z: bigint): bigint {
  z = (z + GOLDEN) & MASK;
  z = ((z ^ (z >> S30)) * MIX_1) & MASK;
  z = ((z ^ (z >> S27)) * MIX_2) & MASK;
  return z ^ (z >> S31);
}

function score(key: string, id: string, weight: number): number {
  let h = fnv64a(utf8.encode(key), FNV_OFFSET);
  h = fnv64a(Uint8Array.of(0), h);
  h = fnv64a(utf8.encode(id), h);
  const u = (Number(mix(h) >> S11) + 0.5) / 2 ** 53; // (0, 1)
  return -(weight <= 0 ? 1 : weight) / Math.log(u);
}

/**
 * Up to `k` candidate ids for `key` (the Grant), best first. A new buyer
 * skips full candidates; one already placed keeps its inbound however full.
 */
export function hrwPick(key: string, candidates: readonly HrwCandidate[], k: number, newUser: boolean): string[] {
  return candidates
    .filter((c) => c.healthy && !(newUser && c.full))
    .map((c) => ({ id: c.id, s: score(key, c.id, c.weight) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, Math.max(0, k))
    .map((c) => c.id);
}
