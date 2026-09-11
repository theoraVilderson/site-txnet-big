import { Controller, Get } from '@nestjs/common';

/**
 * Liveness, for compose and the swarm — replaces the Nx scaffold's
 * `Hello API billing`.
 *
 * Outside `IdentityMiddleware` (`app.module.ts`) because a container health
 * check does not come through the gate, and outside the Traefik router because
 * that publishes `/api/billing` only: this path is reachable on the private
 * network and nowhere else, as `gateway-service`'s is.
 */
@Controller('health')
export class HealthController {
  @Get()
  health() {
    return { ok: true };
  }
}
