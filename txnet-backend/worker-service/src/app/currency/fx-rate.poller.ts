import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { FxSource, rateOf } from './fx-source';

/**
 * A source that answered, with the mid of its book normalised to units of its
 * currency per one USD (`rateOf`) — rial for IRR, euro for EUR.
 */
export interface FxSourceRead {
  source: string;
  ok: true;
  rate: Prisma.Decimal;
  latencyMs: number;
}

/** A source that did not, and why. Never an exception — see the class below. */
export interface FxSourceFailure {
  source: string;
  ok: false;
  reason: string;
  latencyMs: number;
}

/** One source's answer for one poll. There is exactly one per active source. */
export type FxSourceOutcome = FxSourceRead | FxSourceFailure;

/**
 * A type guard rather than a bare `o.ok` test, because this workspace compiles
 * without `strictNullChecks` and a boolean discriminant does not narrow a union
 * in that mode — `tsc` rejects `o.reason` on the false branch of `o.ok ? … : …`.
 * A predicate narrows in every mode, so the check reads the same at every call
 * site and the compiler agrees with it.
 */
export const answered = (o: FxSourceOutcome): o is FxSourceRead => o.ok;

const TWO = new Prisma.Decimal(2);

/**
 * F-0603 — the read half of the FX loop, and the half that is **completely
 * decoupled from the request path**. Nothing here is ever called while someone
 * is waiting for a page: it is driven by a tick (ADR-0027), and the price a
 * request sees comes from Redis, written by a later step in this loop (F-0606).
 *
 * The two rules the catalog states for this step are both about blast radius
 * rather than about getting a number:
 *
 * **Concurrently.** Four sources polled in sequence is four readings taken up
 * to twelve seconds apart, which is not a sample of one moment's price — it is
 * four different moments, and F-0604's median over them is a median of nothing
 * in particular. It is also a job that takes twelve seconds to fail.
 *
 * **Three seconds each.** The deadline is per source and it is the *point* of
 * the concurrency: a domestic exchange that has stopped answering — the normal
 * case during a shutdown, which is when this matters most — costs its own
 * outcome and nothing else.
 *
 * **This never throws.** Every way a source can fail is an outcome, because
 * the whole design of the loop (D-22, F-0604) is that sources are expected to
 * fail and the reduction decides what to do about it. A poller that threw on
 * the first refusal would hand F-0604 an empty sample every time one exchange
 * was down and turn "one broken API cannot move the price" into "one broken
 * API stops the price".
 */
@Injectable()
export class FxRatePoller {
  private readonly logger = new Logger(FxRatePoller.name);
  private readonly timeoutMs: number;

  constructor(config: ConfigService) {
    this.timeoutMs = config.get<number>('FX_SOURCE_TIMEOUT_MS', 3_000);
  }

  /**
   * `rialPerUsdt` is this tick's accepted USDT/IRT rate (F-116-i), which a
   * `rial-per-unit` source is divided into; null when the tick has none, and
   * then such a source is a failure like any other.
   */
  async poll(
    sources: readonly FxSource[],
    rialPerUsdt: Prisma.Decimal | null = null,
  ): Promise<FxSourceOutcome[]> {
    // `allSettled` over the whole list rather than a loop: this is the
    // concurrency, and `query` already resolves rather than rejects, so the
    // settled wrapper is a belt against a bug in it, not the mechanism.
    const settled = await Promise.allSettled(
      sources.map((source) => this.query(source, rialPerUsdt)),
    );

    return settled.map((s, i) =>
      s.status === 'fulfilled'
        ? s.value
        : {
            source: sources[i].key,
            ok: false as const,
            reason: reasonOf(s.reason),
            latencyMs: 0,
          },
    );
  }

  private async query(
    source: FxSource,
    rialPerUsdt: Prisma.Decimal | null,
  ): Promise<FxSourceOutcome> {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(source.url, {
        signal: controller.signal,
        headers: { accept: 'application/json' },
      });
      if (!response.ok)
        return this.failed(
          source,
          started,
          `answered ${response.status}`,
        );

      const top = source.parse(await response.json());

      // A crossed book (bid above ask) is a well-formed answer that cannot be
      // true of one moment: either the two sides were read at different times
      // or the parser has the array order backwards. Both are wrong in a way
      // the mid would hide, so it is named here rather than averaged away.
      if (top.bestBid.gt(top.bestAsk))
        return this.failed(
          source,
          started,
          `crossed book: bid ${top.bestBid.toString()} > ask ${top.bestAsk.toString()}`,
        );

      const mid = top.bestBid.plus(top.bestAsk).div(TWO);
      const rate = rateOf(source, mid, rialPerUsdt);

      return {
        source: source.key,
        ok: true,
        rate,
        latencyMs: Date.now() - started,
      };
    } catch (error) {
      const aborted =
        error instanceof Error &&
        (error.name === 'AbortError' || error.name === 'TimeoutError');
      return this.failed(
        source,
        started,
        aborted ? `no answer within ${this.timeoutMs}ms` : reasonOf(error),
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private failed(
    source: FxSource,
    started: number,
    reason: string,
  ): FxSourceOutcome {
    const latencyMs = Date.now() - started;
    // Debug, not warn: a source that is down is the expected weather here, and
    // the run log is where an operator reads how many answered (F-0604 raises
    // the alert when too few did).
    this.logger.debug(`${source.key}: ${reason} (${latencyMs}ms)`);
    return { source: source.key, ok: false, reason, latencyMs };
  }
}

const reasonOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
