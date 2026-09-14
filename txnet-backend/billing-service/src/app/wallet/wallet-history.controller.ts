import { Controller, Get, NotFoundException, Param, ParseUUIDPipe, Query, Req } from '@nestjs/common';
import { RateLimitBucket, rateLimitBucketKey } from '@txnet-backend/shared-core';
import type { Request } from 'express';

import { LocaleService } from '../locale/locale.service';
import { identityOf } from '../request/identity.middleware';
import { RateLimit } from '../request/rate-limit';
import { ZodValidationPipe } from '../request/zod-validation.pipe';
import { WalletHistoryService } from './wallet-history.service';
import {
  WalletHistoryQuery,
  WalletPaymentsQuery,
  walletHistorySchema,
  walletPaymentsSchema,
} from './wallet-history.schema';

/**
 * The panel's financial page, read side (F-092-n): the wallet ledger and the
 * top-up attempts, as two lists. Behind the gate like every billing route
 * (`app.module.ts`) — whose wallet is read comes from its `X-User-Id`, never
 * from the query, so there is no id here to authorise.
 *
 * Neither route throws a domain error: a filter that matches nothing is an
 * empty page, and a user with no wallet has a zero balance rather than a 404.
 * The only failures are a malformed query (400, from the pipe) and the limiter
 * (429), so unlike the deposit routes this controller maps nothing.
 */
@Controller('billing/wallet')
export class WalletHistoryController {
  constructor(
    private readonly history: WalletHistoryService,
    private readonly locale: LocaleService,
  ) {}

  @Get('history')
  @RateLimit({
    key: (req) => rateLimitBucketKey(RateLimitBucket.WALLET_HISTORY, identityOf(req).userId),
    configKey: 'WALLET_HISTORY_RATE_LIMIT',
    windowSec: 900,
  })
  ledger(@Query(new ZodValidationPipe(walletHistorySchema)) query: WalletHistoryQuery, @Req() req: Request) {
    const { userId } = identityOf(req);
    // The search is matched against labels in the language the request asked
    // for — the same one the panel is rendering those labels in.
    const lang = (req as { language?: string }).language || this.locale.getDefaultLanguage();
    return this.history.ledger({ userId, lang, ...query });
  }

  @Get('payments')
  @RateLimit({
    key: (req) => rateLimitBucketKey(RateLimitBucket.WALLET_PAYMENTS, identityOf(req).userId),
    configKey: 'WALLET_PAYMENTS_RATE_LIMIT',
    windowSec: 900,
  })
  payments(@Query(new ZodValidationPipe(walletPaymentsSchema)) query: WalletPaymentsQuery, @Req() req: Request) {
    return this.history.payments({ userId: identityOf(req).userId, ...query });
  }

  /**
   * One of the caller's own top-up attempts (F-093-l) — what `/payment/pending`
   * polls. Another user's id is the same 404 as an id that does not exist.
   */
  @Get('payments/:id')
  @RateLimit({
    key: (req) => rateLimitBucketKey(RateLimitBucket.WALLET_PAYMENT, identityOf(req).userId),
    configKey: 'WALLET_PAYMENT_RATE_LIMIT',
    windowSec: 900,
  })
  async payment(@Param('id', new ParseUUIDPipe()) id: string, @Req() req: Request) {
    const row = await this.history.payment(identityOf(req).userId, id);
    if (!row) throw new NotFoundException();
    return row;
  }
}
