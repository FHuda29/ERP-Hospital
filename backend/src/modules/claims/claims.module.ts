import { Body, Controller, Get, Inject, Injectable, Module, Param, Post, Query } from '@nestjs/common';
import { and, desc, eq, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { DB, type Db } from '../../database/database.js';
import { claimEvents, claims, diagnoses, encounters, invoices, patients, payers, procedures } from '../../database/schema.js';
import { AuditResource, CurrentUser, Permissions, type AuthUser } from '../../common/auth.js';
import { conflict, invalid, notFound } from '../../common/errors.js';
import { round2 } from '../../common/util.js';
import { ZodPipe } from '../../common/zod.pipe.js';
import { FacilityService } from '../../core/core.module.js';
import { SequenceService } from '../../core/sequence.service.js';
import { FinanceModule } from '../finance/finance.module.js';
import { LedgerService } from '../finance/ledger.service.js';
import { ACC } from '../finance/coa.js';

const CodeSchema = z.object({
  /** Kode grouper INA-CBG mis. "J-4-16-I" (hasil aplikasi E-Klaim) — wajib untuk BPJS */
  inacbgCode: z.string().max(16).optional(),
  inacbgTariff: z.number().nonnegative().optional(),
  notes: z.string().optional(),
});
const DecisionSchema = z.object({
  status: z.enum(['APPROVED', 'PENDING', 'REJECTED']),
  approvedAmount: z.number().nonnegative().optional(),
  note: z.string().min(3),
});
const ClaimPaymentSchema = z.object({ amount: z.number().nonnegative(), reference: z.string().optional() });

/** Mesin status klaim — transisi di luar tabel ini ditolak. */
const TRANSITIONS: Record<string, string[]> = {
  DRAFT: ['CODED'],
  CODED: ['SUBMITTED', 'CODED'],
  SUBMITTED: ['APPROVED', 'PENDING', 'REJECTED'],
  PENDING: ['CODED'],
  REJECTED: ['CODED'],
  APPROVED: ['PAID'],
  PAID: [],
};

@Injectable()
export class ClaimsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly seq: SequenceService,
    private readonly facility: FacilityService,
    private readonly ledger: LedgerService,
  ) {}

  async create(user: AuthUser, encounterId: string) {
    const [row] = await this.db
      .select({ e: encounters, payer: payers })
      .from(encounters)
      .innerJoin(payers, eq(payers.id, encounters.payerId))
      .where(and(eq(encounters.id, encounterId), eq(encounters.facilityId, user.facilityId)));
    if (!row) throw notFound('Kunjungan', encounterId);
    if (row.payer.type === 'UMUM') throw invalid('NOT_PAYER_ENCOUNTER', 'Kunjungan pasien umum tidak diklaimkan');
    if (row.e.status !== 'FINISHED') throw invalid('ENCOUNTER_NOT_FINISHED', 'Klaim diajukan setelah pelayanan selesai');
    const [inv] = await this.db
      .select()
      .from(invoices)
      .where(and(eq(invoices.encounterId, encounterId), eq(invoices.billTo, 'PENJAMIN'), eq(invoices.status, 'ISSUED')));
    if (!inv) throw invalid('PAYER_INVOICE_REQUIRED', 'Terbitkan tagihan penjamin terlebih dahulu');
    const exists = await this.db.select({ id: claims.id }).from(claims).where(eq(claims.invoiceId, inv.id));
    if (exists.length) throw conflict('CLAIM_EXISTS', 'Klaim untuk tagihan ini sudah ada');
    const today = await this.facility.today(user.facilityId);
    return this.db.transaction(async (tx) => {
      const claimNo = await this.seq.document(tx, user.facilityId, 'CLM', today, '/');
      const [c] = await tx
        .insert(claims)
        .values({ facilityId: user.facilityId, claimNo, encounterId, invoiceId: inv.id, payerId: row.payer.id, sepNumber: row.e.sepNumber, hospitalTariff: inv.total, claimedAmount: inv.total })
        .returning();
      await tx.insert(claimEvents).values({ claimId: c.id, toStatus: 'DRAFT', actorId: user.id, note: 'Klaim dibuat' });
      return { ...c, patientId: row.e.patientId };
    });
  }

  private async transition(user: AuthUser, id: string, to: string, patch: Partial<typeof claims.$inferInsert>, note?: string) {
    const c = await this.get(user.facilityId, id);
    if (!TRANSITIONS[c.status]?.includes(to)) throw conflict('CLAIM_INVALID_TRANSITION', `Klaim berstatus ${c.status} tidak dapat menjadi ${to}`);
    return this.db.transaction(async (tx) => {
      const [row] = await tx.update(claims).set({ ...patch, status: to, updatedAt: new Date() }).where(eq(claims.id, id)).returning();
      await tx.insert(claimEvents).values({ claimId: id, fromStatus: c.status, toStatus: to, note, actorId: user.id });
      return row;
    });
  }

  /** Validasi coding: diagnosis utama ICD-10; BPJS wajib SEP + kode INA-CBG. */
  async code(user: AuthUser, id: string, input: z.infer<typeof CodeSchema>) {
    const c = await this.get(user.facilityId, id);
    const [payer] = await this.db.select().from(payers).where(eq(payers.id, c.payerId));
    const primary = await this.db.select({ id: diagnoses.id }).from(diagnoses).where(and(eq(diagnoses.encounterId, c.encounterId), eq(diagnoses.rank, 'PRIMER')));
    if (!primary.length) throw invalid('PRIMARY_DIAGNOSIS_REQUIRED', 'Diagnosis utama belum dikoding');
    if (payer.type === 'BPJS') {
      if (!c.sepNumber) {
        const [e] = await this.db.select({ sep: encounters.sepNumber }).from(encounters).where(eq(encounters.id, c.encounterId));
        if (!e?.sep) throw invalid('SEP_REQUIRED', 'Nomor SEP belum terbit');
        c.sepNumber = e.sep;
      }
      if (!input.inacbgCode || input.inacbgTariff === undefined) throw invalid('INACBG_REQUIRED', 'Kode & tarif INA-CBG wajib diisi untuk klaim JKN');
    }
    const claimedAmount = payer.type === 'BPJS' ? input.inacbgTariff! : c.hospitalTariff;
    return this.transition(user, id, 'CODED', { inacbgCode: input.inacbgCode ?? null, inacbgTariff: input.inacbgTariff ?? null, claimedAmount, sepNumber: c.sepNumber, notes: input.notes ?? c.notes }, 'Coding selesai');
  }

  submit(user: AuthUser, id: string) {
    return this.transition(user, id, 'SUBMITTED', { submittedAt: new Date() }, 'Diajukan ke penjamin');
  }

  async decide(user: AuthUser, id: string, input: z.infer<typeof DecisionSchema>) {
    const c = await this.get(user.facilityId, id);
    const approvedAmount = input.status === 'APPROVED' ? (input.approvedAmount ?? c.claimedAmount) : null;
    return this.transition(user, id, input.status, { approvedAmount }, input.note);
  }

  /** Koreksi / appeal setelah pending atau ditolak — versi klaim bertambah. */
  async revise(user: AuthUser, id: string, note: string) {
    const c = await this.get(user.facilityId, id);
    if (!['PENDING', 'REJECTED'].includes(c.status)) throw conflict('CLAIM_NOT_REVISABLE', 'Hanya klaim pending/ditolak yang dapat direvisi');
    return this.transition(user, id, 'CODED', { version: c.version + 1 }, `Revisi v${c.version + 1}: ${note}`);
  }

  /**
   * Pembayaran klaim & rekonsiliasi piutang.
   * Jurnal: Dr Bank (dibayar) ± Selisih tarif klaim — Cr Piutang penjamin (nilai tagihan).
   */
  async pay(user: AuthUser, id: string, input: z.infer<typeof ClaimPaymentSchema>) {
    const c = await this.get(user.facilityId, id);
    if (c.status !== 'APPROVED') throw conflict('CLAIM_NOT_APPROVED', 'Klaim belum disetujui');
    const [inv] = await this.db.select().from(invoices).where(eq(invoices.id, c.invoiceId!));
    const [payer] = await this.db.select().from(payers).where(eq(payers.id, c.payerId));
    const receivable = round2(inv.total - inv.paidAmount);
    const diff = round2(input.amount - receivable);
    const today = await this.facility.today(user.facilityId);
    return this.db.transaction(async (tx) => {
      await this.ledger.post(
        tx,
        user.facilityId,
        {
          date: today,
          description: `Pembayaran klaim ${c.claimNo} ${payer.name}${c.inacbgCode ? ` (INA-CBG ${c.inacbgCode})` : ''}`,
          sourceType: 'CLAIM_PAYMENT',
          sourceId: c.id,
          lines: [
            { accountCode: ACC.BANK, debit: input.amount },
            ...(diff < 0 ? [{ accountCode: ACC.SELISIH_KLAIM, debit: -diff }] : []),
            ...(diff > 0 ? [{ accountCode: ACC.SELISIH_KLAIM, credit: diff }] : []),
            { accountCode: payer.receivableAccount, credit: receivable },
          ],
        },
        user.id,
      );
      await tx.update(invoices).set({ paidAmount: inv.total, status: 'PAID' }).where(eq(invoices.id, inv.id));
      const [row] = await tx.update(claims).set({ status: 'PAID', paidAmount: input.amount, updatedAt: new Date() }).where(eq(claims.id, id)).returning();
      await tx.insert(claimEvents).values({ claimId: id, fromStatus: 'APPROVED', toStatus: 'PAID', note: `Dibayar Rp ${input.amount}${input.reference ? ` ref ${input.reference}` : ''}; selisih Rp ${diff}`, actorId: user.id });
      return { ...row, variance: diff };
    });
  }

  async list(facilityId: string, status?: string) {
    const conds: SQL[] = [eq(claims.facilityId, facilityId)];
    if (status) conds.push(eq(claims.status, status));
    return this.db
      .select({ claim: claims, encounterNo: encounters.encounterNo, encounterType: encounters.type, patientName: patients.name, mrn: patients.mrn, payerName: payers.name, payerType: payers.type })
      .from(claims)
      .innerJoin(encounters, eq(encounters.id, claims.encounterId))
      .innerJoin(patients, eq(patients.id, encounters.patientId))
      .innerJoin(payers, eq(payers.id, claims.payerId))
      .where(and(...conds))
      .orderBy(desc(claims.updatedAt));
  }

  async get(facilityId: string, id: string) {
    const [c] = await this.db.select().from(claims).where(and(eq(claims.id, id), eq(claims.facilityId, facilityId)));
    if (!c) throw notFound('Klaim', id);
    return c;
  }

  async detail(facilityId: string, id: string) {
    const c = await this.get(facilityId, id);
    const [events, dx, procs] = await Promise.all([
      this.db.select().from(claimEvents).where(eq(claimEvents.claimId, id)).orderBy(claimEvents.createdAt),
      this.db.select().from(diagnoses).where(eq(diagnoses.encounterId, c.encounterId)),
      this.db.select().from(procedures).where(eq(procedures.encounterId, c.encounterId)),
    ]);
    return { ...c, events, diagnoses: dx, procedures: procs };
  }

  /** Daftar kunjungan penjamin yang siap diklaim (selesai, tagihan penjamin terbit, belum ada klaim). */
  async ready(facilityId: string) {
    return this.db
      .select({ encounterId: encounters.id, encounterNo: encounters.encounterNo, type: encounters.type, patientName: patients.name, mrn: patients.mrn, payerName: payers.name, sepNumber: encounters.sepNumber, invoiceTotal: invoices.total, endAt: encounters.endAt })
      .from(invoices)
      .innerJoin(encounters, eq(encounters.id, invoices.encounterId))
      .innerJoin(patients, eq(patients.id, encounters.patientId))
      .innerJoin(payers, eq(payers.id, invoices.payerId))
      .where(
        and(
          eq(invoices.facilityId, facilityId),
          eq(invoices.billTo, 'PENJAMIN'),
          eq(invoices.status, 'ISSUED'),
          sql`not exists (select 1 from ${claims} where ${claims.invoiceId} = ${invoices.id})`,
        ),
      );
  }

  async stats(facilityId: string) {
    const rows = await this.db
      .select({ status: claims.status, count: sql<number>`count(*)::int`, claimed: sql<string>`sum(${claims.claimedAmount})`, hospital: sql<string>`sum(${claims.hospitalTariff})` })
      .from(claims)
      .where(eq(claims.facilityId, facilityId))
      .groupBy(claims.status);
    const decided = rows.filter((r) => ['APPROVED', 'REJECTED', 'PAID', 'PENDING'].includes(r.status)).reduce((s, r) => s + r.count, 0);
    const rejected = rows.find((r) => r.status === 'REJECTED')?.count ?? 0;
    return { byStatus: rows.map((r) => ({ ...r, claimed: Number(r.claimed), hospital: Number(r.hospital) })), rejectionRate: decided ? round2((rejected / decided) * 100) : 0 };
  }
}

@Controller('claims')
@AuditResource('Claim')
export class ClaimsController {
  constructor(private readonly svc: ClaimsService) {}

  @Get()
  @Permissions('claim.read')
  list(@CurrentUser() u: AuthUser, @Query('status') status?: string) {
    return this.svc.list(u.facilityId, status);
  }

  @Get('ready')
  @Permissions('claim.read')
  ready(@CurrentUser() u: AuthUser) {
    return this.svc.ready(u.facilityId);
  }

  @Get('stats')
  @Permissions('claim.read', 'dashboard.read')
  stats(@CurrentUser() u: AuthUser) {
    return this.svc.stats(u.facilityId);
  }

  @Get(':id')
  @Permissions('claim.read')
  detail(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.svc.detail(u.facilityId, id);
  }

  @Post()
  @Permissions('claim.write')
  create(@CurrentUser() u: AuthUser, @Body(new ZodPipe(z.object({ encounterId: z.uuid() }))) body: { encounterId: string }) {
    return this.svc.create(u, body.encounterId);
  }

  @Post(':id/code')
  @Permissions('claim.write')
  code(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body(new ZodPipe(CodeSchema)) body: z.infer<typeof CodeSchema>) {
    return this.svc.code(u, id, body);
  }

  @Post(':id/submit')
  @Permissions('claim.write')
  submit(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.svc.submit(u, id);
  }

  @Post(':id/decision')
  @Permissions('claim.write')
  decide(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body(new ZodPipe(DecisionSchema)) body: z.infer<typeof DecisionSchema>) {
    return this.svc.decide(u, id, body);
  }

  @Post(':id/revise')
  @Permissions('claim.write')
  revise(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body(new ZodPipe(z.object({ note: z.string().min(5) }))) body: { note: string }) {
    return this.svc.revise(u, id, body.note);
  }

  @Post(':id/payment')
  @Permissions('finance.write')
  pay(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body(new ZodPipe(ClaimPaymentSchema)) body: z.infer<typeof ClaimPaymentSchema>) {
    return this.svc.pay(u, id, body);
  }
}

@Module({
  imports: [FinanceModule],
  controllers: [ClaimsController],
  providers: [ClaimsService],
  exports: [ClaimsService],
})
export class ClaimsModule {}
