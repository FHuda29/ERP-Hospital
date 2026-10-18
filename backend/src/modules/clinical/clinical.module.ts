import { Body, Controller, Get, Inject, Injectable, Module, Param, Patch, Post } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { DB, type Db } from '../../database/database.js';
import {
  clinicalNotes,
  diagnoses,
  encounters,
  icd10,
  icd9cm,
  medicationAdministrations,
  orders,
  prescriptionItems,
  prescriptions,
  procedures,
  results,
  units,
  vitalSigns,
} from '../../database/schema.js';
import { AuditResource, CurrentUser, Permissions, ReqMeta, type AuthUser, type RequestMeta } from '../../common/auth.js';
import { conflict, forbidden, invalid, notFound } from '../../common/errors.js';
import { ZodPipe } from '../../common/zod.pipe.js';
import { AuditService } from '../../core/audit.service.js';
import { CareAccessService } from '../../core/care-access.service.js';
import { FacilityService } from '../../core/core.module.js';
import { BillingModule } from '../billing/billing.module.js';
import { ChargeService } from '../billing/charge.service.js';
import { IntegrationModule, OutboxService } from '../integration/integration.module.js';

const VitalSchema = z.object({
  systolic: z.number().int().min(30).max(300).optional(),
  diastolic: z.number().int().min(10).max(200).optional(),
  heartRate: z.number().int().min(10).max(300).optional(),
  respRate: z.number().int().min(2).max(80).optional(),
  temperature: z.number().min(25).max(45).optional(),
  spo2: z.number().int().min(30).max(100).optional(),
  weight: z.number().min(0.3).max(400).optional(),
  height: z.number().min(20).max(250).optional(),
  painScore: z.number().int().min(0).max(10).optional(),
  gcs: z.number().int().min(3).max(15).optional(),
});

const NOTE_TYPES = ['SOAP', 'CPPT', 'ASESMEN_AWAL_MEDIS', 'ASESMEN_KEPERAWATAN', 'RESUME_MEDIS'] as const;
const NoteSchema = z.object({
  type: z.enum(NOTE_TYPES),
  subjective: z.string().max(10000).optional(),
  objective: z.string().max(10000).optional(),
  assessment: z.string().max(10000).optional(),
  plan: z.string().max(10000).optional(),
  instruction: z.string().max(10000).optional(),
  signNow: z.boolean().optional(),
});
const NoteUpdateSchema = NoteSchema.omit({ type: true, signNow: true });
const AmendSchema = NoteUpdateSchema.extend({ reason: z.string().min(10) });

const DiagnosisSchema = z.object({
  icd10Code: z.string().min(3).max(16),
  rank: z.enum(['PRIMER', 'SEKUNDER', 'KOMPLIKASI']),
  status: z.enum(['KERJA', 'BANDING', 'AKHIR']).default('AKHIR'),
});

const ProcedureSchema = z.object({
  icd9cmCode: z.string().max(16).optional(),
  display: z.string().min(2).optional(),
  serviceId: z.uuid().optional(),
  notes: z.string().optional(),
});

/** National Early Warning Score 2 (tanpa komponen oksigen & kesadaran). */
export function computeEws(v: z.infer<typeof VitalSchema>): number | null {
  if (v.respRate === undefined && v.spo2 === undefined && v.systolic === undefined && v.heartRate === undefined && v.temperature === undefined) return null;
  let s = 0;
  const rr = v.respRate;
  if (rr !== undefined) s += rr <= 8 ? 3 : rr <= 11 ? 1 : rr <= 20 ? 0 : rr <= 24 ? 2 : 3;
  const o2 = v.spo2;
  if (o2 !== undefined) s += o2 <= 91 ? 3 : o2 <= 93 ? 2 : o2 <= 95 ? 1 : 0;
  const sbp = v.systolic;
  if (sbp !== undefined) s += sbp <= 90 ? 3 : sbp <= 100 ? 2 : sbp <= 110 ? 1 : sbp <= 219 ? 0 : 3;
  const hr = v.heartRate;
  if (hr !== undefined) s += hr <= 40 ? 3 : hr <= 50 ? 1 : hr <= 90 ? 0 : hr <= 110 ? 1 : hr <= 130 ? 2 : 3;
  const t = v.temperature;
  if (t !== undefined) s += t <= 35 ? 3 : t <= 36 ? 1 : t <= 38 ? 0 : t <= 39 ? 1 : 2;
  return s;
}

const DOCTOR_ROLES = ['DOKTER'];
const isDoctor = (u: AuthUser) => u.roles.some((r) => DOCTOR_ROLES.includes(r));

@Injectable()
export class ClinicalService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly access: CareAccessService,
    private readonly audit: AuditService,
    private readonly chargesSvc: ChargeService,
    private readonly outbox: OutboxService,
    private readonly facility: FacilityService,
  ) {}

  /** Ambil kunjungan aktif + tegakkan ABAC. */
  private async activeEncounter(user: AuthUser, encounterId: string, allowFinished = false) {
    const [e] = await this.db.select().from(encounters).where(and(eq(encounters.id, encounterId), eq(encounters.facilityId, user.facilityId)));
    if (!e) throw notFound('Kunjungan', encounterId);
    await this.access.assertCanAccessPatient(user, e.patientId);
    if (!allowFinished && !['REGISTERED', 'TRIAGED', 'IN_PROGRESS'].includes(e.status)) {
      throw conflict('ENCOUNTER_CLOSED', 'Kunjungan sudah selesai; gunakan amandemen untuk koreksi catatan');
    }
    return e;
  }

  async addVitals(user: AuthUser, encounterId: string, input: z.infer<typeof VitalSchema>) {
    const e = await this.activeEncounter(user, encounterId);
    const ews = computeEws(input);
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(vitalSigns)
        .values({ ...input, facilityId: user.facilityId, encounterId, patientId: e.patientId, ews, recordedBy: user.id })
        .returning();
      await this.outbox.enqueue(tx, { facilityId: user.facilityId, target: 'SATUSEHAT', resourceType: 'Observation', resourceId: row.id, operation: 'CREATE' });
      const alert = ews !== null && ews >= 5 ? { level: ews >= 7 ? 'MERAH' : 'KUNING', message: `EWS ${ews}: ${ews >= 7 ? 'aktifkan tim respons cepat / code blue' : 'tingkatkan monitoring & lapor DPJP'}` } : null;
      return { ...row, alert };
    });
  }

  private hashNote(n: { type: string; subjective?: string | null; objective?: string | null; assessment?: string | null; plan?: string | null; instruction?: string | null }, authorId: string, signedAt: Date) {
    return createHash('sha256')
      .update(JSON.stringify([n.type, n.subjective, n.objective, n.assessment, n.plan, n.instruction, authorId, signedAt.toISOString()]))
      .digest('hex');
  }

  private assertNoteTypeAllowed(user: AuthUser, type: string) {
    if ((type === 'RESUME_MEDIS' || type === 'ASESMEN_AWAL_MEDIS') && !isDoctor(user) && !user.roles.includes('ADMIN')) {
      throw forbidden('NOTE_TYPE_FORBIDDEN', 'Resume medis & asesmen awal medis hanya dapat dibuat oleh dokter');
    }
  }

  async createNote(user: AuthUser, encounterId: string, input: z.infer<typeof NoteSchema>) {
    const e = await this.activeEncounter(user, encounterId);
    this.assertNoteTypeAllowed(user, input.type);
    const { signNow, ...content } = input;
    const [row] = await this.db
      .insert(clinicalNotes)
      .values({
        ...content,
        facilityId: user.facilityId,
        encounterId,
        patientId: e.patientId,
        authorId: user.id,
        authorName: user.name,
        authorRole: user.roles[0],
      })
      .returning();
    if (e.status !== 'IN_PROGRESS' && isDoctor(user)) await this.db.update(encounters).set({ status: 'IN_PROGRESS' }).where(eq(encounters.id, encounterId));
    if (signNow) return this.signNote(user, row.id);
    return row;
  }

  async updateNote(user: AuthUser, noteId: string, input: z.infer<typeof NoteUpdateSchema>) {
    const note = await this.getNote(user, noteId);
    if (note.status !== 'DRAFT') throw conflict('NOTE_SIGNED', 'Catatan yang sudah ditandatangani tidak dapat diubah; buat amandemen');
    if (note.authorId !== user.id) throw forbidden('NOT_NOTE_AUTHOR', 'Hanya penulis yang dapat mengubah draf catatan');
    const [row] = await this.db.update(clinicalNotes).set({ ...input, updatedAt: new Date() }).where(eq(clinicalNotes.id, noteId)).returning();
    return row;
  }

  /** Tanda tangan elektronik: catatan dikunci + hash isi. Visite dokter rawat inap menghasilkan charge. */
  async signNote(user: AuthUser, noteId: string) {
    const note = await this.getNote(user, noteId);
    if (note.status === 'SIGNED') throw conflict('NOTE_ALREADY_SIGNED', 'Catatan sudah ditandatangani');
    if (note.authorId !== user.id) throw forbidden('NOT_NOTE_AUTHOR', 'Hanya penulis yang dapat menandatangani catatan');
    const signedAt = new Date();
    const today = await this.facility.today(user.facilityId);
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(clinicalNotes)
        .set({ status: 'SIGNED', signedAt, signatureHash: this.hashNote(note, user.id, signedAt), updatedAt: signedAt })
        .where(eq(clinicalNotes.id, noteId))
        .returning();
      const [enc] = await tx.select().from(encounters).where(eq(encounters.id, note.encounterId));
      if (enc.type === 'RAWAT_INAP' && isDoctor(user) && ['SOAP', 'CPPT'].includes(note.type)) {
        const ctx = await this.chargesSvc.context(tx, user.facilityId, enc.id, user.id, today);
        await this.chargesSvc.addServiceByCode(tx, ctx, 'VISITE', { sourceType: 'VISIT', sourceId: note.id, description: `Visite ${user.name}` });
      }
      return row;
    });
  }

  /** Amandemen: catatan asli tetap utuh, koreksi disimpan sebagai catatan baru yang merujuk. */
  async amendNote(user: AuthUser, noteId: string, input: z.infer<typeof AmendSchema>, meta: RequestMeta) {
    const note = await this.getNote(user, noteId);
    if (note.status !== 'SIGNED') throw invalid('NOTE_NOT_SIGNED', 'Draf dapat diubah langsung, tidak perlu amandemen');
    const { reason, ...content } = input;
    const signedAt = new Date();
    const [row] = await this.db
      .insert(clinicalNotes)
      .values({
        ...content,
        type: 'AMENDMENT',
        facilityId: user.facilityId,
        encounterId: note.encounterId,
        patientId: note.patientId,
        authorId: user.id,
        authorName: user.name,
        authorRole: user.roles[0],
        amendsNoteId: note.id,
        status: 'SIGNED',
        signedAt,
        signatureHash: this.hashNote({ type: 'AMENDMENT', ...content }, user.id, signedAt),
        instruction: `${content.instruction ?? ''}\n[Alasan amandemen: ${reason}]`.trim(),
      })
      .returning();
    await this.audit.log(user, { action: 'AMEND', resourceType: 'ClinicalNote', resourceId: note.id, patientId: note.patientId, reason }, meta);
    return row;
  }

  private async getNote(user: AuthUser, id: string) {
    const [n] = await this.db.select().from(clinicalNotes).where(and(eq(clinicalNotes.id, id), eq(clinicalNotes.facilityId, user.facilityId)));
    if (!n) throw notFound('Catatan klinis', id);
    await this.access.assertCanAccessPatient(user, n.patientId);
    return n;
  }

  async addDiagnosis(user: AuthUser, encounterId: string, input: z.infer<typeof DiagnosisSchema>) {
    const e = await this.activeEncounter(user, encounterId);
    const [code] = await this.db.select().from(icd10).where(eq(icd10.code, input.icd10Code.toUpperCase()));
    if (!code) throw invalid('ICD10_NOT_FOUND', `Kode ICD-10 ${input.icd10Code} tidak ditemukan`);
    if (input.rank === 'PRIMER') {
      const existing = await this.db.select({ id: diagnoses.id }).from(diagnoses).where(and(eq(diagnoses.encounterId, encounterId), eq(diagnoses.rank, 'PRIMER')));
      if (existing.length) throw conflict('PRIMARY_DIAGNOSIS_EXISTS', 'Diagnosis utama sudah ada; hapus atau jadikan sekunder terlebih dahulu');
    }
    const [row] = await this.db
      .insert(diagnoses)
      .values({ ...input, icd10Code: code.code, display: code.displayId ?? code.display, facilityId: user.facilityId, encounterId, patientId: e.patientId, recordedBy: user.id })
      .returning();
    return row;
  }

  async removeDiagnosis(user: AuthUser, encounterId: string, diagnosisId: string) {
    await this.activeEncounter(user, encounterId);
    const [row] = await this.db
      .delete(diagnoses)
      .where(and(eq(diagnoses.id, diagnosisId), eq(diagnoses.encounterId, encounterId)))
      .returning();
    if (!row) throw notFound('Diagnosis', diagnosisId);
    return row;
  }

  async addProcedure(user: AuthUser, encounterId: string, input: z.infer<typeof ProcedureSchema>) {
    const e = await this.activeEncounter(user, encounterId);
    let display = input.display;
    if (input.icd9cmCode) {
      const [code] = await this.db.select().from(icd9cm).where(eq(icd9cm.code, input.icd9cmCode));
      if (!code) throw invalid('ICD9CM_NOT_FOUND', `Kode ICD-9-CM ${input.icd9cmCode} tidak ditemukan`);
      display = display ?? code.display;
    }
    if (!display) throw invalid('PROCEDURE_DISPLAY_REQUIRED', 'Nama tindakan wajib diisi');
    const today = await this.facility.today(user.facilityId);
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(procedures)
        .values({ facilityId: user.facilityId, encounterId, patientId: e.patientId, icd9cmCode: input.icd9cmCode ?? null, display, serviceId: input.serviceId ?? null, performedBy: user.id, notes: input.notes })
        .returning();
      if (input.serviceId) {
        const ctx = await this.chargesSvc.context(tx, user.facilityId, encounterId, user.id, today);
        await this.chargesSvc.addService(tx, ctx, input.serviceId, { sourceType: 'PROCEDURE', sourceId: row.id });
      }
      return row;
    });
  }

  /** Rangkuman RME satu kunjungan (untuk workspace dokter/perawat). */
  async encounterRecord(user: AuthUser, encounterId: string, meta: RequestMeta) {
    const e = await this.activeEncounter(user, encounterId, true);
    const [notes, vitals, dx, procs, ords, rxs] = await Promise.all([
      this.db.select().from(clinicalNotes).where(eq(clinicalNotes.encounterId, encounterId)).orderBy(desc(clinicalNotes.createdAt)),
      this.db.select().from(vitalSigns).where(eq(vitalSigns.encounterId, encounterId)).orderBy(desc(vitalSigns.createdAt)),
      this.db.select().from(diagnoses).where(eq(diagnoses.encounterId, encounterId)).orderBy(diagnoses.createdAt),
      this.db.select().from(procedures).where(eq(procedures.encounterId, encounterId)).orderBy(desc(procedures.performedAt)),
      this.db.select().from(orders).where(eq(orders.encounterId, encounterId)).orderBy(desc(orders.createdAt)),
      this.db.select().from(prescriptions).where(eq(prescriptions.encounterId, encounterId)).orderBy(desc(prescriptions.createdAt)),
    ]);
    const res = ords.length ? await this.db.select().from(results).where(inArray(results.orderId, ords.map((o) => o.id))) : [];
    const rxItems = rxs.length ? await this.db.select().from(prescriptionItems).where(inArray(prescriptionItems.prescriptionId, rxs.map((r) => r.id))) : [];
    const mar = await this.db.select().from(medicationAdministrations).where(eq(medicationAdministrations.encounterId, encounterId)).orderBy(desc(medicationAdministrations.administeredAt));
    await this.audit.log(user, { action: 'READ', resourceType: 'MedicalRecord', resourceId: encounterId, patientId: e.patientId }, meta);
    return {
      encounterId,
      patientId: e.patientId,
      notes,
      vitals,
      diagnoses: dx,
      procedures: procs,
      orders: ords.map((o) => ({ ...o, result: res.find((r) => r.orderId === o.id) ?? null })),
      prescriptions: rxs.map((r) => ({ ...r, items: rxItems.filter((i) => i.prescriptionId === r.id) })),
      medicationAdministrations: mar,
    };
  }

  /** Riwayat RME lintas kunjungan pasien (timeline). */
  async patientTimeline(user: AuthUser, patientId: string, meta: RequestMeta) {
    const basis = await this.access.assertCanAccessPatient(user, patientId);
    const encs = await this.db
      .select({ id: encounters.id, encounterNo: encounters.encounterNo, type: encounters.type, status: encounters.status, startAt: encounters.startAt, endAt: encounters.endAt, unitName: units.name })
      .from(encounters)
      .innerJoin(units, eq(units.id, encounters.unitId))
      .where(and(eq(encounters.patientId, patientId), eq(encounters.facilityId, user.facilityId)))
      .orderBy(desc(encounters.startAt));
    const ids = encs.map((e) => e.id);
    const dx = ids.length ? await this.db.select().from(diagnoses).where(inArray(diagnoses.encounterId, ids)) : [];
    const notes = ids.length
      ? await this.db
          .select({ id: clinicalNotes.id, encounterId: clinicalNotes.encounterId, type: clinicalNotes.type, assessment: clinicalNotes.assessment, plan: clinicalNotes.plan, authorName: clinicalNotes.authorName, createdAt: clinicalNotes.createdAt, status: clinicalNotes.status })
          .from(clinicalNotes)
          .where(and(inArray(clinicalNotes.encounterId, ids), eq(clinicalNotes.status, 'SIGNED')))
      : [];
    await this.audit.log(user, { action: 'READ', resourceType: 'MedicalRecordHistory', resourceId: patientId, patientId, reason: basis === 'BREAK_GLASS' ? 'BREAK_GLASS' : null }, meta);
    return encs.map((e) => ({ ...e, diagnoses: dx.filter((d) => d.encounterId === e.id), notes: notes.filter((n) => n.encounterId === e.id) }));
  }
}

@Controller('clinical')
@AuditResource('Clinical')
export class ClinicalController {
  constructor(private readonly svc: ClinicalService) {}

  @Get('encounters/:id/record')
  @Permissions('clinical.read')
  record(@CurrentUser() u: AuthUser, @Param('id') id: string, @ReqMeta() meta: RequestMeta) {
    return this.svc.encounterRecord(u, id, meta);
  }

  @Get('patients/:id/timeline')
  @Permissions('clinical.read')
  timeline(@CurrentUser() u: AuthUser, @Param('id') id: string, @ReqMeta() meta: RequestMeta) {
    return this.svc.patientTimeline(u, id, meta);
  }

  @Post('encounters/:id/vitals')
  @Permissions('clinical.write', 'triage.write')
  vitals(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body(new ZodPipe(VitalSchema)) body: z.infer<typeof VitalSchema>) {
    return this.svc.addVitals(u, id, body);
  }

  @Post('encounters/:id/notes')
  @Permissions('clinical.write')
  note(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body(new ZodPipe(NoteSchema)) body: z.infer<typeof NoteSchema>) {
    return this.svc.createNote(u, id, body);
  }

  @Patch('notes/:id')
  @Permissions('clinical.write')
  updateNote(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body(new ZodPipe(NoteUpdateSchema)) body: z.infer<typeof NoteUpdateSchema>) {
    return this.svc.updateNote(u, id, body);
  }

  @Post('notes/:id/sign')
  @Permissions('clinical.sign')
  sign(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.svc.signNote(u, id);
  }

  @Post('notes/:id/amend')
  @Permissions('clinical.sign')
  amend(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body(new ZodPipe(AmendSchema)) body: z.infer<typeof AmendSchema>, @ReqMeta() meta: RequestMeta) {
    return this.svc.amendNote(u, id, body, meta);
  }

  @Post('encounters/:id/diagnoses')
  @Permissions('clinical.write')
  diagnosis(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body(new ZodPipe(DiagnosisSchema)) body: z.infer<typeof DiagnosisSchema>) {
    return this.svc.addDiagnosis(u, id, body);
  }

  @Post('encounters/:id/diagnoses/:diagnosisId/remove')
  @Permissions('clinical.write')
  removeDiagnosis(@CurrentUser() u: AuthUser, @Param('id') id: string, @Param('diagnosisId') diagnosisId: string) {
    return this.svc.removeDiagnosis(u, id, diagnosisId);
  }

  @Post('encounters/:id/procedures')
  @Permissions('clinical.write')
  procedure(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body(new ZodPipe(ProcedureSchema)) body: z.infer<typeof ProcedureSchema>) {
    return this.svc.addProcedure(u, id, body);
  }
}

@Module({
  imports: [BillingModule, IntegrationModule],
  controllers: [ClinicalController],
  providers: [ClinicalService],
})
export class ClinicalModule {}
