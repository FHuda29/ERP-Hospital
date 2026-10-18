import { Body, Controller, Get, Inject, Injectable, Module, Param, Post, Query } from '@nestjs/common';
import { and, desc, eq, gte, inArray, lt, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { DB, type Db } from '../../database/database.js';
import { charges, encounters, invoiceLines, invoices, journalEntries, patients, payers, payments, users } from '../../database/schema.js';
import { AuditResource, CurrentUser, Permissions, type AuthUser } from '../../common/auth.js';
import { conflict, invalid, notFound } from '../../common/errors.js';
import { round2, sum } from '../../common/util.js';
import { ZodPipe } from '../../common/zod.pipe.js';
import { FacilityService } from '../../core/core.module.js';
import { SequenceService } from '../../core/sequence.service.js';
import { MasterModule } from '../master/master.module.js';
import { FinanceModule } from '../finance/finance.module.js';
import { LedgerService } from '../finance/ledger.service.js';
import { ACC } from '../finance/coa.js';
import { ChargeService } from './charge.service.js';

const ManualChargeSchema = z.object({
  encounterId: z.uuid(),
  serviceId: z.uuid(),
  quantity: z.number().positive().max(1000).default(1),
  description: z.string().optional(),
});

const PaymentSchema = z.object({
  amount: z.number().positive(),
  method: z.enum(['TUNAI', 'DEBIT', 'KREDIT', 'QRIS', 'TRANSFER', 'VA']),
  reference: z.string().max(64).optional(),
});

@Injectable()
export class BillingService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly chargesSvc: ChargeService,
    private readonly ledger: LedgerService,
    private readonly seq: SequenceService,
    private readonly facility: FacilityService,
  ) {}

  async encounterSummary(facilityId: string, encounterId: string) {
    const [enc] = await this.db
      .select({ encounter: encounters, payer: payers, patient: { id: patients.id, name: patients.name, mrn: patients.mrn } })
      .from(encounters)
      .innerJoin(payers, eq(payers.id, encounters.payerId))
      .innerJoin(patients, eq(patients.id, encounters.patientId))
      .where(and(eq(encounters.id, encounterId), eq(encounters.facilityId, facilityId)));
    if (!enc) throw notFound('Kunjungan', encounterId);
    const rows = await this.db.select().from(charges).where(eq(charges.encounterId, encounterId)).orderBy(charges.createdAt);
    const invs = await this.db.select().from(invoices).where(eq(invoices.encounterId, encounterId)).orderBy(invoices.createdAt);
    const live = rows.filter((c) => c.status !== 'VOID');
    return {
      ...enc,
      charges: rows,
      invoices: invs,
      totals: {
        all: sum(live.map((c) => c.amount)),
        patient: sum(live.filter((c) => c.billTo === 'PASIEN').map((c) => c.amount)),
        payer: sum(live.filter((c) => c.billTo === 'PENJAMIN').map((c) => c.amount)),
        uninvoiced: sum(live.filter((c) => c.status === 'ACTIVE').map((c) => c.amount)),
        cost: sum(live.map((c) => c.costAmount)),
      },
    };
  }

  async manualCharge(user: AuthUser, input: z.infer<typeof ManualChargeSchema>) {
    const today = await this.facility.today(user.facilityId);
    return this.db.transaction(async (tx) => {
      const ctx = await this.chargesSvc.context(tx, user.facilityId, input.encounterId, user.id, today);
      if (ctx.encounter.status === 'CANCELLED') throw invalid('ENCOUNTER_CANCELLED', 'Kunjungan sudah dibatalkan');
      return this.chargesSvc.addService(tx, ctx, input.serviceId, { quantity: input.quantity, sourceType: 'MANUAL', description: input.description });
    });
  }

  async voidCharge(user: AuthUser, id: string, reason: string) {
    const [row] = await this.db
      .update(charges)
      .set({ status: 'VOID', voidReason: reason })
      .where(and(eq(charges.id, id), eq(charges.facilityId, user.facilityId), eq(charges.status, 'ACTIVE')))
      .returning();
    if (!row) throw conflict('CHARGE_NOT_VOIDABLE', 'Charge tidak ditemukan atau sudah ditagihkan/dibatalkan');
    return row;
  }

  /**
   * Terbitkan invoice dari charge ACTIVE — dipisah: tagihan PASIEN dan tagihan PENJAMIN.
   * Jurnal: Dr Piutang (pasien / penjamin) — Cr Pendapatan per akun layanan.
   */
  async generateInvoices(user: AuthUser, encounterId: string) {
    const today = await this.facility.today(user.facilityId);
    return this.db.transaction(async (tx) => {
      const ctx = await this.chargesSvc.context(tx, user.facilityId, encounterId, user.id, today);
      const { encounter, payer } = ctx;
      if (encounter.status === 'CANCELLED') throw invalid('ENCOUNTER_CANCELLED', 'Kunjungan sudah dibatalkan');
      if (encounter.type === 'RAWAT_INAP' && encounter.status !== 'FINISHED') {
        throw invalid('INPATIENT_NOT_DISCHARGED', 'Tagihan rawat inap diterbitkan setelah pasien dipulangkan (hari rawat final)');
      }
      // Kunci baris charge supaya dua kasir tidak menerbitkan invoice yang sama.
      const active = await tx
        .select()
        .from(charges)
        .where(and(eq(charges.encounterId, encounterId), eq(charges.status, 'ACTIVE')))
        .for('update');
      if (!active.length) throw invalid('NO_CHARGES', 'Tidak ada charge yang belum ditagihkan');

      const [umum] = await tx
        .select()
        .from(payers)
        .where(and(eq(payers.facilityId, user.facilityId), eq(payers.type, 'UMUM')))
        .limit(1);

      const created = [];
      for (const billTo of ['PENJAMIN', 'PASIEN'] as const) {
        const group = active.filter((c) => c.billTo === billTo);
        if (!group.length) continue;
        const invPayer = billTo === 'PENJAMIN' ? payer : (umum ?? payer);
        const total = sum(group.map((c) => c.amount));
        const invoiceNo = await this.seq.document(tx, user.facilityId, 'INV', today, '/');
        const [inv] = await tx
          .insert(invoices)
          .values({
            facilityId: user.facilityId,
            invoiceNo,
            encounterId,
            patientId: encounter.patientId,
            payerId: invPayer.id,
            billTo,
            subtotal: total,
            total,
            issuedBy: user.id,
          })
          .returning();
        await tx.insert(invoiceLines).values(
          group.map((c) => ({ invoiceId: inv.id, chargeId: c.id, description: c.description, quantity: c.quantity, unitPrice: c.unitPrice, amount: c.amount })),
        );
        await tx.update(charges).set({ status: 'INVOICED' }).where(inArray(charges.id, group.map((c) => c.id)));

        const revenueByAccount = new Map<string, number>();
        for (const c of group) revenueByAccount.set(c.revenueAccount, round2((revenueByAccount.get(c.revenueAccount) ?? 0) + c.amount));
        await this.ledger.post(
          tx,
          user.facilityId,
          {
            date: today,
            description: `Pendapatan ${encounter.encounterNo} — ${invoiceNo} (${billTo === 'PASIEN' ? 'pasien' : invPayer.name})`,
            sourceType: 'INVOICE',
            sourceId: inv.id,
            lines: [
              { accountCode: invPayer.receivableAccount, debit: total },
              ...[...revenueByAccount].map(([accountCode, credit]) => ({ accountCode, credit })),
            ],
          },
          user.id,
        );
        created.push(inv);
      }
      return { encounterId, patientId: encounter.patientId, invoices: created };
    });
  }

  async listInvoices(facilityId: string, q: { status?: string; billTo?: string; patientId?: string }) {
    const conds = [eq(invoices.facilityId, facilityId)];
    if (q.status) conds.push(eq(invoices.status, q.status));
    if (q.billTo) conds.push(eq(invoices.billTo, q.billTo));
    if (q.patientId) conds.push(eq(invoices.patientId, q.patientId));
    return this.db
      .select({
        id: invoices.id,
        invoiceNo: invoices.invoiceNo,
        billTo: invoices.billTo,
        status: invoices.status,
        total: invoices.total,
        paidAmount: invoices.paidAmount,
        createdAt: invoices.createdAt,
        encounterId: invoices.encounterId,
        encounterNo: encounters.encounterNo,
        patientId: patients.id,
        patientName: patients.name,
        mrn: patients.mrn,
        payerName: payers.name,
        payerType: payers.type,
      })
      .from(invoices)
      .innerJoin(patients, eq(patients.id, invoices.patientId))
      .innerJoin(payers, eq(payers.id, invoices.payerId))
      .innerJoin(encounters, eq(encounters.id, invoices.encounterId))
      .where(and(...conds))
      .orderBy(desc(invoices.createdAt))
      .limit(300);
  }

  async getInvoice(facilityId: string, id: string) {
    const [inv] = await this.db
      .select({ invoice: invoices, patient: { id: patients.id, name: patients.name, mrn: patients.mrn, address: patients.address }, payer: payers, encounterNo: encounters.encounterNo })
      .from(invoices)
      .innerJoin(patients, eq(patients.id, invoices.patientId))
      .innerJoin(payers, eq(payers.id, invoices.payerId))
      .innerJoin(encounters, eq(encounters.id, invoices.encounterId))
      .where(and(eq(invoices.id, id), eq(invoices.facilityId, facilityId)));
    if (!inv) throw notFound('Invoice', id);
    const lines = await this.db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, id));
    const pays = await this.db
      .select({ payment: payments, cashier: users.fullName })
      .from(payments)
      .innerJoin(users, eq(users.id, payments.receivedBy))
      .where(eq(payments.invoiceId, id))
      .orderBy(payments.createdAt);
    return { ...inv, lines, payments: pays, patientId: inv.patient.id };
  }

  /** Pembayaran kasir. Jurnal: Dr Kas/Bank — Cr Piutang. */
  async pay(user: AuthUser, invoiceId: string, input: z.infer<typeof PaymentSchema>) {
    const today = await this.facility.today(user.facilityId);
    return this.db.transaction(async (tx) => {
      const [inv] = await tx
        .select({ invoice: invoices, payer: payers })
        .from(invoices)
        .innerJoin(payers, eq(payers.id, invoices.payerId))
        .where(and(eq(invoices.id, invoiceId), eq(invoices.facilityId, user.facilityId)))
        .for('update');
      if (!inv) throw notFound('Invoice', invoiceId);
      const { invoice, payer } = inv;
      if (invoice.billTo !== 'PASIEN') throw invalid('INVOICE_IS_PAYER_CLAIM', 'Tagihan penjamin diselesaikan melalui modul klaim');
      if (invoice.status === 'PAID' || invoice.status === 'VOID') throw conflict('INVOICE_CLOSED', 'Invoice sudah lunas atau dibatalkan');
      const outstanding = round2(invoice.total - invoice.paidAmount);
      if (input.amount > outstanding) throw invalid('OVERPAYMENT', `Pembayaran melebihi sisa tagihan (Rp ${outstanding})`);

      const paymentNo = await this.seq.document(tx, user.facilityId, 'PAY', today, '/');
      const [pay] = await tx
        .insert(payments)
        .values({ facilityId: user.facilityId, paymentNo, invoiceId, amount: input.amount, method: input.method, reference: input.reference, receivedBy: user.id })
        .returning();
      const paid = round2(invoice.paidAmount + input.amount);
      await tx
        .update(invoices)
        .set({ paidAmount: paid, status: paid >= invoice.total ? 'PAID' : 'PARTIAL' })
        .where(eq(invoices.id, invoiceId));
      await this.ledger.post(
        tx,
        user.facilityId,
        {
          date: today,
          description: `Penerimaan ${paymentNo} atas ${invoice.invoiceNo} (${input.method})`,
          sourceType: 'PAYMENT',
          sourceId: pay.id,
          lines: [
            { accountCode: input.method === 'TUNAI' ? ACC.KAS_KASIR : ACC.BANK, debit: input.amount },
            { accountCode: payer.receivableAccount, credit: input.amount },
          ],
        },
        user.id,
      );
      return { ...pay, patientId: invoice.patientId, invoiceStatus: paid >= invoice.total ? 'PAID' : 'PARTIAL', outstanding: round2(invoice.total - paid) };
    });
  }

  /** Batalkan invoice yang belum dibayar: jurnal dibalik, charge kembali ACTIVE. */
  async voidInvoice(user: AuthUser, invoiceId: string, reason: string) {
    const today = await this.facility.today(user.facilityId);
    const [inv] = await this.db.select().from(invoices).where(and(eq(invoices.id, invoiceId), eq(invoices.facilityId, user.facilityId)));
    if (!inv) throw notFound('Invoice', invoiceId);
    if (inv.paidAmount > 0 || inv.status === 'VOID') throw conflict('INVOICE_NOT_VOIDABLE', 'Invoice yang sudah dibayar/dibatalkan tidak dapat di-void');
    const [journal] = await this.db
      .select()
      .from(journalEntries)
      .where(and(eq(journalEntries.sourceType, 'INVOICE'), eq(journalEntries.sourceId, invoiceId), eq(journalEntries.status, 'POSTED')));
    if (journal) await this.ledger.reverse(user.facilityId, journal.id, today, user.id);
    await this.db.transaction(async (tx) => {
      const lines = await tx.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, invoiceId));
      if (lines.length) await tx.update(charges).set({ status: 'ACTIVE' }).where(inArray(charges.id, lines.map((l) => l.chargeId)));
      await tx.update(invoices).set({ status: 'VOID' }).where(eq(invoices.id, invoiceId));
    });
    return { id: invoiceId, status: 'VOID', reason, patientId: inv.patientId };
  }

  /** Umur piutang (AR aging) per penjamin. */
  async arAging(facilityId: string) {
    const rows = await this.db
      .select({
        payerName: payers.name,
        payerType: payers.type,
        outstanding: sql<string>`${invoices.total} - ${invoices.paidAmount}`,
        ageDays: sql<number>`extract(day from now() - ${invoices.createdAt})::int`,
      })
      .from(invoices)
      .innerJoin(payers, eq(payers.id, invoices.payerId))
      .where(and(eq(invoices.facilityId, facilityId), inArray(invoices.status, ['ISSUED', 'PARTIAL'])));
    const buckets = new Map<string, { payer: string; type: string; d0_30: number; d31_60: number; d61_90: number; d90p: number; total: number }>();
    for (const r of rows) {
      const b = buckets.get(r.payerName) ?? { payer: r.payerName, type: r.payerType, d0_30: 0, d31_60: 0, d61_90: 0, d90p: 0, total: 0 };
      const amt = Number(r.outstanding);
      const key = r.ageDays <= 30 ? 'd0_30' : r.ageDays <= 60 ? 'd31_60' : r.ageDays <= 90 ? 'd61_90' : 'd90p';
      b[key] = round2(b[key] + amt);
      b.total = round2(b.total + amt);
      buckets.set(r.payerName, b);
    }
    return [...buckets.values()];
  }

  /** Rekap penerimaan kasir per hari & metode (dasar tutup kas/setoran). */
  async cashierRecap(facilityId: string, date?: string) {
    const day = date ?? (await this.facility.today(facilityId));
    const tz = (await this.facility.get(facilityId)).timezone;
    const rows = await this.db
      .select({
        method: payments.method,
        cashier: users.fullName,
        count: sql<number>`count(*)::int`,
        total: sql<string>`sum(${payments.amount})`,
      })
      .from(payments)
      .innerJoin(users, eq(users.id, payments.receivedBy))
      .where(
        and(
          eq(payments.facilityId, facilityId),
          gte(payments.createdAt, sql`(${day}::date)::timestamp AT TIME ZONE ${tz}`),
          lt(payments.createdAt, sql`(${day}::date + 1)::timestamp AT TIME ZONE ${tz}`),
        ),
      )
      .groupBy(payments.method, users.fullName);
    return { date: day, rows: rows.map((r) => ({ ...r, total: Number(r.total) })), grandTotal: sum(rows.map((r) => Number(r.total))) };
  }

  /** Daftar kunjungan yang punya charge belum ditagih — antrean kerja kasir. */
  async pendingBilling(facilityId: string) {
    return this.db
      .select({
        encounterId: encounters.id,
        encounterNo: encounters.encounterNo,
        type: encounters.type,
        status: encounters.status,
        patientName: patients.name,
        mrn: patients.mrn,
        payerName: payers.name,
        amount: sql<string>`sum(${charges.amount})`,
      })
      .from(charges)
      .innerJoin(encounters, eq(encounters.id, charges.encounterId))
      .innerJoin(patients, eq(patients.id, encounters.patientId))
      .innerJoin(payers, eq(payers.id, encounters.payerId))
      .where(and(eq(charges.facilityId, facilityId), eq(charges.status, 'ACTIVE'), ne(encounters.status, 'CANCELLED')))
      .groupBy(encounters.id, encounters.encounterNo, encounters.type, encounters.status, patients.name, patients.mrn, payers.name)
      .orderBy(encounters.encounterNo);
  }
}

@Controller('billing')
@AuditResource('Billing')
export class BillingController {
  constructor(private readonly svc: BillingService) {}

  @Get('pending')
  @Permissions('billing.read')
  pending(@CurrentUser() u: AuthUser) {
    return this.svc.pendingBilling(u.facilityId);
  }

  @Get('encounters/:id')
  @Permissions('billing.read')
  summary(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.svc.encounterSummary(u.facilityId, id);
  }

  @Post('charges')
  @Permissions('billing.write')
  manualCharge(@CurrentUser() u: AuthUser, @Body(new ZodPipe(ManualChargeSchema)) body: z.infer<typeof ManualChargeSchema>) {
    return this.svc.manualCharge(u, body);
  }

  @Post('charges/:id/void')
  @Permissions('billing.write')
  voidCharge(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body(new ZodPipe(z.object({ reason: z.string().min(5) }))) body: { reason: string }) {
    return this.svc.voidCharge(u, id, body.reason);
  }

  @Post('encounters/:id/invoices')
  @Permissions('billing.write')
  generate(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.svc.generateInvoices(u, id);
  }

  @Get('invoices')
  @Permissions('billing.read')
  invoices(@CurrentUser() u: AuthUser, @Query() q: { status?: string; billTo?: string; patientId?: string }) {
    return this.svc.listInvoices(u.facilityId, q);
  }

  @Get('invoices/:id')
  @Permissions('billing.read')
  invoice(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.svc.getInvoice(u.facilityId, id);
  }

  @Post('invoices/:id/payments')
  @Permissions('payment.write')
  pay(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body(new ZodPipe(PaymentSchema)) body: z.infer<typeof PaymentSchema>) {
    return this.svc.pay(u, id, body);
  }

  @Post('invoices/:id/void')
  @Permissions('billing.write')
  voidInvoice(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body(new ZodPipe(z.object({ reason: z.string().min(5) }))) body: { reason: string }) {
    return this.svc.voidInvoice(u, id, body.reason);
  }

  @Get('ar-aging')
  @Permissions('billing.read', 'finance.read')
  arAging(@CurrentUser() u: AuthUser) {
    return this.svc.arAging(u.facilityId);
  }

  @Get('cashier-recap')
  @Permissions('billing.read')
  recap(@CurrentUser() u: AuthUser, @Query('date') date?: string) {
    return this.svc.cashierRecap(u.facilityId, date);
  }
}

@Module({
  imports: [MasterModule, FinanceModule],
  controllers: [BillingController],
  providers: [ChargeService, BillingService],
  exports: [ChargeService],
})
export class BillingModule {}
