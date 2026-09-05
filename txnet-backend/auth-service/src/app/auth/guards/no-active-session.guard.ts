import {
  CanActivate,
  ConflictException,
  ExecutionContext,
  Injectable,
} from '@nestjs/common';
import { Request } from 'express';
import { TokenService } from '../token.service';
import { SessionStore } from '../session/session.store';

/**
 * Rejects login/register while the caller already holds a live session, so a
 * signed-in user must log out before authenticating again. A missing,
 * malformed, expired, or already-revoked token means "no live session" and is
 * let through — this guard never demands a token, `AuthGuard` does that.
 */
@Injectable()
export class NoActiveSessionGuard implements CanActivate {
  constructor(
    private readonly tokens: TokenService,
    private readonly sessions: SessionStore,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const header = request.get('authorization') ?? '';
    if (!header.startsWith('Bearer ')) return true;

    let claims;
    try {
      claims = this.tokens.verify(header.slice(7));
    } catch {
      return true;
    }
    // otp_login / password_reset tokens carry no session and aren't logins.
    if (claims.purpose || !claims.sessionId) return true;

    if (await this.sessions.isActive(claims.sessionId)) {
      throw new ConflictException('auth.alreadyAuthenticated');
    }
    return true;
  }
}
