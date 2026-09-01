import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';
import { TokenService } from './token.service';
import { SessionStore } from './session/session.store';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly tokens: TokenService,
    private readonly sessions: SessionStore,
  ) {}

  async canActivate(context: ExecutionContext) {
    const request = context
      .switchToHttp()
      .getRequest<Request & { user?: any }>();
    const header = request.get('authorization') ?? '';
    if (!header.startsWith('Bearer '))
      throw new UnauthorizedException('authorization required');

    const claims = this.tokens.verify(header.slice(7));
    if (!(await this.sessions.isActive(claims.sessionId)))
      throw new UnauthorizedException('session revoked');

    request.user = claims;
    return true;
  }
}
