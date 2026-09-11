import { RequestHeaders } from '@txnet-backend/shared-core';
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { timingSafeEqual } from 'crypto';

/**
 * The same string `auth-service` proves itself with, from the one place that
 * declares it (ADR-0036, C-04). This file used to hold a second copy of it.
 */
export const SERVICE_TOKEN_HEADER = RequestHeaders.serviceToken;

/**
 * Only another service of this platform may pass — `worker-service`, proven by
 * the same `SERVICE_AUTH_TOKEN` this service proves itself to `auth-api` with
 * (ADR-0011).
 *
 * The token is a symmetric platform credential, not a direction: `bot-service`
 * has always presented it going out, and F-067-b is the first time anything
 * calls *in*. Nothing new is trusted — it still says which process is calling
 * and never which user, and the one route behind it carries no user decision
 * of its own.
 *
 * A refusal is **404**, exactly as `auth-service`'s guard of the same name and
 * for the same reason as the webhook path itself: a route that answers
 * differently for a wrong token is a route that can be probed.
 *
 * The comparison is timing-safe and length-checked first, because
 * `timingSafeEqual` throws on a length mismatch rather than returning false.
 */
@Injectable()
export class ServiceOnlyGuard implements CanActivate {
  private readonly expected?: string;

  constructor(config: ConfigService) {
    this.expected = config.get<string>('SERVICE_AUTH_TOKEN');
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const given = request.headers[SERVICE_TOKEN_HEADER];
    if (typeof given !== 'string' || !this.matches(given)) {
      throw new NotFoundException();
    }
    return true;
  }

  private matches(given: string): boolean {
    if (!this.expected) return false;
    const a = Buffer.from(given);
    const b = Buffer.from(this.expected);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }
}
