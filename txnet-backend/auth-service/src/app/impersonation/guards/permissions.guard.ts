import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ForbiddenException,
} from '@nestjs/common';
import { holdsPermission } from '@txnet-backend/shared-core';

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private requiredPermissions: string[]) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const user = request.user;
    if (!user) throw new ForbiddenException();
    const hasPermission = this.requiredPermissions.every((perm) =>
      holdsPermission(user.permissions, perm),
    );
    if (!hasPermission)
      throw new ForbiddenException('Insufficient permissions');
    return true;
  }
}
