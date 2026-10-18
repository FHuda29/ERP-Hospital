import { CanActivate, ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { IS_PUBLIC, PERMISSIONS, type AppRequest, type AuthUser } from '../common/auth.js';
import { AppError } from '../common/errors.js';
import { hasPermission, type Permission } from '../common/permissions.js';

/** Autentikasi JWT (Bearer) + otorisasi RBAC dalam satu guard global. */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const req = ctx.switchToHttp().getRequest<AppRequest>();
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) throw new AppError('UNAUTHENTICATED', 'Sesi tidak ditemukan, silakan login', HttpStatus.UNAUTHORIZED);

    try {
      req.user = (await this.jwt.verifyAsync<AuthUser & { sub: string }>(token)) as AuthUser;
      req.user.id = (req.user as AuthUser & { sub: string }).sub;
    } catch {
      throw new AppError('SESSION_EXPIRED', 'Sesi tidak valid atau kedaluwarsa', HttpStatus.UNAUTHORIZED);
    }

    const required = this.reflector.getAllAndOverride<Permission[]>(PERMISSIONS, targets);
    if (required?.length && !required.some((p) => hasPermission(req.user!.roles, p))) {
      throw new AppError('FORBIDDEN', `Akses ditolak — butuh izin: ${required.join(' / ')}`, HttpStatus.FORBIDDEN);
    }
    return true;
  }
}
