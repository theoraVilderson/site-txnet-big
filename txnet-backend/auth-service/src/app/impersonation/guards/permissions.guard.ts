import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ForbiddenException,
} from '@nestjs/common';

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private requiredPermissions: string[]) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const user = request.user;
    if (!user) throw new ForbiddenException();
    const hasPermission = this.requiredPermissions.every((perm) =>
      user.permissions?.includes(perm),
    );
    if (!hasPermission)
      throw new ForbiddenException('Insufficient permissions');
    return true;
  }
}
