import { Body, Controller, Get, Inject, Injectable, Module, Param, Post, Query } from '@nestjs/common';
import { and, desc, eq, gte, ilike, inArray, isNull, lt, ne, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { DB, type Db, type Tx } from '../../database/database.js';
import {
  appointments,
  bedAssignments,
  beds,
  charges,
  clinicalNotes,
  diagnoses,
  encounters,
  orders,
  patientAllergies,
  patients,
  payers,
  practitionerSchedules,
  practitioners,
  queueTickets,
  rooms,
  triages,
  units,
} from '../../database/schema.js';
import { AuditResource, CurrentUser, Permissions, ReqMeta, type AuthUser, type RequestMeta } from '../../common/auth.js';
import { conflict, invalid, notFound } from '../../common/errors.js';
import { ageInYears, careDays } from '../../common/util.js';
import { ZodPipe, zDate } from '../../common/zod.pipe.js';
import { AuditService } from '../../core/audit.service.js';
import { CareAccessService } from '../../core/care-access.service.js';
import { FacilityService } from '../../core/core.module.js';
import { SequenceService } from '../../core/sequence.service.js';
import { BillingModule } from '../billing/billing.module.js';
import { ChargeService } from '../billing/charge.service.js';
import { IntegrationModule, OutboxService } from '../integration/integration.module.js';
import { BpjsClient } from '../integration/bpjs.client.js';

/* --------------------------------- DTO --------------------------------- */

const AppointmentSchema = z.object({
  patientId: z.uuid(),
  practitionerId: z.uuid(),
  unitId: z.uuid(),
  payerId: z.uuid(),
  date: zDate,
  slotTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  source: z.enum(['ONSITE', 'ONLINE', 'MOBILE_JKN', 'TELEPON']).default('ONSITE'),
});

const EncounterSchema = z.object({
  patientId: z.uuid(),
  type: z.enum(['RAWAT_JALAN', 'IGD', 'RAWAT_INAP']),
  unitId: z.uuid(),
  practitionerId: z.uuid().optional(),
  payerId: z.uuid(),
  payerMemberNo: z.string().max(32).optional(),
  referralNo: z.string().max(32).optional(),
  chiefComplaint: z.string().max(1000).optional(),
  bedId: z.uuid().optional(),
  parentEncounterId: z.uuid().optional(),
  appointmentId: z.uuid().optional(),
  /** Diagnosis awal (ICD-10) untuk penerbitan SEP */
  initialDiagnosis: z.string().max(16).optional(),
});
type EncounterInput = z.infer<typeof EncounterSchema>;

const TriageSchema = z.object({
  level: z.number().int().min(1).max(5),
  complaint: z.string().optional(),
  notes: z.string().optional(),
});

const DischargeSchema = z.object({
  disposition: z.enum(['PULANG', 'KONTROL', 'RUJUK', 'RAWAT_INAP', 'MENINGGAL', 'APS']),
  acknowledgePendingOrders: z.boolean().optional(),
});

const EncounterListSchema = z.object({
  status: z.string().optional(),
  type: z.string().optional(),
  unitId: z.uuid().optional(),
  date: zDate.optional(),
  q: z.string().optional(),
  active: z.enum(['true', 'false']).optional(),
  mine: z.enum(['true', 'false']).optional(),
});

const TRIAGE_LABEL: Record<number, string> = { 1: 'MERAH — Resusitasi', 2: 'MERAH — Emergensi', 3: 'KUNING — Urgen', 4: 'HIJAU — Kurang urgen', 5: 'HIJAU — Tidak urgen' };

/* ------------------------------- Service ------------------------------- */

@Injectable()
export class RegistrationService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly seq: SequenceService,
    private readonly facility: FacilityService,
    private readonly chargesSvc: ChargeService,
    private readonly outbox: OutboxService,
    private readonly bpjs: BpjsClient,
    private readonly access: CareAccessService,
    private readonly audit: AuditService,
  ) {}

  /* ------------------------------ Appointment ------------------------------ */

  async createAppointment(user: AuthUser, input: z.infer<typeof AppointmentSchema>) {
    const today = await this.facility.today(user.facilityId);
    if (input.date < today) throw invalid('APPOINTMENT_IN_PAST', 'Tanggal janji temu tidak boleh di masa lalu');
    const dow = ((new Date(`${input.date}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
    const [schedule] = await this.db
      .select()
      .from(practitionerSchedules)
      .where(
        and(
          eq(practitionerSchedules.facilityId, user.facilityId),
          eq(practitionerSchedules.practitionerId, input.practitionerId),
          eq(practitionerSchedules.unitId, input.unitId),
          eq(practitionerSchedules.dayOfWeek, dow),
        ),
      );
    if (!schedule) throw invalid('NO_SCHEDULE', 'Dokter tidak praktik di poli ini pada hari tersebut');
    const [{ booked }] = await this.db
      .select({ booked: sql<number>`count(*)::int` })
      .from(appointments)
      .where(
        and(
          eq(appointments.practitionerId, input.practitionerId),
          eq(appointments.date, input.date),
          ne(appointments.status, 'CANCELLED'),
        ),
      );
    if (booked >= schedule.quota) throw conflict('QUOTA_FULL', `Kuota dokter pada ${input.date} sudah penuh (${schedule.quota})`);

    return this.db.transaction(async (tx) => {
      const bookingCode = await this.seq.document(tx, user.facilityId, 'BOOK', input.date);
      const [row] = await tx
        .insert(appointments)
        .values({ ...input, facilityId: user.facilityId, bookingCode, slotTime: input.slotTime ?? schedule.startTime })
        .returning();
      return { ...row, estimatedNumber: booked + 1 };
    });
  }

  async listAppointments(facilityId: string, date?: string, unitId?: string) {
    const conds: SQL[] = [eq(appointments.facilityId, facilityId)];
    if (date) conds.push(eq(appointments.date, date));
    if (unitId) conds.push(eq(appointments.unitId, unitId));
    return this.db
      .select({
        id: appointments.id,
        bookingCode: appointments.bookingCode,
        date: appointments.date,
        slotTime: appointments.slotTime,
        status: appointments.status,
        source: appointments.source,
        patientId: patients.id,
        patientName: patients.name,
        mrn: patients.mrn,
        practitionerName: practitioners.name,
        unitName: units.name,
        unitId: appointments.unitId,
        practitionerId: appointments.practitionerId,
        payerId: appointments.payerId,
        encounterId: appointments.encounterId,
      })
      .from(appointments)
      .innerJoin(patients, eq(patients.id, appointments.patientId))
      .innerJoin(practitioners, eq(practitioners.id, appointments.practitionerId))
      .innerJoin(units, eq(units.id, appointments.unitId))
      .where(and(...conds))
      .orderBy(appointments.date, appointments.slotTime);
  }

  async cancelAppointment(user: AuthUser, id: string) {
    const [row] = await this.db
      .update(appointments)
      .set({ status: 'CANCELLED' })
      .where(and(eq(appointments.id, id), eq(appointments.facilityId, user.facilityId), eq(appointments.status, 'BOOKED')))
      .returning();
    if (!row) throw conflict('APPOINTMENT_NOT_CANCELLABLE', 'Janji temu tidak dapat dibatalkan');
    return row;
  }

  async checkIn(user: AuthUser, id: string, meta: RequestMeta) {
    const [a] = await this.db.select().from(appointments).where(and(eq(appointments.id, id), eq(appointments.facilityId, user.facilityId)));
    if (!a) throw notFound('Janji temu', id);
    if (a.status !== 'BOOKED') throw conflict('APPOINTMENT_NOT_BOOKED', 'Janji temu sudah diproses atau dibatalkan');
    if (!a.payerId) throw invalid('PAYER_REQUIRED', 'Penjamin belum dipilih');
    return this.register(user, { patientId: a.patientId, type: 'RAWAT_JALAN', unitId: a.unitId, practitionerId: a.practitionerId, payerId: a.payerId, appointmentId: a.id }, meta);
  }

  /* -------------------------------- Encounter -------------------------------- */

  async register(user: AuthUser, input: EncounterInput, meta: RequestMeta) {
    const today = await this.facility.today(user.facilityId);
    const fac = await this.facility.get(user.facilityId);
    const [patient] = await this.db.select().from(patients).where(and(eq(patients.id, input.patientId), eq(patients.facilityId, user.facilityId)));
    if (!patient) throw notFound('Pasien', input.patientId);
    if (patient.status !== 'ACTIVE') throw invalid('PATIENT_NOT_ACTIVE', `Status pasien ${patient.status}${patient.mergedIntoId ? ' — gunakan rekam medis hasil penggabungan' : ''}`);

    const [unit] = await this.db.select().from(units).where(and(eq(units.id, input.unitId), eq(units.facilityId, user.facilityId)));
    if (!unit) throw notFound('Unit', input.unitId);
    const expectedUnit = { RAWAT_JALAN: ['POLI'], IGD: ['IGD'], RAWAT_INAP: ['RAWAT_INAP', 'ICU'] }[input.type];
    if (!expectedUnit.includes(unit.type)) throw invalid('UNIT_TYPE_MISMATCH', `Unit ${unit.name} bukan unit ${input.type.replace('_', ' ').toLowerCase()}`);

    const [payer] = await this.db.select().from(payers).where(and(eq(payers.id, input.payerId), eq(payers.facilityId, user.facilityId)));
    if (!payer) throw notFound('Penjamin', input.payerId);

    let practitioner: typeof practitioners.$inferSelect | undefined;
    if (input.practitionerId) {
      [practitioner] = await this.db.select().from(practitioners).where(and(eq(practitioners.id, input.practitionerId), eq(practitioners.facilityId, user.facilityId)));
      if (!practitioner) throw notFound('Dokter', input.practitionerId);
      if (practitioner.sipExpiry && practitioner.sipExpiry < today) throw invalid('PRACTITIONER_SIP_EXPIRED', `SIP ${practitioner.name} sudah kedaluwarsa`);
    } else if (input.type !== 'IGD') {
      throw invalid('PRACTITIONER_REQUIRED', 'DPJP wajib dipilih untuk rawat jalan/rawat inap');
    }

    // Satu kunjungan aktif per pasien per unit (RJ/IGD) atau satu rawat inap aktif
    const active = await this.db
      .select({ id: encounters.id, encounterNo: encounters.encounterNo })
      .from(encounters)
      .where(
        and(
          eq(encounters.patientId, patient.id),
          inArray(encounters.status, ['REGISTERED', 'TRIAGED', 'IN_PROGRESS']),
          input.type === 'RAWAT_INAP' ? eq(encounters.type, 'RAWAT_INAP') : eq(encounters.unitId, unit.id),
        ),
      );
    if (active.length) throw conflict('ACTIVE_ENCOUNTER_EXISTS', `Pasien masih memiliki kunjungan aktif ${active[0].encounterNo}`);

    // Rawat inap: bed wajib, harus tersedia
    let bed: { id: string; careClass: string; unitId: string } | undefined;
    if (input.type === 'RAWAT_INAP') {
      if (!input.bedId) throw invalid('BED_REQUIRED', 'Bed wajib dipilih untuk rawat inap');
      [bed] = await this.db
        .select({ id: beds.id, careClass: rooms.careClass, unitId: rooms.unitId, status: beds.status })
        .from(beds)
        .innerJoin(rooms, eq(rooms.id, beds.roomId))
        .where(and(eq(beds.id, input.bedId), eq(beds.facilityId, user.facilityId), eq(beds.status, 'AVAILABLE')));
      if (!bed) throw conflict('BED_NOT_AVAILABLE', 'Bed tidak tersedia');
      if (bed.unitId !== unit.id) throw invalid('BED_UNIT_MISMATCH', 'Bed bukan milik bangsal yang dipilih');
    }

    // Penjamin JKN: cek eligibilitas peserta lalu terbitkan SEP
    const warnings: string[] = [];
    let sepNumber: string | null = null;
    const memberNo = input.payerMemberNo ?? (payer.type === 'BPJS' ? patient.bpjsNumber : null) ?? null;
    if (payer.type === 'BPJS') {
      if (!memberNo) throw invalid('BPJS_NUMBER_REQUIRED', 'Nomor kartu JKN wajib diisi untuk penjamin BPJS');
      try {
        const peserta = await this.bpjs.peserta(memberNo, today);
        if (!peserta.aktif) throw invalid('BPJS_NOT_ACTIVE', `Kepesertaan JKN tidak aktif: ${peserta.statusPeserta}`);
        if (bed && peserta.hakKelas !== bed.careClass && bed.careClass !== 'KRIS') {
          warnings.push(`Kelas bed (${bed.careClass}) berbeda dengan hak kelas peserta (${peserta.hakKelas}) — pastikan persetujuan naik kelas`);
        }
        sepNumber = await this.bpjs.createSep({
          noKartu: memberNo,
          tglSep: today,
          ppkPelayanan: fac.bpjsPpkCode ?? '00000000',
          jnsPelayanan: input.type === 'RAWAT_INAP' ? '1' : '2',
          klsRawatHak: peserta.hakKelas,
          noMR: patient.mrn,
          noRujukan: input.referralNo,
          diagAwal: input.initialDiagnosis ?? 'Z00.0',
          poliTujuan: unit.bpjsPoliCode ?? undefined,
          dpjpLayan: practitioner?.bpjsDpjpCode ?? undefined,
          noTelp: patient.phone ?? undefined,
          user: user.username,
        });
      } catch (e) {
        if ((e as { code?: string }).code === 'BPJS_NOT_ACTIVE') throw e;
        // Layanan BPJS tidak tersedia: pelayanan tetap jalan, SEP diterbitkan ulang kemudian
        warnings.push(`SEP belum terbit (${(e as Error).message}). Terbitkan ulang melalui menu SEP.`);
      }
    }

    const result = await this.db.transaction(async (tx) => {
      const prefix = input.type === 'RAWAT_JALAN' ? 'RJ' : input.type === 'IGD' ? 'IGD' : 'RI';
      const encounterNo = await this.seq.document(tx, user.facilityId, prefix, today);
      const [enc] = await tx
        .insert(encounters)
        .values({
          facilityId: user.facilityId,
          encounterNo,
          patientId: patient.id,
          type: input.type,
          unitId: unit.id,
          practitionerId: practitioner?.id ?? null,
          payerId: payer.id,
          payerMemberNo: memberNo,
          sepNumber,
          referralNo: input.referralNo ?? null,
          careClass: bed?.careClass ?? null,
          bedId: bed?.id ?? null,
          chiefComplaint: input.chiefComplaint ?? null,
          parentEncounterId: input.parentEncounterId ?? null,
          appointmentId: input.appointmentId ?? null,
          createdBy: user.id,
        })
        .returning();

      if (bed) {
        await tx.update(beds).set({ status: 'OCCUPIED', currentEncounterId: enc.id }).where(eq(beds.id, bed.id));
        await tx.insert(bedAssignments).values({ facilityId: user.facilityId, encounterId: enc.id, bedId: bed.id, careClass: bed.careClass });
      }

      let queue: typeof queueTickets.$inferSelect | null = null;
      if (input.type === 'RAWAT_JALAN') queue = await this.issueTicket(tx, user.facilityId, unit, today, patient.id, enc.id);
      if (input.appointmentId) {
        await tx.update(appointments).set({ status: 'CHECKED_IN', encounterId: enc.id }).where(eq(appointments.id, input.appointmentId));
      }

      // Charge capture otomatis: administrasi + jasa pemeriksaan
      const ctx = { encounter: enc, payer, userId: user.id, onDate: today };
      await this.chargesSvc.addServiceByCode(tx, ctx, `ADM-${prefix}`, { sourceType: 'ADMIN', sourceId: enc.id });
      if (input.type === 'RAWAT_JALAN') {
        const code = practitioner?.profession === 'DOKTER_SPESIALIS' ? 'KONSUL-SPESIALIS' : 'KONSUL-UMUM';
        await this.chargesSvc.addServiceByCode(tx, ctx, code, { sourceType: 'CONSULT', sourceId: enc.id, description: `Konsultasi ${practitioner?.name ?? ''}`.trim() });
      } else if (input.type === 'IGD') {
        await this.chargesSvc.addServiceByCode(tx, ctx, 'IGD-PERIKSA', { sourceType: 'CONSULT', sourceId: enc.id });
      }

      await this.outbox.enqueue(tx, { facilityId: user.facilityId, target: 'SATUSEHAT', resourceType: 'Encounter', resourceId: enc.id, operation: 'CREATE' });
      return { ...enc, queue };
    });
    await this.audit.log(user, { action: 'REGISTER', resourceType: 'Encounter', resourceId: result.id, patientId: patient.id }, meta);
    return { ...result, warnings };
  }

  private async issueTicket(tx: Tx, facilityId: string, unit: typeof units.$inferSelect, date: string, patientId: string | null, encounterId: string | null) {
    const [{ next }] = await tx
      .select({ next: sql<number>`coalesce(max(${queueTickets.number}), 0)::int + 1` })
      .from(queueTickets)
      .where(and(eq(queueTickets.unitId, unit.id), eq(queueTickets.date, date)));
    const [ticket] = await tx
      .insert(queueTickets)
      .values({ facilityId, unitId: unit.id, date, number: next, label: `${unit.queuePrefix ?? unit.code.slice(0, 1)}-${String(next).padStart(3, '0')}`, patientId, encounterId })
      .returning();
    return ticket;
  }

  async retrySep(user: AuthUser, encounterId: string) {
    const [row] = await this.db
      .select({ e: encounters, p: patients, u: units, pr: practitioners, payer: payers })
      .from(encounters)
      .innerJoin(patients, eq(patients.id, encounters.patientId))
      .innerJoin(units, eq(units.id, encounters.unitId))
      .innerJoin(payers, eq(payers.id, encounters.payerId))
      .leftJoin(practitioners, eq(practitioners.id, encounters.practitionerId))
      .where(and(eq(encounters.id, encounterId), eq(encounters.facilityId, user.facilityId)));
    if (!row) throw notFound('Kunjungan', encounterId);
    if (row.payer.type !== 'BPJS') throw invalid('NOT_BPJS', 'Penjamin kunjungan bukan BPJS');
    if (row.e.sepNumber) return { id: encounterId, sepNumber: row.e.sepNumber };
    const fac = await this.facility.get(user.facilityId);
    const today = await this.facility.today(user.facilityId);
    const peserta = await this.bpjs.peserta(row.e.payerMemberNo!, today);
    const sepNumber = await this.bpjs.createSep({
      noKartu: row.e.payerMemberNo!,
      tglSep: row.e.startAt.toISOString().slice(0, 10),
      ppkPelayanan: fac.bpjsPpkCode ?? '00000000',
      jnsPelayanan: row.e.type === 'RAWAT_INAP' ? '1' : '2',
      klsRawatHak: peserta.hakKelas,
      noMR: row.p.mrn,
      diagAwal: 'Z00.0',
      poliTujuan: row.u.bpjsPoliCode ?? undefined,
      dpjpLayan: row.pr?.bpjsDpjpCode ?? undefined,
      user: user.username,
    });
    await this.db.update(encounters).set({ sepNumber }).where(eq(encounters.id, encounterId));
    return { id: encounterId, sepNumber, patientId: row.e.patientId };
  }

  async list(user: AuthUser, q: z.infer<typeof EncounterListSchema>) {
    const conds: SQL[] = [eq(encounters.facilityId, user.facilityId)];
    if (q.status) conds.push(inArray(encounters.status, q.status.split(',')));
    if (q.type) conds.push(eq(encounters.type, q.type));
    if (q.unitId) conds.push(eq(encounters.unitId, q.unitId));
    if (q.active === 'true') conds.push(inArray(encounters.status, ['REGISTERED', 'TRIAGED', 'IN_PROGRESS']));
    if (q.mine === 'true' && user.practitionerId) conds.push(eq(encounters.practitionerId, user.practitionerId));
    if (q.date) {
      const tz = (await this.facility.get(user.facilityId)).timezone;
      conds.push(gte(encounters.startAt, sql`(${q.date}::date)::timestamp AT TIME ZONE ${tz}`));
      conds.push(lt(encounters.startAt, sql`(${q.date}::date + 1)::timestamp AT TIME ZONE ${tz}`));
    }
    if (q.q) conds.push(or(ilike(patients.name, `%${q.q}%`), eq(patients.mrn, q.q.padStart(8, '0')), ilike(encounters.encounterNo, `%${q.q}%`))!);
    return this.db
      .select({
        id: encounters.id,
        encounterNo: encounters.encounterNo,
        type: encounters.type,
        status: encounters.status,
        triageLevel: encounters.triageLevel,
        startAt: encounters.startAt,
        endAt: encounters.endAt,
        sepNumber: encounters.sepNumber,
        chiefComplaint: encounters.chiefComplaint,
        patientId: patients.id,
        patientName: patients.name,
        mrn: patients.mrn,
        gender: patients.gender,
        birthDate: patients.birthDate,
        unitName: units.name,
        practitionerName: practitioners.name,
        payerName: payers.name,
        payerType: payers.type,
        queueLabel: queueTickets.label,
        queueStatus: queueTickets.status,
      })
      .from(encounters)
      .innerJoin(patients, eq(patients.id, encounters.patientId))
      .innerJoin(units, eq(units.id, encounters.unitId))
      .innerJoin(payers, eq(payers.id, encounters.payerId))
      .leftJoin(practitioners, eq(practitioners.id, encounters.practitionerId))
      .leftJoin(queueTickets, eq(queueTickets.encounterId, encounters.id))
      .where(and(...conds))
      .orderBy(sql`${encounters.triageLevel} nulls last`, desc(encounters.startAt))
      .limit(300);
  }

  /** Detail kunjungan + data patient banner (2 identitas, alergi, penjamin). */
  async detail(user: AuthUser, id: string, meta: RequestMeta) {
    const [row] = await this.db
      .select({ encounter: encounters, patient: patients, unit: units, practitioner: practitioners, payer: payers })
      .from(encounters)
      .innerJoin(patients, eq(patients.id, encounters.patientId))
      .innerJoin(units, eq(units.id, encounters.unitId))
      .innerJoin(payers, eq(payers.id, encounters.payerId))
      .leftJoin(practitioners, eq(practitioners.id, encounters.practitionerId))
      .where(and(eq(encounters.id, id), eq(encounters.facilityId, user.facilityId)));
    if (!row) throw notFound('Kunjungan', id);
    const accessBasis = await this.access.assertCanAccessPatient(user, row.patient.id);
    const allergies = await this.db
      .select()
      .from(patientAllergies)
      .where(and(eq(patientAllergies.patientId, row.patient.id), eq(patientAllergies.active, true)));
    let bed = null;
    if (row.encounter.bedId) {
      [bed] = await this.db
        .select({ id: beds.id, code: beds.code, roomName: rooms.name, careClass: rooms.careClass })
        .from(beds)
        .innerJoin(rooms, eq(rooms.id, beds.roomId))
        .where(eq(beds.id, row.encounter.bedId));
    }
    const triageHistory = await this.db.select().from(triages).where(eq(triages.encounterId, id)).orderBy(desc(triages.createdAt));
    await this.audit.log(user, { action: 'READ', resourceType: 'Encounter', resourceId: id, patientId: row.patient.id, reason: accessBasis === 'BREAK_GLASS' ? 'BREAK_GLASS' : null }, meta);
    const { nikEncrypted: _n, nikHash: _h, ...patient } = row.patient;
    return {
      ...row.encounter,
      patient: { ...patient, age: ageInYears(patient.birthDate), nikMasked: patient.nikLast4 ? `************${patient.nikLast4}` : null },
      unit: row.unit,
      practitioner: row.practitioner,
      payer: row.payer,
      bed,
      allergies,
      triageHistory,
      triageLabel: row.encounter.triageLevel ? TRIAGE_LABEL[row.encounter.triageLevel] : null,
      accessBasis,
    };
  }

  async triage(user: AuthUser, id: string, input: z.infer<typeof TriageSchema>) {
    const enc = await this.getEncounter(user.facilityId, id);
    if (!['REGISTERED', 'TRIAGED', 'IN_PROGRESS'].includes(enc.status)) throw conflict('ENCOUNTER_CLOSED', 'Kunjungan sudah selesai');
    return this.db.transaction(async (tx) => {
      const [t] = await tx.insert(triages).values({ ...input, facilityId: user.facilityId, encounterId: id, triagedBy: user.id }).returning();
      await tx
        .update(encounters)
        .set({ triageLevel: input.level, status: enc.status === 'REGISTERED' ? 'TRIAGED' : enc.status, chiefComplaint: input.complaint ?? enc.chiefComplaint })
        .where(eq(encounters.id, id));
      return { ...t, label: TRIAGE_LABEL[input.level], patientId: enc.patientId };
    });
  }

  async start(user: AuthUser, id: string) {
    const enc = await this.getEncounter(user.facilityId, id);
    if (!['REGISTERED', 'TRIAGED'].includes(enc.status)) throw conflict('ENCOUNTER_NOT_STARTABLE', `Status kunjungan ${enc.status}`);
    await this.db.update(encounters).set({ status: 'IN_PROGRESS' }).where(eq(encounters.id, id));
    await this.db
      .update(queueTickets)
      .set({ status: 'SERVING', servedAt: new Date() })
      .where(and(eq(queueTickets.encounterId, id), inArray(queueTickets.status, ['WAITING', 'CALLED'])));
    return { id, status: 'IN_PROGRESS', patientId: enc.patientId };
  }

  /** Pindah bed (transfer ruangan / naik-turun kelas). Hari rawat dihitung per segmen bed. */
  async transferBed(user: AuthUser, id: string, bedId: string) {
    const enc = await this.getEncounter(user.facilityId, id);
    if (enc.type !== 'RAWAT_INAP' || enc.status === 'FINISHED' || enc.status === 'CANCELLED') throw invalid('NOT_ACTIVE_INPATIENT', 'Hanya untuk rawat inap aktif');
    return this.db.transaction(async (tx) => {
      const [target] = await tx
        .select({ id: beds.id, careClass: rooms.careClass, unitId: rooms.unitId })
        .from(beds)
        .innerJoin(rooms, eq(rooms.id, beds.roomId))
        .where(and(eq(beds.id, bedId), eq(beds.facilityId, user.facilityId), eq(beds.status, 'AVAILABLE')))
        .for('update');
      if (!target) throw conflict('BED_NOT_AVAILABLE', 'Bed tujuan tidak tersedia');
      const now = new Date();
      await tx.update(bedAssignments).set({ endAt: now }).where(and(eq(bedAssignments.encounterId, id), isNull(bedAssignments.endAt)));
      if (enc.bedId) await tx.update(beds).set({ status: 'CLEANING', currentEncounterId: null }).where(eq(beds.id, enc.bedId));
      await tx.update(beds).set({ status: 'OCCUPIED', currentEncounterId: id }).where(eq(beds.id, bedId));
      await tx.insert(bedAssignments).values({ facilityId: user.facilityId, encounterId: id, bedId, careClass: target.careClass, startAt: now });
      await tx.update(encounters).set({ bedId, careClass: target.careClass, unitId: target.unitId }).where(eq(encounters.id, id));
      return { id, bedId, careClass: target.careClass, patientId: enc.patientId };
    });
  }

  async setBedStatus(user: AuthUser, bedId: string, status: 'AVAILABLE' | 'CLEANING' | 'MAINTENANCE') {
    const [row] = await this.db
      .update(beds)
      .set({ status })
      .where(and(eq(beds.id, bedId), eq(beds.facilityId, user.facilityId), isNull(beds.currentEncounterId)))
      .returning();
    if (!row) throw conflict('BED_OCCUPIED', 'Bed sedang terisi pasien');
    return row;
  }

  /**
   * Pemulangan / selesai pelayanan. Validasi kelengkapan RME:
   * diagnosis utama wajib; rawat inap wajib resume medis yang sudah ditandatangani.
   */
  async discharge(user: AuthUser, id: string, input: z.infer<typeof DischargeSchema>, meta: RequestMeta) {
    const enc = await this.getEncounter(user.facilityId, id);
    if (!['REGISTERED', 'TRIAGED', 'IN_PROGRESS'].includes(enc.status)) throw conflict('ENCOUNTER_CLOSED', 'Kunjungan sudah selesai/dibatalkan');

    const primary = await this.db
      .select({ id: diagnoses.id })
      .from(diagnoses)
      .where(and(eq(diagnoses.encounterId, id), eq(diagnoses.rank, 'PRIMER')));
    if (!primary.length) throw invalid('PRIMARY_DIAGNOSIS_REQUIRED', 'Diagnosis utama (ICD-10) wajib diisi sebelum pasien pulang');

    if (enc.type === 'RAWAT_INAP') {
      const resume = await this.db
        .select({ id: clinicalNotes.id })
        .from(clinicalNotes)
        .where(and(eq(clinicalNotes.encounterId, id), eq(clinicalNotes.type, 'RESUME_MEDIS'), eq(clinicalNotes.status, 'SIGNED')));
      if (!resume.length) throw invalid('DISCHARGE_SUMMARY_REQUIRED', 'Resume medis (ringkasan pulang) wajib ditandatangani DPJP');
    }

    const pending = await this.db
      .select({ orderNo: orders.orderNo, serviceName: orders.serviceName, priority: orders.priority })
      .from(orders)
      .where(and(eq(orders.encounterId, id), inArray(orders.status, ['ORDERED', 'IN_PROGRESS'])));
    if (pending.length && !input.acknowledgePendingOrders) {
      throw invalid('PENDING_ORDERS', 'Masih ada order penunjang yang belum selesai', { orders: pending });
    }

    const today = await this.facility.today(user.facilityId);
    await this.db.transaction(async (tx) => {
      const now = new Date();
      if (enc.type === 'RAWAT_INAP') {
        await tx.update(bedAssignments).set({ endAt: now }).where(and(eq(bedAssignments.encounterId, id), isNull(bedAssignments.endAt)));
        if (enc.bedId) await tx.update(beds).set({ status: 'CLEANING', currentEncounterId: null }).where(eq(beds.id, enc.bedId));
        // Charge akomodasi per segmen bed (hari rawat)
        const ctx = await this.chargesSvc.context(tx, user.facilityId, id, user.id, today);
        const segments = await tx.select().from(bedAssignments).where(eq(bedAssignments.encounterId, id)).orderBy(bedAssignments.startAt);
        for (const s of segments) {
          const days = careDays(s.startAt.toISOString(), (s.endAt ?? now).toISOString());
          await this.chargesSvc.addServiceByCode(tx, ctx, 'AKOMODASI', {
            quantity: days,
            sourceType: 'BED',
            sourceId: s.id,
            careClass: s.careClass,
            description: `Akomodasi ${s.careClass.replace('_', ' ')} (${days} hari)`,
          });
        }
      }
      await tx.update(encounters).set({ status: 'FINISHED', endAt: now, dischargeDisposition: input.disposition }).where(eq(encounters.id, id));
      await tx.update(queueTickets).set({ status: 'DONE', doneAt: now }).where(eq(queueTickets.encounterId, id));
      if (input.disposition === 'MENINGGAL') await tx.update(patients).set({ status: 'DECEASED', updatedAt: now }).where(eq(patients.id, enc.patientId));
      await this.outbox.enqueue(tx, { facilityId: user.facilityId, target: 'SATUSEHAT', resourceType: 'Encounter', resourceId: id, operation: 'FINISH' });
    });
    await this.audit.log(user, { action: 'DISCHARGE', resourceType: 'Encounter', resourceId: id, patientId: enc.patientId, metadata: { disposition: input.disposition } }, meta);
    return { id, status: 'FINISHED', disposition: input.disposition, patientId: enc.patientId };
  }

  async cancel(user: AuthUser, id: string, reason: string) {
    const enc = await this.getEncounter(user.facilityId, id);
    if (!['REGISTERED', 'TRIAGED'].includes(enc.status)) throw conflict('ENCOUNTER_NOT_CANCELLABLE', 'Kunjungan yang sudah dilayani tidak dapat dibatalkan');
    const invoiced = await this.db.select({ id: charges.id }).from(charges).where(and(eq(charges.encounterId, id), eq(charges.status, 'INVOICED')));
    if (invoiced.length) throw conflict('ENCOUNTER_HAS_INVOICE', 'Kunjungan sudah memiliki invoice');
    await this.db.transaction(async (tx) => {
      await tx.update(charges).set({ status: 'VOID', voidReason: `Pembatalan kunjungan: ${reason}` }).where(and(eq(charges.encounterId, id), eq(charges.status, 'ACTIVE')));
      await tx.update(encounters).set({ status: 'CANCELLED', endAt: new Date() }).where(eq(encounters.id, id));
      await tx.update(queueTickets).set({ status: 'SKIPPED' }).where(eq(queueTickets.encounterId, id));
      if (enc.bedId) {
        await tx.update(beds).set({ status: 'AVAILABLE', currentEncounterId: null }).where(eq(beds.id, enc.bedId));
        await tx.update(bedAssignments).set({ endAt: new Date() }).where(and(eq(bedAssignments.encounterId, id), isNull(bedAssignments.endAt)));
      }
    });
    return { id, status: 'CANCELLED', patientId: enc.patientId };
  }

  /* --------------------------------- Antrean --------------------------------- */

  async queue(facilityId: string, unitId: string | undefined, date?: string) {
    const day = date ?? (await this.facility.today(facilityId));
    const conds: SQL[] = [eq(queueTickets.facilityId, facilityId), eq(queueTickets.date, day)];
    if (unitId) conds.push(eq(queueTickets.unitId, unitId));
    return this.db
      .select({
        id: queueTickets.id,
        label: queueTickets.label,
        number: queueTickets.number,
        status: queueTickets.status,
        counter: queueTickets.counter,
        createdAt: queueTickets.createdAt,
        calledAt: queueTickets.calledAt,
        unitId: queueTickets.unitId,
        unitName: units.name,
        encounterId: queueTickets.encounterId,
        patientName: patients.name,
        mrn: patients.mrn,
      })
      .from(queueTickets)
      .innerJoin(units, eq(units.id, queueTickets.unitId))
      .leftJoin(patients, eq(patients.id, queueTickets.patientId))
      .where(and(...conds))
      .orderBy(queueTickets.number);
  }

  async callNext(user: AuthUser, unitId: string, counter: string) {
    const today = await this.facility.today(user.facilityId);
    return this.db.transaction(async (tx) => {
      const [next] = await tx
        .select()
        .from(queueTickets)
        .where(and(eq(queueTickets.unitId, unitId), eq(queueTickets.date, today), eq(queueTickets.status, 'WAITING'), eq(queueTickets.facilityId, user.facilityId)))
        .orderBy(queueTickets.number)
        .limit(1)
        .for('update', { skipLocked: true });
      if (!next) throw notFound('Antrean menunggu');
      const [row] = await tx.update(queueTickets).set({ status: 'CALLED', calledAt: new Date(), counter }).where(eq(queueTickets.id, next.id)).returning();
      return row;
    });
  }

  async setQueueStatus(user: AuthUser, id: string, status: 'CALLED' | 'SKIPPED' | 'DONE' | 'WAITING') {
    const patch: Partial<typeof queueTickets.$inferInsert> = { status };
    if (status === 'CALLED') patch.calledAt = new Date();
    if (status === 'DONE') patch.doneAt = new Date();
    const [row] = await this.db
      .update(queueTickets)
      .set(patch)
      .where(and(eq(queueTickets.id, id), eq(queueTickets.facilityId, user.facilityId)))
      .returning();
    if (!row) throw notFound('Tiket antrean', id);
    return row;
  }

  /** Tiket antrean walk-in tanpa registrasi (mis. kiosk) */
  async kioskTicket(user: AuthUser, unitId: string) {
    const [unit] = await this.db.select().from(units).where(and(eq(units.id, unitId), eq(units.facilityId, user.facilityId)));
    if (!unit) throw notFound('Unit', unitId);
    const today = await this.facility.today(user.facilityId);
    return this.db.transaction((tx) => this.issueTicket(tx, user.facilityId, unit, today, null, null));
  }

  private async getEncounter(facilityId: string, id: string) {
    const [e] = await this.db.select().from(encounters).where(and(eq(encounters.id, id), eq(encounters.facilityId, facilityId)));
    if (!e) throw notFound('Kunjungan', id);
    return e;
  }
}

/* ------------------------------ Controllers ------------------------------ */

@Controller('appointments')
@AuditResource('Appointment')
export class AppointmentsController {
  constructor(private readonly svc: RegistrationService) {}

  @Get()
  @Permissions('encounter.read', 'appointment.write')
  list(@CurrentUser() u: AuthUser, @Query('date') date?: string, @Query('unitId') unitId?: string) {
    return this.svc.listAppointments(u.facilityId, date, unitId);
  }

  @Post()
  @Permissions('appointment.write')
  create(@CurrentUser() u: AuthUser, @Body(new ZodPipe(AppointmentSchema)) body: z.infer<typeof AppointmentSchema>) {
    return this.svc.createAppointment(u, body);
  }

  @Post(':id/cancel')
  @Permissions('appointment.write')
  cancel(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.svc.cancelAppointment(u, id);
  }

  @Post(':id/check-in')
  @Permissions('encounter.write')
  checkIn(@CurrentUser() u: AuthUser, @Param('id') id: string, @ReqMeta() meta: RequestMeta) {
    return this.svc.checkIn(u, id, meta);
  }
}

@Controller('encounters')
@AuditResource('Encounter')
export class EncountersController {
  constructor(private readonly svc: RegistrationService) {}

  @Get()
  @Permissions('encounter.read')
  list(@CurrentUser() u: AuthUser, @Query(new ZodPipe(EncounterListSchema)) q: z.infer<typeof EncounterListSchema>) {
    return this.svc.list(u, q);
  }

  @Post()
  @Permissions('encounter.write')
  register(@CurrentUser() u: AuthUser, @Body(new ZodPipe(EncounterSchema)) body: EncounterInput, @ReqMeta() meta: RequestMeta) {
    return this.svc.register(u, body, meta);
  }

  @Get(':id')
  @Permissions('encounter.read')
  detail(@CurrentUser() u: AuthUser, @Param('id') id: string, @ReqMeta() meta: RequestMeta) {
    return this.svc.detail(u, id, meta);
  }

  @Post(':id/triage')
  @Permissions('triage.write')
  triage(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body(new ZodPipe(TriageSchema)) body: z.infer<typeof TriageSchema>) {
    return this.svc.triage(u, id, body);
  }

  @Post(':id/start')
  @Permissions('clinical.write')
  start(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.svc.start(u, id);
  }

  @Post(':id/transfer-bed')
  @Permissions('bed.manage')
  transfer(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body(new ZodPipe(z.object({ bedId: z.uuid() }))) body: { bedId: string }) {
    return this.svc.transferBed(u, id, body.bedId);
  }

  @Post(':id/sep')
  @Permissions('encounter.write')
  sep(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.svc.retrySep(u, id);
  }

  @Post(':id/discharge')
  @Permissions('clinical.sign')
  discharge(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body(new ZodPipe(DischargeSchema)) body: z.infer<typeof DischargeSchema>, @ReqMeta() meta: RequestMeta) {
    return this.svc.discharge(u, id, body, meta);
  }

  @Post(':id/cancel')
  @Permissions('encounter.write')
  cancel(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body(new ZodPipe(z.object({ reason: z.string().min(5) }))) body: { reason: string }) {
    return this.svc.cancel(u, id, body.reason);
  }
}

@Controller('queue')
@AuditResource('Queue')
export class QueueController {
  constructor(private readonly svc: RegistrationService) {}

  @Get()
  list(@CurrentUser() u: AuthUser, @Query('unitId') unitId?: string, @Query('date') date?: string) {
    return this.svc.queue(u.facilityId, unitId, date);
  }

  @Post('call-next')
  @Permissions('queue.manage', 'clinical.write')
  callNext(@CurrentUser() u: AuthUser, @Body(new ZodPipe(z.object({ unitId: z.uuid(), counter: z.string().min(1).max(32) }))) body: { unitId: string; counter: string }) {
    return this.svc.callNext(u, body.unitId, body.counter);
  }

  @Post('kiosk')
  @Permissions('queue.manage')
  kiosk(@CurrentUser() u: AuthUser, @Body(new ZodPipe(z.object({ unitId: z.uuid() }))) body: { unitId: string }) {
    return this.svc.kioskTicket(u, body.unitId);
  }

  @Post(':id/status')
  @Permissions('queue.manage', 'clinical.write')
  status(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body(new ZodPipe(z.object({ status: z.enum(['CALLED', 'SKIPPED', 'DONE', 'WAITING']) }))) body: { status: 'CALLED' | 'SKIPPED' | 'DONE' | 'WAITING' }) {
    return this.svc.setQueueStatus(u, id, body.status);
  }
}

@Controller('beds')
@AuditResource('Bed')
export class BedsController {
  constructor(private readonly svc: RegistrationService) {}

  @Post(':id/status')
  @Permissions('bed.manage')
  status(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body(new ZodPipe(z.object({ status: z.enum(['AVAILABLE', 'CLEANING', 'MAINTENANCE']) }))) body: { status: 'AVAILABLE' | 'CLEANING' | 'MAINTENANCE' }) {
    return this.svc.setBedStatus(u, id, body.status);
  }
}

@Module({
  imports: [BillingModule, IntegrationModule],
  controllers: [AppointmentsController, EncountersController, QueueController, BedsController],
  providers: [RegistrationService],
})
export class RegistrationModule {}
