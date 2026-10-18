import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { and, eq, gt, isNull, or, sql } from 'drizzle-orm';
import { DB, type Db } from '../database/database.js';
import { breakGlassSessions, encounters } from '../database/schema.js';
import type { AuthUser } from '../common/auth.js';
import { AppError } from '../common/errors.js';
import { CARE_RELATIONSHIP_ROLES, type Role } from '../common/permissions.js';

/**
 * ABAC untuk Rekam Medis Elektronik:
 * tenaga klinis hanya boleh membuka RME pasien yang memiliki hubungan perawatan
 * (DPJP, atau kunjungan aktif/≤30 hari di unit kerjanya). Di luar itu wajib break-glass
 * dengan alasan, berbatas waktu, dan ditinjau pasca-akses.
 */
@Injectable()
export class CareAccessService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async assertCanAccessPatient(user: AuthUser, patientId: string): Promise<'RELATIONSHIP' | 'ROLE' | 'BREAK_GLASS'> {
    const restricted = user.roles.every((r) => CARE_RELATIONSHIP_ROLES.includes(r as Role));
    if (!restricted) return 'ROLE';

    const relationship = await this.db
      .select({ id: encounters.id })
      .from(encounters)
      .where(
        and(
          eq(encounters.facilityId, user.facilityId),
          eq(encounters.patientId, patientId),
          or(
            user.practitionerId ? eq(encounters.practitionerId, user.practitionerId) : sql`false`,
            user.unitId ? eq(encounters.unitId, user.unitId) : sql`false`,
          ),
          or(isNull(encounters.endAt), gt(encounters.endAt, sql`now() - interval '30 days'`)),
        ),
      )
      .limit(1);
    if (relationship.length) return 'RELATIONSHIP';

    const bg = await this.db
      .select({ id: breakGlassSessions.id })
      .from(breakGlassSessions)
      .where(
        and(
          eq(breakGlassSessions.userId, user.id),
          eq(breakGlassSessions.patientId, patientId),
          gt(breakGlassSessions.expiresAt, new Date()),
        ),
      )
      .limit(1);
    if (bg.length) return 'BREAK_GLASS';

    throw new AppError(
      'CARE_RELATIONSHIP_REQUIRED',
      'Anda tidak memiliki hubungan perawatan dengan pasien ini. Gunakan akses darurat (break-glass) dengan alasan yang jelas.',
      HttpStatus.FORBIDDEN,
      { patientId },
    );
  }
}
