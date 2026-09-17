import { Controller, Get } from '@nestjs/common';

/**
 * Liveness, for compose. Outside `IdentityMiddleware` and outside the Traefik
 * routers, which publish `/api/tenants` and `/api/tenant-packages` only —
 * `billing-service`'s rule.
 */
@Controller('health')
export class HealthController {
  @Get()
  health() {
    return { ok: true };
  }
}
