import { Controller, Get } from '@nestjs/common';

/** Liveness for compose and Swarm. No Traefik route publishes this service yet. */
@Controller('health')
export class HealthController {
  @Get()
  health() {
    return { ok: true };
  }
}
