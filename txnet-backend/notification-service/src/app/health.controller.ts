import { Controller, Get } from '@nestjs/common';

/**
 * Liveness, for compose. Outside `IdentityMiddleware` and outside the Traefik
 * router, which publishes `/api/notifications` only — `billing-service`'s rule.
 */
@Controller('health')
export class HealthController {
  @Get()
  health() {
    return { ok: true };
  }
}
