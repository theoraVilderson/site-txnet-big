import { CanActivate, ExecutionContext, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'crypto';
import type { Request } from 'express';

import { RequestHeaders } from './headers';

/**
 * Only another process of this platform may pass, proven by `SERVICE_AUTH_TOKEN`
 * (ADR-0011).
 *
 * The internal seam this guards is how a job reaches code it cannot import: an
 * Nx application cannot import another Nx application, so `worker-service` asks
 * over HTTP and proves itself with the one symmetric platform token
 * (`domains/automation/contract.worker.md`).
 *
 * **A refusal is 404, not 401.** These routes are a seam between processes, and
 * a route that answers differently for a wrong token is a route that can be
 * probed for its existence.
 *
 * The comparison is length-checked before `timingSafeEqual`, which throws on a
 * length mismatch rather than answering false.
 *
 * **Why this lives in `shared-core` and there are still two other copies.**
 * `auth-service`'s guard of this name reads a flag its own security middleware
 * has already set, and is that middleware's half rather than a second rule;
 * `bot-service`'s is this file, written a third time, and is the one that
 * should collapse into this import — not in F-092-k, which added the third
 * caller and would be changing a service it has no other business in.
 */
@Injectable()
export class ServiceOnlyGuard implements CanActivate {
  private readonly expected?: string;

  constructor(config: ConfigService) {
    this.expected = config.get<string>('SERVICE_AUTH_TOKEN');
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const given = request.headers[RequestHeaders.serviceToken];
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
