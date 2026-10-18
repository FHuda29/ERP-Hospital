import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { Request } from 'express';
import type { Permission } from './permissions.js';

/** Identitas pengguna terautentikasi — konteks tenant ikut di sini (facilityId). */
export interface AuthUser {
  id: string;
  username: string;
  name: string;
  facilityId: string;
  roles: string[];
  unitId: string | null;
  practitionerId: string | null;
}

export interface AppRequest extends Request {
  user?: AuthUser;
  requestId?: string;
}

export const IS_PUBLIC = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC, true);

export const PERMISSIONS = 'permissions';
/** Pengguna harus memiliki SALAH SATU izin yang disebutkan. */
export const Permissions = (...perms: Permission[]) => SetMetadata(PERMISSIONS, perms);

export const AUDIT_RESOURCE = 'auditResource';
/** Nama resource untuk audit otomatis atas mutasi (POST/PUT/PATCH/DELETE). */
export const AuditResource = (resource: string) => SetMetadata(AUDIT_RESOURCE, resource);

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthUser => {
  const req = ctx.switchToHttp().getRequest<AppRequest>();
  return req.user!;
});

export interface RequestMeta {
  requestId?: string;
  ip?: string;
}

export const ReqMeta = createParamDecorator((_: unknown, ctx: ExecutionContext): RequestMeta => {
  const req = ctx.switchToHttp().getRequest<AppRequest>();
  return { requestId: req.requestId, ip: req.ip };
});
