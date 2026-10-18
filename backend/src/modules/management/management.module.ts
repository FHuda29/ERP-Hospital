import { Body, Controller, Get, Inject, Injectable, Module, Param, Post, Query } from '@nestjs/common';
import { and, desc, eq, gte, inArray, lt, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { DB, type Db } from '../../database/database.js';
import { bedAssignments, beds, diagnoses, encounters, incidents, journalEntries, journalLines, queueTickets, units } from '../../database/schema.js';
import { AuditResource, CurrentUser, Permissions, type AuthUser } from '../../common/auth.js';
import { notFound } from '../../common/errors.js';
import { round2 } from '../../common/util.js';
import { ZodPipe, zDate } from '../../common/zod.pipe.js';
import { AuditService } from '../../core/audit.service.js';
import { FacilityService } from '../../core/core.module.js';
import { SequenceService } from '../../core/sequence.service.js';

const PeriodSchema = z.object({ from: zDate.optional(), to: zDate.optional() });

const IncidentSchema = z.object({
  type: z.enum(['KTD', 'KNC', 'KTC', 'KPC', 'SENTINEL']),
  riskGrade: z.enum(['BIRU', 'HIJAU', 'KUNING', 'MERAH']).optional(),
  patientId: z.uuid().optional(),
  unitId: z.uuid().optional(),
  occurredAt: z.iso.datetime({ offset: true }),
  description: z.string().min(10),
  immediateAction: z.string().optional(),
});

@Injectable()
export class DashboardService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly facility: FacilityService,
  ) {}

  private async range(facilityId: string, from?: string, to?: string) {
    const today = await this.facility.today(facilityId);
    const tz = (await this.facility.get(facilityId)).timezone;
    const start = from ?? `${today.slice(0, 8)}01`;
    const end = to ?? today;
    return { start, end, today, tz };
  }

  /**
   * Indikator pelayanan rawat inap (definisi Kemenkes / Barber-Johnson):
   * BOR = hari perawatan / (bed × hari periode) × 100
   * ALOS = lama dirawat pasien keluar / pasien keluar
   * TOI = (bed × hari − hari perawatan) / pasien keluar
   * BTO = pasien keluar / bed
   */
  async inpatientIndicators(facilityId: string, from?: string, to?: string) {
    const { start, end, tz } = await this.range(facilityId, from, to);
    const periodDays = Math.round((Date.parse(end) - Date.parse(start)) / 86_400_000) + 1;
    const [{ bedCount }] = await this.db.select({ bedCount: sql<number>`count(*)::int` }).from(beds).where(eq(beds.facilityId, facilityId));
    const pStart = sql`(${start}::date)::timestamp AT TIME ZONE ${tz}`;
    const pEnd = sql`(${end}::date + 1)::timestamp AT TIME ZONE ${tz}`;
    const [{ patientDays }] = await this.db
      .select({
        patientDays: sql<number>`coalesce(sum(greatest(0, extract(epoch from (least(coalesce(${bedAssignments.endAt}, now()), ${pEnd}) - greatest(${bedAssignments.startAt}, ${pStart}))) / 86400)), 0)::float`,
      })
      .from(bedAssignments)
      .where(eq(bedAssignments.facilityId, facilityId));
    const [{ discharges, losDays, deaths }] = await this.db
      .select({
        discharges: sql<number>`count(*)::int`,
        losDays: sql<number>`coalesce(sum(greatest(1, (${encounters.endAt}::date - ${encounters.startAt}::date))), 0)::float`,
        deaths: sql<number>`count(*) filter (where ${encounters.dischargeDisposition} = 'MENINGGAL')::int`,
      })
      .from(encounters)
      .where(and(eq(encounters.facilityId, facilityId), eq(encounters.type, 'RAWAT_INAP'), eq(encounters.status, 'FINISHED'), gte(encounters.endAt, pStart), lt(encounters.endAt, pEnd)));
    const capacity = bedCount * periodDays;
    return {
      period: { from: start, to: end, days: periodDays },
      beds: bedCount,
      patientDays: round2(patientDays),
      discharges,
      deaths,
      bor: capacity ? round2((patientDays / capacity) * 100) : 0,
      alos: discharges ? round2(losDays / discharges) : 0,
      toi: discharges ? round2((capacity - patientDays) / discharges) : 0,
      bto: bedCount ? round2(discharges / bedCount) : 0,
      gdr: discharges ? round2((deaths / discharges) * 1000) : 0,
    };
  }

  async overview(facilityId: string) {
    const { start, today, tz } = await this.range(facilityId);
    const dStart = sql`(${today}::date)::timestamp AT TIME ZONE ${tz}`;
    const dEnd = sql`(${today}::date + 1)::timestamp AT TIME ZONE ${tz}`;
    const visits = await this.db
      .select({ type: encounters.type, count: sql<number>`count(*)::int` })
      .from(encounters)
      .where(and(eq(encounters.facilityId, facilityId), gte(encounters.startAt, dStart), lt(encounters.startAt, dEnd), sql`${encounters.status} <> 'CANCELLED'`))
      .groupBy(encounters.type);
    const [queue] = await this.db
      .select({
        waiting: sql<number>`count(*) filter (where ${queueTickets.status} = 'WAITING')::int`,
        avgWaitMin: sql<number>`coalesce(avg(extract(epoch from (${queueTickets.calledAt} - ${queueTickets.createdAt})) / 60) filter (where ${queueTickets.calledAt} is not null), 0)::float`,
      })
      .from(queueTickets)
      .where(and(eq(queueTickets.facilityId, facilityId), eq(queueTickets.date, today)));
    const bedStatus = await this.db
      .select({ status: beds.status, count: sql<number>`count(*)::int` })
      .from(beds)
      .where(eq(beds.facilityId, facilityId))
      .groupBy(beds.status);
    const [revenue] = await this.db
      .select({
        month: sql<number>`coalesce(sum(${journalLines.credit} - ${journalLines.debit}), 0)::float`,
        today: sql<number>`coalesce(sum(${journalLines.credit} - ${journalLines.debit}) filter (where ${journalEntries.date} = ${today}), 0)::float`,
      })
      .from(journalLines)
      .innerJoin(journalEntries, eq(journalEntries.id, journalLines.journalId))
      .where(and(eq(journalEntries.facilityId, facilityId), gte(journalEntries.date, start), sql`${journalLines.accountCode} like '4-%'`));
    const revenueTrend = await this.db
      .select({ date: journalEntries.date, amount: sql<number>`coalesce(sum(${journalLines.credit} - ${journalLines.debit}), 0)::float` })
      .from(journalLines)
      .innerJoin(journalEntries, eq(journalEntries.id, journalLines.journalId))
      .where(and(eq(journalEntries.facilityId, facilityId), gte(journalEntries.date, sql`(${today}::date - 29)`), sql`${journalLines.accountCode} like '4-%'`))
      .groupBy(journalEntries.date)
      .orderBy(journalEntries.date);
    return {
      date: today,
      visits,
      queue,
      bedStatus,
      revenue: { month: round2(revenue.month), today: round2(revenue.today) },
      revenueTrend,
      inpatient: await this.inpatientIndicators(facilityId),
    };
  }

  /** 10 besar penyakit (diagnosis utama) — dasar laporan RL. */
  async topDiagnoses(facilityId: string, from?: string, to?: string) {
    const { start, end, tz } = await this.range(facilityId, from, to);
    return this.db
      .select({ code: diagnoses.icd10Code, display: diagnoses.display, count: sql<number>`count(*)::int` })
      .from(diagnoses)
      .innerJoin(encounters, eq(encounters.id, diagnoses.encounterId))
      .where(
        and(
          eq(diagnoses.facilityId, facilityId),
          eq(diagnoses.rank, 'PRIMER'),
          gte(encounters.startAt, sql`(${start}::date)::timestamp AT TIME ZONE ${tz}`),
          lt(encounters.startAt, sql`(${end}::date + 1)::timestamp AT TIME ZONE ${tz}`),
        ),
      )
      .groupBy(diagnoses.icd10Code, diagnoses.display)
      .orderBy(desc(sql`count(*)`))
      .limit(10);
  }

  /** Kunjungan per unit & jenis — rekap layanan. */
  async visitsByUnit(facilityId: string, from?: string, to?: string) {
    const { start, end, tz } = await this.range(facilityId, from, to);
    return this.db
      .select({
        unitName: units.name,
        type: encounters.type,
        total: sql<number>`count(*)::int`,
        newPatients: sql<number>`count(*) filter (where not exists (select 1 from encounters e2 where e2.patient_id = ${encounters.patientId} and e2.start_at < ${encounters.startAt}))::int`,
      })
      .from(encounters)
      .innerJoin(units, eq(units.id, encounters.unitId))
      .where(
        and(
          eq(encounters.facilityId, facilityId),
          sql`${encounters.status} <> 'CANCELLED'`,
          gte(encounters.startAt, sql`(${start}::date)::timestamp AT TIME ZONE ${tz}`),
          lt(encounters.startAt, sql`(${end}::date + 1)::timestamp AT TIME ZONE ${tz}`),
        ),
      )
      .groupBy(units.name, encounters.type)
      .orderBy(units.name);
  }
}

@Injectable()
export class QualityService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly seq: SequenceService,
    private readonly facility: FacilityService,
  ) {}

  async report(user: AuthUser, input: z.infer<typeof IncidentSchema>) {
    const today = await this.facility.today(user.facilityId);
    return this.db.transaction(async (tx) => {
      const incidentNo = await this.seq.document(tx, user.facilityId, 'INC', today);
      const [row] = await tx
        .insert(incidents)
        .values({ ...input, occurredAt: new Date(input.occurredAt), facilityId: user.facilityId, incidentNo, reportedBy: user.id })
        .returning();
      return row;
    });
  }

  list(facilityId: string, status?: string) {
    const conds: SQL[] = [eq(incidents.facilityId, facilityId)];
    if (status) conds.push(inArray(incidents.status, status.split(',')));
    return this.db
      .select({ incident: incidents, unitName: units.name })
      .from(incidents)
      .leftJoin(units, eq(units.id, incidents.unitId))
      .where(and(...conds))
      .orderBy(desc(incidents.occurredAt));
  }

  async setStatus(user: AuthUser, id: string, status: 'INVESTIGATING' | 'CLOSED', riskGrade?: string) {
    const [row] = await this.db
      .update(incidents)
      .set({ status, ...(riskGrade ? { riskGrade } : {}) })
      .where(and(eq(incidents.id, id), eq(incidents.facilityId, user.facilityId)))
      .returning();
    if (!row) throw notFound('Insiden', id);
    return row;
  }
}

@Controller('dashboard')
export class DashboardController {
  constructor(private readonly svc: DashboardService) {}

  @Get('overview')
  @Permissions('dashboard.read')
  overview(@CurrentUser() u: AuthUser) {
    return this.svc.overview(u.facilityId);
  }

  @Get('inpatient-indicators')
  @Permissions('dashboard.read')
  indicators(@CurrentUser() u: AuthUser, @Query(new ZodPipe(PeriodSchema)) q: z.infer<typeof PeriodSchema>) {
    return this.svc.inpatientIndicators(u.facilityId, q.from, q.to);
  }

  @Get('top-diagnoses')
  @Permissions('dashboard.read')
  top(@CurrentUser() u: AuthUser, @Query(new ZodPipe(PeriodSchema)) q: z.infer<typeof PeriodSchema>) {
    return this.svc.topDiagnoses(u.facilityId, q.from, q.to);
  }

  @Get('visits-by-unit')
  @Permissions('dashboard.read')
  visits(@CurrentUser() u: AuthUser, @Query(new ZodPipe(PeriodSchema)) q: z.infer<typeof PeriodSchema>) {
    return this.svc.visitsByUnit(u.facilityId, q.from, q.to);
  }
}

@Controller('quality/incidents')
@AuditResource('Incident')
export class QualityController {
  constructor(private readonly svc: QualityService) {}

  @Get()
  @Permissions('incident.read')
  list(@CurrentUser() u: AuthUser, @Query('status') status?: string) {
    return this.svc.list(u.facilityId, status);
  }

  @Post()
  @Permissions('incident.write')
  report(@CurrentUser() u: AuthUser, @Body(new ZodPipe(IncidentSchema)) body: z.infer<typeof IncidentSchema>) {
    return this.svc.report(u, body);
  }

  @Post(':id/status')
  @Permissions('incident.read')
  status(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body(new ZodPipe(z.object({ status: z.enum(['INVESTIGATING', 'CLOSED']), riskGrade: z.enum(['BIRU', 'HIJAU', 'KUNING', 'MERAH']).optional() }))) body: { status: 'INVESTIGATING' | 'CLOSED'; riskGrade?: string }) {
    return this.svc.setStatus(u, id, body.status, body.riskGrade);
  }
}

@Controller('audit')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  @Permissions('audit.read')
  list(@CurrentUser() u: AuthUser, @Query() q: { patientId?: string; resourceType?: string; actorId?: string; limit?: string; offset?: string }) {
    return this.audit.list(u.facilityId, { ...q, limit: Math.min(Number(q.limit ?? 100), 500), offset: Number(q.offset ?? 0) });
  }

  @Get('verify')
  @Permissions('audit.read')
  verify() {
    return this.audit.verifyChain();
  }
}

@Module({
  controllers: [DashboardController, QualityController, AuditController],
  providers: [DashboardService, QualityService],
})
export class ManagementModule {}

