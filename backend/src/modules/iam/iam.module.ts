import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Injectable, Module, Param, Patch, Post, Query } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import bcrypt from 'bcryptjs';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { DB, type Db } from '../../database/database.js';
import { breakGlassSessions, facilities, patients, users } from '../../database/schema.js';
import {
  AuditResource,
  CurrentUser,
  Permissions,
  Public,
  ReqMeta,
  type AuthUser,
  type RequestMeta,
} from '../../common/auth.js';
import { AppError, conflict, notFound } from '../../common/errors.js';
import { ROLES, permissionsFor } from '../../common/permissions.js';
import { ZodPipe } from '../../common/zod.pipe.js';
import { AuditService } from '../../core/audit.service.js';
import { APP_CONFIG } from '../../core/tokens.js';
import type { AppConfig } from '../../config.js';

const LoginSchema = z.object({
  facilityCode: z.string().min(1),
  username: z.string().min(1),
  password: z.string().min(1),
});

/** Kebijakan kata sandi minimum: 10 karakter, huruf besar, huruf kecil, angka. */
const PasswordSchema = z
  .string()
  .min(10, 'Minimal 10 karakter')
  .regex(/[A-Z]/, 'Harus mengandung huruf besar')
  .regex(/[a-z]/, 'Harus mengandung huruf kecil')
  .regex(/\d/, 'Harus mengandung angka');

const CreateUserSchema = z.object({
  username: z.string().regex(/^[a-z0-9._-]{3,64}$/),
  fullName: z.string().min(2),
  password: PasswordSchema,
  roles: z.array(z.enum(ROLES)).min(1),
  unitId: z.uuid().nullable().optional(),
  practitionerId: z.uuid().nullable().optional(),
});

const UpdateUserSchema = z.object({
  fullName: z.string().min(2).optional(),
  roles: z.array(z.enum(ROLES)).min(1).optional(),
  unitId: z.uuid().nullable().optional(),
  practitionerId: z.uuid().nullable().optional(),
  active: z.boolean().optional(),
  password: PasswordSchema.optional(),
});

const BreakGlassSchema = z.object({
  patientId: z.uuid(),
  reason: z.string().min(15, 'Alasan akses darurat minimal 15 karakter'),
});

const MAX_FAILED = 5;
const LOCK_MINUTES = 15;

@Injectable()
export class IamService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly jwt: JwtService,
    private readonly audit: AuditService,
  ) {}

  async login(input: z.infer<typeof LoginSchema>, meta: RequestMeta) {
    const [facility] = await this.db.select().from(facilities).where(eq(facilities.code, input.facilityCode));
    const fail = () => new AppError('INVALID_CREDENTIALS', 'Kode fasilitas, username, atau kata sandi salah', HttpStatus.UNAUTHORIZED);
    if (!facility || !facility.active) throw fail();

    const [user] = await this.db
      .select()
      .from(users)
      .where(and(eq(users.facilityId, facility.id), eq(users.username, input.username)));
    if (!user || !user.active) throw fail();
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      throw new AppError('ACCOUNT_LOCKED', 'Akun terkunci sementara karena percobaan login gagal berulang', HttpStatus.UNAUTHORIZED);
    }

    const ok = await bcrypt.compare(input.password, user.passwordHash);
    if (!ok) {
      const failed = user.failedLogins + 1;
      await this.db
        .update(users)
        .set({ failedLogins: failed, lockedUntil: failed >= MAX_FAILED ? new Date(Date.now() + LOCK_MINUTES * 60_000) : null })
        .where(eq(users.id, user.id));
      await this.audit.log({ facilityId: facility.id, id: user.id, name: user.fullName }, { action: 'LOGIN_FAILED', resourceType: 'User', resourceId: user.id }, meta);
      throw fail();
    }

    await this.db.update(users).set({ failedLogins: 0, lockedUntil: null, lastLoginAt: new Date() }).where(eq(users.id, user.id));
    const authUser: AuthUser = {
      id: user.id,
      username: user.username,
      name: user.fullName,
      facilityId: facility.id,
      roles: user.roles,
      unitId: user.unitId,
      practitionerId: user.practitionerId,
    };
    await this.audit.log(authUser, { action: 'LOGIN', resourceType: 'User', resourceId: user.id }, meta);
    const { id, ...claims } = authUser;
    const accessToken = await this.jwt.signAsync({ sub: id, ...claims });
    return { accessToken, user: await this.me(authUser) };
  }

  async me(user: AuthUser) {
    const [f] = await this.db.select().from(facilities).where(eq(facilities.id, user.facilityId));
    const perms = permissionsFor(user.roles);
    return {
      ...user,
      permissions: perms === '*' ? ['*'] : [...perms],
      facility: { id: f.id, code: f.code, name: f.name, type: f.type, timezone: f.timezone, features: f.features },
    };
  }

  listUsers(facilityId: string) {
    return this.db
      .select({
        id: users.id,
        username: users.username,
        fullName: users.fullName,
        roles: users.roles,
        unitId: users.unitId,
        practitionerId: users.practitionerId,
        active: users.active,
        lastLoginAt: users.lastLoginAt,
        lockedUntil: users.lockedUntil,
      })
      .from(users)
      .where(eq(users.facilityId, facilityId))
      .orderBy(users.username);
  }

  async createUser(facilityId: string, input: z.infer<typeof CreateUserSchema>) {
    const dup = await this.db.select().from(users).where(and(eq(users.facilityId, facilityId), eq(users.username, input.username)));
    if (dup.length) throw conflict('USERNAME_TAKEN', 'Username sudah dipakai');
    const [row] = await this.db
      .insert(users)
      .values({
        facilityId,
        username: input.username,
        fullName: input.fullName,
        passwordHash: await bcrypt.hash(input.password, 12),
        roles: input.roles,
        unitId: input.unitId ?? null,
        practitionerId: input.practitionerId ?? null,
      })
      .returning({ id: users.id, username: users.username });
    return row;
  }

  async updateUser(facilityId: string, id: string, input: z.infer<typeof UpdateUserSchema>) {
    const { password, ...rest } = input;
    const patch: Partial<typeof users.$inferInsert> = { ...rest };
    if (password) patch.passwordHash = await bcrypt.hash(password, 12);
    if (input.active) patch.failedLogins = 0;
    const [row] = await this.db
      .update(users)
      .set(patch)
      .where(and(eq(users.id, id), eq(users.facilityId, facilityId)))
      .returning({ id: users.id });
    if (!row) throw notFound('Pengguna', id);
    return row;
  }

  /** Akses darurat: dicatat di audit sebagai BREAK_GLASS dan wajib ditinjau. */
  async breakGlass(user: AuthUser, input: z.infer<typeof BreakGlassSchema>, meta: RequestMeta) {
    const [p] = await this.db
      .select({ id: patients.id })
      .from(patients)
      .where(and(eq(patients.id, input.patientId), eq(patients.facilityId, user.facilityId)));
    if (!p) throw notFound('Pasien', input.patientId);
    const expiresAt = new Date(Date.now() + this.config.breakGlassMinutes * 60_000);
    const [row] = await this.db
      .insert(breakGlassSessions)
      .values({ facilityId: user.facilityId, userId: user.id, patientId: input.patientId, reason: input.reason, expiresAt })
      .returning();
    await this.audit.log(user, { action: 'BREAK_GLASS', resourceType: 'Patient', resourceId: input.patientId, patientId: input.patientId, reason: input.reason }, meta);
    return row;
  }

  listBreakGlass(facilityId: string, pendingOnly: boolean) {
    const conds = [eq(breakGlassSessions.facilityId, facilityId)];
    if (pendingOnly) conds.push(isNull(breakGlassSessions.reviewedAt));
    return this.db
      .select({
        id: breakGlassSessions.id,
        patientId: breakGlassSessions.patientId,
        patientName: patients.name,
        userId: breakGlassSessions.userId,
        userName: users.fullName,
        reason: breakGlassSessions.reason,
        expiresAt: breakGlassSessions.expiresAt,
        reviewedAt: breakGlassSessions.reviewedAt,
        reviewNote: breakGlassSessions.reviewNote,
        createdAt: breakGlassSessions.createdAt,
      })
      .from(breakGlassSessions)
      .innerJoin(users, eq(users.id, breakGlassSessions.userId))
      .innerJoin(patients, eq(patients.id, breakGlassSessions.patientId))
      .where(and(...conds))
      .orderBy(desc(breakGlassSessions.createdAt));
  }

  async reviewBreakGlass(user: AuthUser, id: string, note: string) {
    const [row] = await this.db
      .update(breakGlassSessions)
      .set({ reviewedBy: user.id, reviewedAt: new Date(), reviewNote: note })
      .where(and(eq(breakGlassSessions.id, id), eq(breakGlassSessions.facilityId, user.facilityId)))
      .returning();
    if (!row) throw notFound('Sesi break-glass', id);
    return row;
  }
}

@Controller('auth')
export class AuthController {
  constructor(private readonly svc: IamService) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  login(@Body(new ZodPipe(LoginSchema)) body: z.infer<typeof LoginSchema>, @ReqMeta() meta: RequestMeta) {
    return this.svc.login(body, meta);
  }

  @Get('me')
  me(@CurrentUser() u: AuthUser) {
    return this.svc.me(u);
  }

  @Post('break-glass')
  @Permissions('clinical.read')
  breakGlass(@CurrentUser() u: AuthUser, @Body(new ZodPipe(BreakGlassSchema)) body: z.infer<typeof BreakGlassSchema>, @ReqMeta() meta: RequestMeta) {
    return this.svc.breakGlass(u, body, meta);
  }

  @Get('break-glass')
  @Permissions('breakglass.review', 'audit.read')
  listBreakGlass(@CurrentUser() u: AuthUser, @Query('pending') pending?: string) {
    return this.svc.listBreakGlass(u.facilityId, pending === 'true');
  }

  @Post('break-glass/:id/review')
  @Permissions('breakglass.review')
  @AuditResource('BreakGlass')
  review(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body(new ZodPipe(z.object({ note: z.string().min(3) }))) body: { note: string }) {
    return this.svc.reviewBreakGlass(u, id, body.note);
  }
}

@Controller('users')
@AuditResource('User')
export class UsersController {
  constructor(private readonly svc: IamService) {}

  @Get()
  @Permissions('user.manage')
  list(@CurrentUser() u: AuthUser) {
    return this.svc.listUsers(u.facilityId);
  }

  @Get('roles')
  @Permissions('user.manage')
  roles() {
    return ROLES;
  }

  @Post()
  @Permissions('user.manage')
  create(@CurrentUser() u: AuthUser, @Body(new ZodPipe(CreateUserSchema)) body: z.infer<typeof CreateUserSchema>) {
    return this.svc.createUser(u.facilityId, body);
  }

  @Patch(':id')
  @Permissions('user.manage')
  update(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body(new ZodPipe(UpdateUserSchema)) body: z.infer<typeof UpdateUserSchema>) {
    return this.svc.updateUser(u.facilityId, id, body);
  }
}

@Module({
  controllers: [AuthController, UsersController],
  providers: [IamService],
})
export class IamModule {}
