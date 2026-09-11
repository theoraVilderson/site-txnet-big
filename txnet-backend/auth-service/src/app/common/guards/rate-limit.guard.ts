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

    // Resolved per request, not baked into the metadata: the route names its
    // variable and the value is read here, so a deployment varies it without a
    // rebuild (F-087). There is no second number to fall back on — the schema
    // gives every limit a default, so a missing or nonsensical value means
    // something is wrong with the deployment, and guessing would hide it.
    const limit = this.config.get<number>(options.configKey);
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit <= 0) {
      throw new Error(
        `rate limit ${options.configKey} resolved to ${String(limit)}; ` +
          'every limit must be a positive whole number with a schema default',
      );
    }

    const request = context.switchToHttp().getRequest();
    const bucket = options.key(request);

    // Two counters, both incremented before either is judged: the tenant's
    // own budget, and the platform-wide ceiling over the same bucket
    // (F-066-s). A refused request is still traffic, so it counts in both —
    // hammering a limited route keeps the window open rather than resetting
    // it. Only the guard's buckets are caller-derived; the login-failure
    // counter names the account under attack and stays tenant-scoped.
    const tenant = await this.rateLimiter.hit(bucket, limit, options.windowSec);
    const platform = await this.rateLimiter.hitPlatform(
      bucket,
      limit,
      options.windowSec,
    );
    if (!tenant.allowed || !platform.allowed)
      throw new HttpException('Too Many Requests', 429);
    return true;
  }
}
