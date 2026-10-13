import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ForbiddenException,
} from '@nestjs/common';

@Injectable()
export class SensitiveActionGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const user = request.user;
    if (user?.isImpersonated) {
      throw new ForbiddenException(
        'Sensitive actions are not allowed during impersonation',
      );
    }
    return true;
  }
}
