import {
  ArgumentsHost,
  CallHandler,
  Catch,
  ExceptionFilter,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NestInterceptor,
  NestMiddleware,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Response } from 'express';
import { and, eq } from 'drizzle-orm';
import { from, of, switchMap, type Observable } from 'rxjs';
import { AUDIT_RESOURCE, type AppRequest } from '../common/auth.js';
import { AppError } from '../common/errors.js';
import { DB, type Db } from '../database/database.js';
import { idempotencyKeys } from '../database/schema.js';
import { AuditService } from './audit.service.js';

/** Setiap request mendapat X-Request-Id (diteruskan dari klien bila ada) untuk korelasi log. */
@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(req: AppRequest, res: Response, next: NextFunction) {
    const incoming = req.headers['x-request-id'];
    req.requestId = typeof incoming === 'string' && incoming.length <= 64 ? incoming : randomUUID();
    res.setHeader('X-Request-Id', req.requestId);
    next();
  }
}

/** Format error seragam: { error: { code, message, details }, requestId }. */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('HTTP');

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<AppRequest>();
    const res = ctx.getResponse<Response>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let body: { code: string; message: string; details?: unknown } = {
      code: 'INTERNAL_ERROR',
      message: 'Terjadi kesalahan pada server',
    };

    if (exception instanceof AppError) {
      status = exception.getStatus();
      body = exception.getResponse() as typeof body;
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const r = exception.getResponse();
      body = { code: HttpStatus[status] ?? 'HTTP_ERROR', message: typeof r === 'string' ? r : ((r as { message?: string }).message ?? exception.message) };
    } else {
      // Jangan bocorkan detail internal (bisa mengandung PHI) ke klien.
      this.logger.error(`[${req.requestId}] ${(exception as Error)?.stack ?? exception}`);
    }
    res.status(status).json({ error: body, requestId: req.requestId });
  }
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Idempotency-Key: mutasi yang diulang dengan key yang sama (mis. retry jaringan di kasir)
 * mengembalikan respons pertama, bukan membuat transaksi ganda.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(@Inject(DB) private readonly db: Db) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = ctx.switchToHttp().getRequest<AppRequest>();
    const res = ctx.switchToHttp().getResponse<Response>();
    const key = req.headers['idempotency-key'];
    if (!MUTATING.has(req.method) || typeof key !== 'string' || !req.user) return next.handle();
    if (key.length > 128) throw new AppError('IDEMPOTENCY_KEY_INVALID', 'Idempotency-Key terlalu panjang', HttpStatus.BAD_REQUEST);

    const userId = req.user.id;
    return from(
      this.db
        .select()
        .from(idempotencyKeys)
        .where(and(eq(idempotencyKeys.userId, userId), eq(idempotencyKeys.key, key)))
        .limit(1),
    ).pipe(
      switchMap(([existing]) => {
        if (existing) {
          if (existing.path !== req.originalUrl || existing.method !== req.method) {
            throw new AppError('IDEMPOTENCY_KEY_REUSED', 'Idempotency-Key sudah dipakai untuk request lain', HttpStatus.CONFLICT);
          }
          res.status(existing.statusCode).setHeader('Idempotent-Replay', 'true');
          return of(existing.responseBody);
        }
        return next.handle().pipe(
          switchMap((body) =>
            from(
              this.db
                .insert(idempotencyKeys)
                .values({ key, userId, method: req.method, path: req.originalUrl, statusCode: res.statusCode, responseBody: body ?? null })
                .onConflictDoNothing(),
            ).pipe(switchMap(() => of(body))),
          ),
        );
      }),
    );
  }
}

/** Audit otomatis untuk setiap mutasi berhasil pada controller yang memakai @AuditResource. */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  private readonly logger = new Logger('Audit');

  constructor(
    private readonly reflector: Reflector,
    private readonly audit: AuditService,
  ) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = ctx.switchToHttp().getRequest<AppRequest>();
    const resource = this.reflector.getAllAndOverride<string>(AUDIT_RESOURCE, [ctx.getHandler(), ctx.getClass()]);
    if (!resource || !MUTATING.has(req.method) || !req.user) return next.handle();

    const action = `${req.method} ${ctx.getHandler().name}`;
    return next.handle().pipe(
      switchMap((body) => {
        const b = (body ?? {}) as Record<string, unknown>;
        const params = req.params as Record<string, string>;
        const write = this.audit
          .log(
            req.user!,
            {
              action: action.slice(0, 32),
              resourceType: resource,
              resourceId: (b.id as string) ?? params.id ?? null,
              patientId: (b.patientId as string) ?? null,
              metadata: { path: req.originalUrl },
            },
            { requestId: req.requestId, ip: req.ip },
          )
          .catch((e: Error) => this.logger.error(`Audit gagal ditulis [${req.requestId}]: ${e.message}`));
        return from(write).pipe(switchMap(() => of(body)));
      }),
    );
  }
}
