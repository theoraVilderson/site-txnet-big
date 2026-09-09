import {
  CanActivate,
  ExecutionContext,
  Injectable,
  HttpException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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
    private readonly config: ConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const options = this.reflector.getAllAndOverride<RateLimitOptions>(
      RATE_LIMIT_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!options) return true;

    // Resolved per request, not baked into the metadata: a route names the
    // variable that may override its limit and the value is read here, so a
    // deployment can vary it without a rebuild (`configKey` on the decorator).
    const limit = options.configKey
      ? this.config.get<number>(options.configKey, options.limit)
      : options.limit;

    const request = context.switchToHttp().getRequest();
    const { allowed } = await this.rateLimiter.hit(
      options.key(request),
      limit,
      options.windowSec,
    );
    if (!allowed) throw new HttpException('Too Many Requests', 429);
    return true;
  }
}
