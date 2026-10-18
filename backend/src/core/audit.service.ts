import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { and, desc, eq, sql, type SQL } from 'drizzle-orm';
import { DB, type Db, type DbOrTx } from '../database/database.js';
import { auditEvents } from '../database/schema.js';
import type { AuthUser, RequestMeta } from '../common/auth.js';

export interface AuditInput {
  action: string;
  resourceType: string;
  resourceId?: string | null;
  patientId?: string | null;
  reason?: string | null;
  metadata?: Record<string, unknown> | null;
}

const GENESIS = '0'.repeat(64);

/**
 * Jejak audit append-only dengan hash berantai: hash_n = SHA256(hash_{n-1} | isi event).
 * Perubahan/penghapusan baris di tengah rantai akan terdeteksi oleh verifyChain().
 */
@Injectable()
export class AuditService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async log(user: Partial<AuthUser> | null, input: AuditInput, meta: RequestMeta = {}, db: DbOrTx = this.db) {
    const run = async (tx: DbOrTx) => {
      // Serialisasi penulisan agar rantai hash konsisten antar koneksi.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(727274)`);
      const [last] = await tx.select({ hash: auditEvents.hash }).from(auditEvents).orderBy(desc(auditEvents.seq)).limit(1);
      const prevHash = last?.hash ?? GENESIS;
      const at = new Date();
      const row = {
        facilityId: user?.facilityId ?? null,
        actorId: user?.id ?? null,
        actorName: user?.name ?? null,
        action: input.action,
        resourceType: input.resourceType,
        resourceId: input.resourceId ?? null,
        patientId: input.patientId ?? null,
        reason: input.reason ?? null,
        requestId: meta.requestId ?? null,
        ip: meta.ip ?? null,
        metadata: input.metadata ?? null,
        at,
      };
      const hash = AuditService.computeHash(prevHash, row);
      await tx.insert(auditEvents).values({ ...row, prevHash, hash });
    };
    // Bila dipanggil dengan transaksi, ikut transaksi itu; jika tidak, buat transaksi sendiri.
    if (db === this.db) await this.db.transaction(run);
    else await run(db);
  }

  static computeHash(prevHash: string, row: Record<string, unknown>): string {
    const canonical = JSON.stringify([
      prevHash,
      row.facilityId,
      row.actorId,
      row.action,
      row.resourceType,
      row.resourceId,
      row.patientId,
      row.reason,
      (row.at as Date).toISOString(),
    ]);
    return createHash('sha256').update(canonical).digest('hex');
  }

  async list(facilityId: string, filter: { patientId?: string; resourceType?: string; actorId?: string; limit: number; offset: number }) {
    const conds: SQL[] = [eq(auditEvents.facilityId, facilityId)];
    if (filter.patientId) conds.push(eq(auditEvents.patientId, filter.patientId));
    if (filter.resourceType) conds.push(eq(auditEvents.resourceType, filter.resourceType));
    if (filter.actorId) conds.push(eq(auditEvents.actorId, filter.actorId));
    return this.db
      .select()
      .from(auditEvents)
      .where(and(...conds))
      .orderBy(desc(auditEvents.seq))
      .limit(filter.limit)
      .offset(filter.offset);
  }

  /** Verifikasi integritas seluruh rantai audit. */
  async verifyChain(): Promise<{ valid: boolean; checked: number; brokenAtSeq?: number }> {
    const rows = await this.db.select().from(auditEvents).orderBy(auditEvents.seq);
    let prev = GENESIS;
    for (const r of rows) {
      const expected = AuditService.computeHash(prev, r as unknown as Record<string, unknown>);
      if (r.prevHash !== prev || r.hash !== expected) return { valid: false, checked: rows.length, brokenAtSeq: r.seq };
      prev = r.hash;
    }
    return { valid: true, checked: rows.length };
  }
}
