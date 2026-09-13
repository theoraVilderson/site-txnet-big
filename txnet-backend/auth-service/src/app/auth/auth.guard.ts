import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';
import { TokenService } from './token.service';
import { SessionStore } from './session/session.store';
import { SwitchScope } from '../common/security/switch-scope';
import { PermissionStateStore } from './permissions/permission-state.store';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly tokens: TokenService,
    private readonly sessions: SessionStore,
    private readonly permissions: PermissionStateStore,
  ) {}

  async canActivate(context: ExecutionContext) {
    const request = context
      .switchToHttp()
      .getRequest<Request & { user?: any; switchScope?: SwitchScope | null }>();
    const header = request.get('authorization') ?? '';
    if (!header.startsWith('Bearer '))
      throw new UnauthorizedException('authorization required');

    const claims = this.tokens.verify(header.slice(7));

    // OTP and reset tokens are signed with the same secret, so the signature
    // alone cannot tell them apart from an access token — only `purpose` can.
    // Same condition as NoActiveSessionGuard, and as the `sessionId != ""`
    // check auth-handler applies at the gateway.
    if (claims.purpose || !claims.sessionId)
      throw new UnauthorizedException('invalid token');

    const session = await this.sessions.read(claims.sessionId);
    if (!session) throw new UnauthorizedException('session revoked');

    // ADR-0043: the same rule `auth-handler` applies at the gate, because this
    // service's own guarded routes are not behind the gate. `reason` is what a
    // client matches on to refresh once and retry; `msg` is translated.
    if (await this.permissions.isStale(claims)) {
      throw new UnauthorizedException({
        i18nKey: 'auth.permissionsChanged',
        reason: 'permissionsChanged',
      });
    }

    // ADR-0032: for an authenticated call the scope is the one stamped on the
    // session, not the one `SwitchScopeMiddleware` re-derived from the request.
    // That is what lets a Mini App session minted under `bot:<platform>:<chat>`
    // still see the chat's group when it calls `/auth/accounts` carrying only a
    // `device_id` cookie. A session with no stamp keeps the request's answer,
    // so nothing minted before this shipped changes behaviour.
    if (session.scopeKey) request.switchScope = session.scopeKey;

    request.user = claims;
    return true;
  }
}
