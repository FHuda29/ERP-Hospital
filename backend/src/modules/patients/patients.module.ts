import { Body, Controller, Get, Inject, Injectable, Module, Param, Patch, Post, Query } from '@nestjs/common';
import { and, desc, eq, ilike, ne, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { DB, type Db } from '../../database/database.js';
import {
  appointments,
  charges,
  clinicalNotes,
  diagnoses,
  encounters,
  invoices,
  orders,
  patientAllergies,
  patientConsents,
  patientMerges,
  patients,
  prescriptions,
  queueTickets,
  units,
  vitalSigns,
} from '../../database/schema.js';
import { AuditResource, CurrentUser, Permissions, ReqMeta, type AuthUser, type RequestMeta } from '../../common/auth.js';
import { conflict, invalid, notFound } from '../../common/errors.js';
import { ZodPipe, zDate, zPagination } from '../../common/zod.pipe.js';
import { AuditService } from '../../core/audit.service.js';
import { CryptoService } from '../../core/crypto.service.js';
import { SequenceService } from '../../core/sequence.service.js';

const PatientSchema = z.object({
  nik: z.string().regex(/^\d{16}$/, 'NIK harus 16 digit').nullish(),
  name: z.string().trim().min(2).max(150),
  birthDate: zDate,
  birthPlace: z.string().nullish(),
  gender: z.enum(['L', 'P']),
  bloodType: z.enum(['A', 'B', 'AB', 'O', 'A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-']).nullish(),
  motherName: z.string().nullish(),
  phone: z.string().regex(/^[0-9+\-\s]{6,20}$/).nullish(),
  address: z.string().nullish(),
  city: z.string().nullish(),
  province: z.string().nullish(),
  religion: z.string().nullish(),
  maritalStatus: z.enum(['BELUM_KAWIN', 'KAWIN', 'CERAI_HIDUP', 'CERAI_MATI']).nullish(),
  occupation: z.string().nullish(),
  bpjsNumber: z.string().regex(/^\d{13}$/, 'No. kartu JKN 13 digit').nullish(),
  emergencyContactName: z.string().nullish(),
  emergencyContactPhone: z.string().nullish(),
  /** Petugas menyatakan pasien bukan duplikat dari kandidat yang ditampilkan */
  confirmNotDuplicate: z.boolean().optional(),
});
type PatientInput = z.infer<typeof PatientSchema>;

const AllergySchema = z.object({
  substance: z.string().min(2),
  category: z.enum(['OBAT', 'MAKANAN', 'LINGKUNGAN']),
  reaction: z.string().nullish(),
  severity: z.enum(['RINGAN', 'SEDANG', 'BERAT']),
});

const ConsentSchema = z.object({
  type: z.enum(['GENERAL_CONSENT', 'TINDAKAN_MEDIS', 'BERBAGI_DATA_SATUSEHAT', 'PENOLAKAN_TINDAKAN']),
  granted: z.boolean(),
  signedBy: z.string().min(2),
  relationship: z.string().nullish(),
  encounterId: z.uuid().nullish(),
  notes: z.string().nullish(),
});

const MergeSchema = z.object({ sourceId: z.uuid(), targetId: z.uuid(), reason: z.string().min(10) });

@Injectable()
export class PatientsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly crypto: CryptoService,
    private readonly seq: SequenceService,
    private readonly audit: AuditService,
  ) {}

  /** Bentuk publik pasien: NIK selalu termask, ciphertext tidak pernah keluar. */
  private present(p: typeof patients.$inferSelect) {
    const { nikEncrypted: _e, nikHash: _h, ...rest } = p;
    return { ...rest, nikMasked: p.nikLast4 ? `************${p.nikLast4}` : null };
  }

  async search(facilityId: string, q: z.infer<typeof zPagination>) {
    const conds = [eq(patients.facilityId, facilityId), ne(patients.status, 'MERGED')];
    const term = q.q?.trim();
    if (term) {
      if (/^\d{16}$/.test(term)) conds.push(eq(patients.nikHash, this.crypto.lookupHash(term)));
      else if (/^\d{13}$/.test(term)) conds.push(eq(patients.bpjsNumber, term));
      else if (/^\d{1,8}$/.test(term)) conds.push(or(eq(patients.mrn, term.padStart(8, '0')), ilike(patients.phone, `%${term}%`))!);
      else conds.push(ilike(patients.name, `%${term}%`));
    }
    const rows = await this.db
      .select()
      .from(patients)
      .where(and(...conds))
      .orderBy(desc(patients.updatedAt))
      .limit(q.limit)
      .offset(q.offset);
    return rows.map((r) => this.present(r));
  }

  /** Kandidat duplikat: NIK sama (pasti) atau nama mirip + tanggal lahir + jenis kelamin sama. */
  async findDuplicates(facilityId: string, input: { nik?: string | null; name: string; birthDate: string; gender: string }, excludeId?: string) {
    const conds = [
      eq(patients.facilityId, facilityId),
      ne(patients.status, 'MERGED'),
      or(
        input.nik ? eq(patients.nikHash, this.crypto.lookupHash(input.nik)) : sql`false`,
        and(
          eq(patients.birthDate, input.birthDate),
          eq(patients.gender, input.gender),
          // pg_trgm tidak diasumsikan tersedia: cocokkan kata pertama nama
          ilike(patients.name, `%${input.name.trim().split(/\s+/)[0]}%`),
        ),
      )!,
    ];
    if (excludeId) conds.push(ne(patients.id, excludeId));
    const rows = await this.db.select().from(patients).where(and(...conds)).limit(10);
    return rows.map((r) => ({
      ...this.present(r),
      matchType: input.nik && r.nikHash === this.crypto.lookupHash(input.nik) ? 'NIK' : 'DEMOGRAFI',
    }));
  }

  async create(user: AuthUser, input: PatientInput) {
    const dups = await this.findDuplicates(user.facilityId, input);
    const nikDup = dups.find((d) => d.matchType === 'NIK');
    if (nikDup) throw conflict('DUPLICATE_PATIENT_NIK', `NIK sudah terdaftar pada No. RM ${nikDup.mrn}`, { candidates: [nikDup] });
    if (dups.length && !input.confirmNotDuplicate) {
      throw conflict('POSSIBLE_DUPLICATE_PATIENT', 'Ditemukan pasien dengan data mirip. Periksa kandidat atau konfirmasi bukan duplikat.', { candidates: dups });
    }
    return this.db.transaction(async (tx) => {
      const mrn = await this.seq.mrn(tx, user.facilityId);
      const { nik, confirmNotDuplicate: _c, ...rest } = input;
      const [row] = await tx
        .insert(patients)
        .values({
          ...rest,
          facilityId: user.facilityId,
          mrn,
          name: rest.name.toUpperCase(),
          nikEncrypted: nik ? this.crypto.encrypt(nik) : null,
          nikHash: nik ? this.crypto.lookupHash(nik) : null,
          nikLast4: nik ? nik.slice(-4) : null,
        })
        .returning();
      return { ...this.present(row), patientId: row.id };
    });
  }

  async get(user: AuthUser, id: string, meta: RequestMeta) {
    const [p] = await this.db.select().from(patients).where(and(eq(patients.id, id), eq(patients.facilityId, user.facilityId)));
    if (!p) throw notFound('Pasien', id);
    const allergies = await this.db
      .select()
      .from(patientAllergies)
      .where(and(eq(patientAllergies.patientId, id), eq(patientAllergies.active, true)));
    await this.audit.log(user, { action: 'READ', resourceType: 'Patient', resourceId: id, patientId: id }, meta);
    return { ...this.present(p), allergies, mergedInto: p.status === 'MERGED' ? p.mergedIntoId : null };
  }

  /** Membuka NIK lengkap — wajib alasan & tercatat di audit. */
  async revealNik(user: AuthUser, id: string, reason: string, meta: RequestMeta) {
    const [p] = await this.db.select().from(patients).where(and(eq(patients.id, id), eq(patients.facilityId, user.facilityId)));
    if (!p) throw notFound('Pasien', id);
    await this.audit.log(user, { action: 'REVEAL_NIK', resourceType: 'Patient', resourceId: id, patientId: id, reason }, meta);
    return { nik: p.nikEncrypted ? this.crypto.decrypt(p.nikEncrypted) : null };
  }

  async update(user: AuthUser, id: string, input: Partial<PatientInput>) {
    const { nik, confirmNotDuplicate: _c, ...rest } = input;
    const patch: Partial<typeof patients.$inferInsert> = { ...rest, updatedAt: new Date() };
    if (rest.name) patch.name = rest.name.toUpperCase();
    if (nik) {
      const hash = this.crypto.lookupHash(nik);
      const [other] = await this.db
        .select({ mrn: patients.mrn })
        .from(patients)
        .where(and(eq(patients.facilityId, user.facilityId), eq(patients.nikHash, hash), ne(patients.id, id)));
      if (other) throw conflict('DUPLICATE_PATIENT_NIK', `NIK sudah terdaftar pada No. RM ${other.mrn}`);
      Object.assign(patch, { nikEncrypted: this.crypto.encrypt(nik), nikHash: hash, nikLast4: nik.slice(-4) });
    }
    const [row] = await this.db
      .update(patients)
      .set(patch)
      .where(and(eq(patients.id, id), eq(patients.facilityId, user.facilityId)))
      .returning();
    if (!row) throw notFound('Pasien', id);
    return { ...this.present(row), patientId: row.id };
  }

  async addAllergy(user: AuthUser, patientId: string, input: z.infer<typeof AllergySchema>) {
    await this.assertPatient(user.facilityId, patientId);
    const [row] = await this.db
      .insert(patientAllergies)
      .values({ ...input, facilityId: user.facilityId, patientId, recordedBy: user.id })
      .returning();
    return row;
  }

  async deactivateAllergy(user: AuthUser, patientId: string, allergyId: string) {
    const [row] = await this.db
      .update(patientAllergies)
      .set({ active: false })
      .where(and(eq(patientAllergies.id, allergyId), eq(patientAllergies.patientId, patientId), eq(patientAllergies.facilityId, user.facilityId)))
      .returning();
    if (!row) throw notFound('Alergi', allergyId);
    return row;
  }

  async addConsent(user: AuthUser, patientId: string, input: z.infer<typeof ConsentSchema>) {
    await this.assertPatient(user.facilityId, patientId);
    const [row] = await this.db
      .insert(patientConsents)
      .values({ ...input, facilityId: user.facilityId, patientId, recordedBy: user.id })
      .returning();
    return row;
  }

  listConsents(facilityId: string, patientId: string) {
    return this.db
      .select()
      .from(patientConsents)
      .where(and(eq(patientConsents.patientId, patientId), eq(patientConsents.facilityId, facilityId)))
      .orderBy(desc(patientConsents.createdAt));
  }

  async encounterHistory(facilityId: string, patientId: string) {
    return this.db
      .select({
        id: encounters.id,
        encounterNo: encounters.encounterNo,
        type: encounters.type,
        status: encounters.status,
        unitName: units.name,
        startAt: encounters.startAt,
        endAt: encounters.endAt,
      })
      .from(encounters)
      .innerJoin(units, eq(units.id, encounters.unitId))
      .where(and(eq(encounters.patientId, patientId), eq(encounters.facilityId, facilityId)))
      .orderBy(desc(encounters.startAt));
  }

  /**
   * Penggabungan rekam medis ganda (terotorisasi, petugas rekam medis).
   * Semua data klinis & keuangan dipindah ke pasien target; pasien sumber ditandai MERGED.
   */
  async merge(user: AuthUser, input: z.infer<typeof MergeSchema>, meta: RequestMeta) {
    if (input.sourceId === input.targetId) throw invalid('MERGE_SAME_PATIENT', 'Pasien sumber dan target sama');
    const source = await this.assertPatient(user.facilityId, input.sourceId);
    const target = await this.assertPatient(user.facilityId, input.targetId);
    if (source.status === 'MERGED' || target.status === 'MERGED') throw conflict('PATIENT_ALREADY_MERGED', 'Salah satu pasien sudah digabung');

    await this.db.transaction(async (tx) => {
      const move = { patientId: input.targetId };
      for (const t of [encounters, patientAllergies, patientConsents, appointments, vitalSigns, clinicalNotes, diagnoses, orders, prescriptions, charges, invoices]) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await tx.update(t as any).set(move).where(eq((t as any).patientId, input.sourceId));
      }
      await tx.update(queueTickets).set(move).where(eq(queueTickets.patientId, input.sourceId));
      // NIK/BPJS dari sumber dipakai bila target belum punya
      await tx
        .update(patients)
        .set({
          nikEncrypted: target.nikEncrypted ?? source.nikEncrypted,
          nikHash: target.nikHash ?? source.nikHash,
          nikLast4: target.nikLast4 ?? source.nikLast4,
          bpjsNumber: target.bpjsNumber ?? source.bpjsNumber,
          updatedAt: new Date(),
        })
        .where(eq(patients.id, input.targetId));
      await tx
        .update(patients)
        .set({ status: 'MERGED', mergedIntoId: input.targetId, nikHash: null, updatedAt: new Date() })
        .where(eq(patients.id, input.sourceId));
      await tx.insert(patientMerges).values({
        facilityId: user.facilityId,
        sourcePatientId: input.sourceId,
        targetPatientId: input.targetId,
        reason: input.reason,
        mergedBy: user.id,
      });
      await this.audit.log(
        user,
        { action: 'MERGE', resourceType: 'Patient', resourceId: input.targetId, patientId: input.targetId, reason: input.reason, metadata: { sourceId: input.sourceId, sourceMrn: source.mrn } },
        meta,
        tx,
      );
    });
    return { id: input.targetId, mergedFrom: source.mrn, into: target.mrn };
  }

  private async assertPatient(facilityId: string, id: string) {
    const [p] = await this.db.select().from(patients).where(and(eq(patients.id, id), eq(patients.facilityId, facilityId)));
    if (!p) throw notFound('Pasien', id);
    return p;
  }
}

@Controller('patients')
@AuditResource('Patient')
export class PatientsController {
  constructor(private readonly svc: PatientsService) {}

  @Get()
  @Permissions('patient.read')
  search(@CurrentUser() u: AuthUser, @Query(new ZodPipe(zPagination)) q: z.infer<typeof zPagination>) {
    return this.svc.search(u.facilityId, q);
  }

  @Post('check-duplicates')
  @Permissions('patient.write')
  checkDuplicates(@CurrentUser() u: AuthUser, @Body(new ZodPipe(PatientSchema.pick({ nik: true, name: true, birthDate: true, gender: true }))) body: { nik?: string | null; name: string; birthDate: string; gender: string }) {
    return this.svc.findDuplicates(u.facilityId, body);
  }

  @Post()
  @Permissions('patient.write')
  create(@CurrentUser() u: AuthUser, @Body(new ZodPipe(PatientSchema)) body: PatientInput) {
    return this.svc.create(u, body);
  }

  @Post('merge')
  @Permissions('patient.merge')
  merge(@CurrentUser() u: AuthUser, @Body(new ZodPipe(MergeSchema)) body: z.infer<typeof MergeSchema>, @ReqMeta() meta: RequestMeta) {
    return this.svc.merge(u, body, meta);
  }

  @Get(':id')
  @Permissions('patient.read')
  get(@CurrentUser() u: AuthUser, @Param('id') id: string, @ReqMeta() meta: RequestMeta) {
    return this.svc.get(u, id, meta);
  }

  @Post(':id/reveal-nik')
  @Permissions('patient.write')
  reveal(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body(new ZodPipe(z.object({ reason: z.string().min(5) }))) body: { reason: string }, @ReqMeta() meta: RequestMeta) {
    return this.svc.revealNik(u, id, body.reason, meta);
  }

  @Patch(':id')
  @Permissions('patient.write')
  update(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body(new ZodPipe(PatientSchema.partial())) body: Partial<PatientInput>) {
    return this.svc.update(u, id, body);
  }

  @Get(':id/encounters')
  @Permissions('patient.read')
  encounters(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.svc.encounterHistory(u.facilityId, id);
  }

  @Post(':id/allergies')
  @Permissions('patient.write', 'clinical.write')
  addAllergy(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body(new ZodPipe(AllergySchema)) body: z.infer<typeof AllergySchema>) {
    return this.svc.addAllergy(u, id, body);
  }

  @Post(':id/allergies/:allergyId/deactivate')
  @Permissions('clinical.write')
  deactivateAllergy(@CurrentUser() u: AuthUser, @Param('id') id: string, @Param('allergyId') allergyId: string) {
    return this.svc.deactivateAllergy(u, id, allergyId);
  }

  @Get(':id/consents')
  @Permissions('patient.read')
  consents(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.svc.listConsents(u.facilityId, id);
  }

  @Post(':id/consents')
  @Permissions('patient.write', 'clinical.write')
  addConsent(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body(new ZodPipe(ConsentSchema)) body: z.infer<typeof ConsentSchema>) {
    return this.svc.addConsent(u, id, body);
  }
}

@Module({
  controllers: [PatientsController],
  providers: [PatientsService],
  exports: [PatientsService],
})
export class PatientsModule {}
