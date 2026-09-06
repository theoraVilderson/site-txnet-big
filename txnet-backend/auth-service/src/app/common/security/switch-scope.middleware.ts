import { Injectable, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { isServiceCaller } from './service-caller';
import {
  DEVICE_COOKIE,
  SwitchScope,
  botScopeOf,
  deviceCookieOptions,
  deviceScopeKey,
} from './switch-scope';
import { readCookie } from '../http/cookies';

/**
 * Decides which **switch scope** a request belongs to, and — for a browser —
 * mints the cookie that names it (ADR-0015).
 *
 * It runs on every route rather than only the account routes, and that is the
 * point: the cookie has to already exist by the time someone opens the
 * switcher. Minting it there instead would mean the first add on a fresh
 * browser lands under a key the browser is only told about in the same
 * response — fine in isolation, but the panel fires several calls per page
 * load, so several of them would race to mint a different one.
 *
 * A bot call gets no cookie: the chat is already a durable identifier, and
 * `bot-service` speaks for many chats over one connection.
 *
 * Ordering: this reads what `ServiceCallerMiddleware` decided, so it is
 * registered after it in `app.module.ts`.
 */
@Injectable()
export class SwitchScopeMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction) {
    (req as { switchScope?: SwitchScope | null }).switchScope =
      this.scopeFor(req, res);
    next();
  }

  private scopeFor(req: Request, res: Response): SwitchScope | null {
    // A service caller is never a browser: it gets the chat's key, or none.
    // `botScopeOf` answers null when the platform header is missing, and the
    // scope-bearing routes refuse rather than assume a messenger.
    if (isServiceCaller(req)) return botScopeOf(req);

    const existing = readCookie(req.headers.cookie, DEVICE_COOKIE);
    if (existing) return deviceScopeKey(existing);

    const minted = randomUUID();
    res.cookie(DEVICE_COOKIE, minted, deviceCookieOptions());
    return deviceScopeKey(minted);
  }
}
