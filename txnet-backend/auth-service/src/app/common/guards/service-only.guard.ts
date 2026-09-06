import {
  CanActivate,
  ExecutionContext,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { isServiceCaller } from '../security/service-caller';

/**
 * Only another service of this platform may pass — `bot-service`, proven by
 * `SERVICE_AUTH_TOKEN` (ADR-0011).
 *
 * A refusal is **404**, not 401: these routes are an internal seam, and a route
 * that answers differently for a wrong token is a route that can be probed.
 * Same reasoning as the bot webhook's own secret.
 */
@Injectable()
export class ServiceOnlyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    if (!isServiceCaller(request)) throw new NotFoundException();
    return true;
  }
}
