import {
  Body,
  CanActivate,
  Controller,
  ExecutionContext,
  ForbiddenException,
  Get,
  HttpException,
  HttpStatus,
  Injectable,
  Ip,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { RateLimitBucket, holdsPermission, rateLimitBucketKey } from '@txnet-backend/shared-core';
import type { Request } from 'express';

import { identityOf } from '../request/identity.middleware';
import { RateLimit } from '../request/rate-limit';
import { ZodValidationPipe } from '../request/zod-validation.pipe';
import { PinBody, pinSchema } from './pins.schema';
import {
  CurrencyPinRefused,
  CurrencyPinRejection,
  CurrencyPinService,
  PinActor,
  PinForm,
  PinView,
} from './pins.service';

/** Granted to `Admin` (migration 20260928003400); the service's platform-owner check is the real boundary. */
export const CURRENCY_PIN = 'currency.pin';

@Injectable()
export class CurrencyPinGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    if (!holdsPermission(identityOf(context.switchToHttp().getRequest<Request>()).permissions, CURRENCY_PIN)) {
      throw new ForbiddenException(`${CURRENCY_PIN} is required`);
    }
    return true;
  }
}

const READ = {
  key: (req: Request) => rateLimitBucketKey(RateLimitBucket.CURRENCY_READ, identityOf(req).userId),
  configKey: 'CURRENCY_READ_RATE_LIMIT' as const,
  windowSec: 60,
};

const WRITE = {
  key: (req: Request) => rateLimitBucketKey(RateLimitBucket.CURRENCY_PIN_WRITE, identityOf(req).userId),
  configKey: 'CURRENCY_PIN_WRITE_RATE_LIMIT' as const,
  windowSec: 900,
};

const STATUS: Record<CurrencyPinRejection, 400 | 403 | 404 | 409> = {
  not_platform_owner: 403,
  currency_not_yours: 403,
  currency_not_found: 404,
  pin_not_found: 404,
  base_currency: 409,
  derived_currency: 409,
  pin_over: 409,
  invalid_rate: 400,
};

/**
 * A manual rate (F-0608-a, F-116-j, ADR-0101): the form's data, a pin, and an
 * early end. `currency.pin` at the door; inside, the platform owner pins for
 * everyone and any other tenant for its own books only.
 */
@Controller('currency/pins')
@UseGuards(CurrencyPinGuard)
export class CurrencyPinsController {
  constructor(private readonly pins: CurrencyPinService) {}

  @Get(':code')
  @RateLimit(READ)
  view(@Req() req: Request, @Param('code') code: string, @Ip() ip: string): Promise<PinForm> {
    return refusing(() => this.pins.view(actorOf(req, ip), code.toUpperCase()));
  }

  @Post()
  @RateLimit(WRITE)
  pin(@Req() req: Request, @Body(new ZodValidationPipe(pinSchema)) body: PinBody, @Ip() ip: string): Promise<PinView> {
    return refusing(() => this.pins.pin(actorOf(req, ip), body));
  }

  @Post(':id/end')
  @RateLimit(WRITE)
  end(@Req() req: Request, @Param('id', new ParseUUIDPipe()) id: string, @Ip() ip: string): Promise<PinView> {
    return refusing(() => this.pins.end(actorOf(req, ip), id));
  }
}

function actorOf(req: Request, ip: string): PinActor {
  const identity = identityOf(req);
  return { userId: identity.userId, tenantId: identity.tenantId, ip };
}

async function refusing<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (e) {
    if (!(e instanceof CurrencyPinRefused)) throw e;
    const payload = { reason: e.reason, message: e.message };
    switch (STATUS[e.reason]) {
      case 403:
        throw new ForbiddenException(payload);
      case 404:
        throw new NotFoundException(payload);
      case 400:
        throw new HttpException(payload, HttpStatus.BAD_REQUEST);
      default:
        throw new HttpException(payload, HttpStatus.CONFLICT);
    }
  }
}
