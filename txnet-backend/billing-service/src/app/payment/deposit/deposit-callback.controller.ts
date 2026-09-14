import { Controller, Get, Query, Req, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RateLimitBucket, rateLimitBucketKey } from '@txnet-backend/shared-core';
import type { Request, Response } from 'express';

import type { EnvConfig } from '../../config/env.validation';
import { RateLimit } from '../../request/rate-limit';
import { DepositCallbackService, SettledCallback } from './deposit-callback.service';
import { signResultToken } from './payment-result-token';

/**
 * Where a bank sends the payer back (F-092-j).
 *
 * **The only public route in `billing-service`**, and a controller of its own
 * for exactly that reason: everything in `DepositController` sits behind the
 * gate and reads its user from a header, and a public handler beside them is
 * one refactor away from someone assuming an identity that is not there. Here
 * the absence is the file.
 *
 * Traefik routes it without `my-auth` on the **tenant's own panel host**, and
 * `CallbackTenantMiddleware` resolves that host to a tenant before anything
 * else runs (ADR-0025). A host nobody owns never reaches this class.
 *
 * It answers a **302**, never JSON: the caller is a browser mid-redirect, and
 * what it needs is the panel's result page (F-093-f). The five codes below are
 * legacy's verbatim, because that page turns exactly these into i18n keys —
 * the one thing from `payment/verify/route.ts` that had to survive the port
 * unchanged.
 */

/** The panel pages the browser is handed back to. Relative, on the host it arrived on. */
const RESULT_PATH = { success: '/payment/success', failed: '/payment/failed', pending: '/payment/pending' } as const;

/**
 * Where the browser goes: the result page for the outcome, carrying the outcome
 * **only** as a signed `?t=` (`payment-result-token.ts`). Nothing readable is
 * put on the query string any more, because the page used to print what it was
 * given and a hand-typed `?ref=` was a paid top-up on screen.
 *
 * With no secret configured there is no token, and the panel sends a payer
 * without one to the financial page — where the real row is — rather than
 * guessing. Production refuses to boot that way (`env.validation.ts`).
 */
function resultUrl(outcome: SettledCallback, secret: string): string {
  // Absolute to the panel the payer started from: the callback may have landed
  // on a relay or the API host, where a relative path is a 404.
  const origin = outcome.returnOrigin ?? '';
  const path = outcome.kind === 'failed' ? RESULT_PATH.failed : outcome.kind === 'verifying' ? RESULT_PATH.pending : RESULT_PATH.success;
  if (!secret) return `${origin}${path}`;
  return `${origin}${path}?t=${encodeURIComponent(signResultToken(outcome, secret))}`;
}

@Controller('billing/deposit')
export class DepositCallbackController {
  constructor(
    private readonly callbacks: DepositCallbackService,
    private readonly config: ConfigService<EnvConfig, true>,
  ) {}

  /**
   * Zarinpal names its query parameters `Authority` and `Status` (ADR-0028).
   * Read case-insensitively because a redirect is re-assembled by a browser and
   * by whatever sits in front of us, and a casing difference here would be a
   * payment that settles nowhere.
   *
   * The limit is bucketed on the authority, not on a user: there is no user.
   * `rate-limit-coverage.spec.ts` names this controller as the one place that
   * is allowed, and says why.
   */
  @Get('callback')
  @RateLimit({
    key: (req) => rateLimitBucketKey(RateLimitBucket.DEPOSIT_CALLBACK, authorityOf(req) || 'none'),
    configKey: 'DEPOSIT_CALLBACK_RATE_LIMIT',
    windowSec: 900,
  })
  async callback(@Req() req: Request, @Res() res: Response, @Query() _query: unknown) {
    // Nothing here throws to the client. A bank's payer must land on a page
    // whatever happened, so every outcome — including a broken one — is a
    // redirect carrying a code the panel can explain (F-093-f).
    const outcome = await this.callbacks.settle({
      authority: authorityOf(req),
      gatewayStatus: paramOf(req, 'status'),
    });
    res.redirect(resultUrl(outcome, this.config.get('PAYMENT_RESULT_SECRET', { infer: true })));
  }
}

/** `Authority`, however the redirect spelled it. */
function authorityOf(req: Request): string {
  return paramOf(req, 'authority') ?? '';
}

function paramOf(req: Request, name: string): string | null {
  const query = (req.query ?? {}) as Record<string, unknown>;
  for (const [key, value] of Object.entries(query)) {
    if (key.toLowerCase() !== name) continue;
    // A repeated parameter arrives as an array. Two different authorities on
    // one redirect is not a callback to guess at.
    if (typeof value === 'string') return value;
    return null;
  }
  return null;
}
