import {
  CanActivate,
  ExecutionContext,
  Injectable,
  HttpException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  RATE_LIMIT_KEY,
  RateLimitOptions,
} from '../../auth/decorators/rate-limit.decorator';
import { RateLimiter } from '../rate-limit/rate-limiter';

@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly rateLimiter: RateLimiter,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const options = this.reflector.getAllAndOverride<RateLimitOptions>(
      RATE_LIMIT_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!options) return true;

    const request = context.switchToHttp().getRequest();
    const { allowed } = await this.rateLimiter.hit(
      options.key(request),
      options.limit,
      options.windowSec,
    );
    if (!allowed) throw new HttpException('Too Many Requests', 429);
    return true;
  }
}
