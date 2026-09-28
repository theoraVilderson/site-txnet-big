import { Controller, Get } from '@nestjs/common';

/**
 * Liveness for compose and Swarm. Excluded from `IdentityMiddleware`, and not
 * published by Traefik: the router publishes `/api/currency` only.
 */
@Controller('health')
export class HealthController {
  @Get()
  health() {
    return { ok: true };
  }
}
