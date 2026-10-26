import { RequestHeaders } from '@txnet-backend/shared-core';
import { randomBytes } from 'node:crypto';

import {
  addressLine,
  CheckLine,
  PROBE_PATH,
  cacheLine,
  cnameLine,
  doorLine,
  edgeOwnerLine,
  probeLine,
  txtLine,
  verifyRecordName,
  websocketLine,
} from './domain-check';
import type { DomainLookup } from './domain-lookup';
import { OWN_EDGE_PORT, ProofPlan } from './domain-path';

/** What a check reads of a domain's row. */
export type ProbedRow = {
  domainValue: string;
  verificationToken: string | null;
  edgeOwnershipName: string | null;
  edgeOwnershipValue: string | null;
};

/** A proof in flight: its lines, and whether TXT and CNAME passed — the first stage (ADR-0129 amendment 3). */
export type Proof = { lines: Promise<CheckLine>[]; owned: Promise<boolean> };

/**
 * Runs a domain's check lines against the world (F-018-i): the lookups here,
 * the judging in `domain-check.ts`. One per service; no state between checks.
 */
export class DomainProber {
  constructor(
    private readonly lookup: DomainLookup,
    private readonly prefix: string,
  ) {}

  /**
   * The whole proof of a domain on its path: TXT, CNAME (naming no other
   * reseller's target under any platform domain), not at our address, http and
   * https as the domain itself, each request answered on its own, and the
   * edge's ownership record while the provider asks for one. On its own edge
   * also: through the domestic door, and a WebSocket both ways (NIN-1-e2).
   */
  proof(row: ProbedRow, plan: ProofPlan): Proof {
    const host = row.domainValue;
    const { target, ownEdges, ourOrigin } = plan;
    const cname = this.lookup.cname(host);
    const txt = this.txt(row);
    const pointed = cname.then((found) => cnameLine(target, plan.zones, found));
    const [http, https] = (['http', 'https'] as const).map((scheme) => {
      const nonce = randomBytes(8).toString('hex');
      const answer = this.lookup.probe(`${scheme}://${host}/${this.prefix}/${PROBE_PATH}?n=${nonce}`);
      return { answer, line: answer.then((a) => probeLine(scheme, host, target, nonce, a)) };
    });
    const lines = [
      txt,
      pointed,
      ...(ourOrigin ? [Promise.all([this.lookup.addresses(ourOrigin), this.lookup.addresses(host)]).then(([ours, found]) => addressLine(ours, found))] : []),
      http.line,
      https.line,
      ...(ownEdges ? [https.answer.then((a) => doorLine(ownEdges, OWN_EDGE_PORT, a)), this.websocket(host)] : []),
      this.cache(host),
      ...this.edgeLines(row, target, cname),
    ];
    return { lines, owned: Promise.all([txt, pointed]).then(([t, c]) => t.ok && c.ok) };
  }

  /** One upgrade through the domain to the probe, which answers with the nonce (NIN-1-e2). */
  private async websocket(host: string): Promise<CheckLine> {
    const nonce = randomBytes(8).toString('hex');
    return websocketLine(nonce, await this.lookup.upgrade(`https://${host}/${this.prefix}/${PROBE_PATH}?n=${nonce}`));
  }

  /** A verified domain's re-validation (catalog 13.2 step 6): its record, not its path — a CDN outage is not a lost domain. */
  revalidation(row: ProbedRow, target: string): Promise<CheckLine>[] {
    return [this.txt(row), ...this.edgeLines(row, target)];
  }

  private txt(row: ProbedRow): Promise<CheckLine> {
    return this.lookup.txt(verifyRecordName(row.domainValue)).then((found) => txtLine(row.domainValue, row.verificationToken ?? '', found));
  }

  /** Two requests to one URL, one after the other, each with its own nonce (ADR-0129 (8)). */
  private async cache(host: string): Promise<CheckLine> {
    const url = `https://${host}/${this.prefix}/${PROBE_PATH}`;
    const nonces: [string, string] = [randomBytes(8).toString('hex'), randomBytes(8).toString('hex')];
    const first = await this.lookup.probe(url, { [RequestHeaders.domainProbe]: nonces[0] });
    const second = await this.lookup.probe(url, { [RequestHeaders.domainProbe]: nonces[1] });
    return cacheLine(nonces, [first, second]);
  }

  /** The edge's ownership record, read while the provider asks for one (EDGE-1-d). */
  private edgeLines(row: ProbedRow, target: string, cname?: Promise<string[]>): Promise<CheckLine>[] {
    const name = row.edgeOwnershipName;
    const value = row.edgeOwnershipValue;
    if (!name || !value) return [];
    const found = cname ?? this.lookup.cname(row.domainValue);
    return [Promise.all([this.lookup.txt(name), found]).then(([txt, names]) => edgeOwnerLine({ name, value }, target, txt, names))];
  }
}
