import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { hrwPick, HrwCandidate } from './hrw';

/**
 * Rendezvous placement, K of N (F-027-di, network `contract.inbounds.md` rule
 * 4b). Billing places a buyer in TypeScript; `network-service`'s vendored
 * `internal/lease/hrw` is the reference a later mover in Go will pick with.
 * Nothing can be imported across that boundary: `contracts/network/hrw.json`
 * holds cases the Go package produced, and the Go half is
 * `network-service/internal/lease/hrw/contract_test.go`. What would break
 * silently:
 *
 *  - **a different hash** — the two sides pick different inbounds for one
 *    buyer, and the first move in Go reshuffles everyone;
 *  - **a lost inbound moving more than its own buyers** — the write storm of
 *    SPEC weakness #25.
 */
const FIXTURE = join(__dirname, '../../../../../contracts/network/hrw.json');
type Case = { name: string; key: string; k: number; newUser: boolean; candidates: HrwCandidate[]; want: string[] };
const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8')) as { cases: Case[] };

describe('contracts/network/hrw.json', () => {
  it.each(fixture.cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    expect(hrwPick(c.key, c.candidates, c.k, c.newUser)).toEqual(c.want);
  });
});

describe('hrwPick', () => {
  const inbounds = (n: number): HrwCandidate[] => Array.from({ length: n }, (_, i) => ({ id: String(i + 1), weight: 1, healthy: true, full: false }));
  const buyers = Array.from({ length: 4000 }, (_, i) => `grant-${i}`);

  it('a lost inbound moves only its own buyers, and every other buyer keeps both of its picks', () => {
    const before = new Map(buyers.map((b) => [b, hrwPick(b, inbounds(8), 2, false)]));
    const lost = inbounds(8).map((c) => (c.id === '3' ? { ...c, healthy: false } : c));
    for (const b of buyers) {
      const was = before.get(b) ?? [];
      const now = hrwPick(b, lost, 2, false);
      if (!was.includes('3')) expect(now).toEqual(was);
      else expect(now).toEqual(expect.arrayContaining(was.filter((id) => id !== '3')));
    }
  });

  it('spreads buyers evenly over equal inbounds', () => {
    const count = new Map<string, number>();
    for (const b of buyers) for (const id of hrwPick(b, inbounds(4), 1, true)) count.set(id, (count.get(id) ?? 0) + 1);
    for (const n of count.values()) expect(Math.abs(n - 1000)).toBeLessThan(150);
  });
});
