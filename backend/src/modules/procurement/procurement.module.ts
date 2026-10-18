import { Body, Controller, Get, Inject, Injectable, Module, Param, Post, Query } from '@nestjs/common';
import { and, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { DB, type Db } from '../../database/database.js';
import {
  apInvoices,
  apPayments,
  goodsReceiptItems,
  goodsReceipts,
  items,
  purchaseOrderItems,
  purchaseOrders,
  purchaseRequestItems,
  purchaseRequests,
  units,
  vendors,
  warehouses,
} from '../../database/schema.js';
import { AuditResource, CurrentUser, Permissions, type AuthUser } from '../../common/auth.js';
import { conflict, forbidden, invalid, notFound } from '../../common/errors.js';
import { round2, sum } from '../../common/util.js';
import { ZodPipe, zDate } from '../../common/zod.pipe.js';
import { FacilityService } from '../../core/core.module.js';
import { SequenceService } from '../../core/sequence.service.js';
import { FinanceModule } from '../finance/finance.module.js';
import { LedgerService } from '../finance/ledger.service.js';
import { ACC } from '../finance/coa.js';
import { InventoryModule, InventoryService } from '../inventory/inventory.module.js';

const PrSchema = z.object({
  unitId: z.uuid(),
  notes: z.string().optional(),
  items: z.array(z.object({ itemId: z.uuid(), quantity: z.number().positive(), notes: z.string().optional() })).min(1),
});

const PoSchema = z.object({
  vendorId: z.uuid(),
  prId: z.uuid().optional(),
  expectedDate: zDate.optional(),
  taxRate: z.number().min(0).max(100).default(11),
  items: z.array(z.object({ itemId: z.uuid(), quantity: z.number().positive(), unitPrice: z.number().nonnegative() })).min(1),
});

const GrSchema = z.object({
  poId: z.uuid(),
  warehouseId: z.uuid(),
  vendorDeliveryNo: z.string().optional(),
  notes: z.string().optional(),
  items: z
    .array(
      z.object({
        poItemId: z.uuid(),
        batchNo: z.string().min(1),
        expiryDate: zDate,
        quantity: z.number().positive(),
        inspectionPassed: z.boolean().default(true),
      }),
    )
    .min(1),
});

const ApInvoiceSchema = z.object({
  poId: z.uuid(),
  invoiceNo: z.string().min(1),
  invoiceDate: zDate,
  subtotal: z.number().nonnegative(),
  tax: z.number().nonnegative(),
});

const ApPaymentSchema = z.object({
  amount: z.number().positive(),
  method: z.enum(['TRANSFER', 'GIRO', 'TUNAI']),
  reference: z.string().optional(),
});

/** Toleransi selisih three-way match (0,5%). */
const MATCH_TOLERANCE = 0.005;

@Injectable()
export class ProcurementService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly seq: SequenceService,
    private readonly facility: FacilityService,
    private readonly inventory: InventoryService,
    private readonly ledger: LedgerService,
  ) {}

  /* ------------------------- Permintaan pembelian ------------------------- */

  async createPr(user: AuthUser, input: z.infer<typeof PrSchema>) {
    const today = await this.facility.today(user.facilityId);
    return this.db.transaction(async (tx) => {
      const prNo = await this.seq.document(tx, user.facilityId, 'PR', today, '/');
      const [pr] = await tx.insert(purchaseRequests).values({ facilityId: user.facilityId, prNo, unitId: input.unitId, notes: input.notes, requestedBy: user.id }).returning();
      await tx.insert(purchaseRequestItems).values(input.items.map((i) => ({ ...i, prId: pr.id })));
      return pr;
    });
  }

  async listPr(facilityId: string, status?: string) {
    const conds: SQL[] = [eq(purchaseRequests.facilityId, facilityId)];
    if (status) conds.push(eq(purchaseRequests.status, status));
    const prs = await this.db
      .select({ pr: purchaseRequests, unitName: units.name })
      .from(purchaseRequests)
      .innerJoin(units, eq(units.id, purchaseRequests.unitId))
      .where(and(...conds))
      .orderBy(desc(purchaseRequests.createdAt));
    if (!prs.length) return [];
    const lines = await this.db
      .select({ line: purchaseRequestItems, itemName: items.name, uom: items.uom })
      .from(purchaseRequestItems)
      .innerJoin(items, eq(items.id, purchaseRequestItems.itemId))
      .where(inArray(purchaseRequestItems.prId, prs.map((p) => p.pr.id)));
    // Informasi stok saat ini membantu approver menilai kebutuhan
    const stock = await this.inventory.stock(facilityId);
    return prs.map((p) => ({
      ...p,
      items: lines
        .filter((l) => l.line.prId === p.pr.id)
        .map((l) => ({ ...l, onHand: stock.find((s) => s.itemId === l.line.itemId)?.onHand ?? 0 })),
    }));
  }

  async decidePr(user: AuthUser, id: string, approve: boolean, reason?: string) {
    const [pr] = await this.db.select().from(purchaseRequests).where(and(eq(purchaseRequests.id, id), eq(purchaseRequests.facilityId, user.facilityId)));
    if (!pr) throw notFound('Permintaan pembelian', id);
    if (pr.status !== 'SUBMITTED') throw conflict('PR_NOT_PENDING', `Status PR ${pr.status}`);
    if (pr.requestedBy === user.id) throw forbidden('SELF_APPROVAL', 'Pemohon tidak boleh menyetujui permintaannya sendiri (segregation of duties)');
    const [row] = await this.db
      .update(purchaseRequests)
      .set(approve ? { status: 'APPROVED', approvedBy: user.id, approvedAt: new Date() } : { status: 'REJECTED', rejectReason: reason ?? 'Ditolak' })
      .where(eq(purchaseRequests.id, id))
      .returning();
    return row;
  }

  /* ------------------------------ Purchase Order ------------------------------ */

  async createPo(user: AuthUser, input: z.infer<typeof PoSchema>) {
    const today = await this.facility.today(user.facilityId);
    if (input.prId) {
      const [pr] = await this.db.select().from(purchaseRequests).where(and(eq(purchaseRequests.id, input.prId), eq(purchaseRequests.facilityId, user.facilityId)));
      if (!pr || pr.status !== 'APPROVED') throw invalid('PR_NOT_APPROVED', 'PO hanya dapat dibuat dari PR yang disetujui');
    }
    const subtotal = sum(input.items.map((i) => i.quantity * i.unitPrice));
    const tax = round2((subtotal * input.taxRate) / 100);
    return this.db.transaction(async (tx) => {
      const poNo = await this.seq.document(tx, user.facilityId, 'PO', today, '/');
      const [po] = await tx
        .insert(purchaseOrders)
        .values({ facilityId: user.facilityId, poNo, vendorId: input.vendorId, prId: input.prId ?? null, orderDate: today, expectedDate: input.expectedDate, subtotal, taxRate: input.taxRate, tax, total: round2(subtotal + tax), createdBy: user.id })
        .returning();
      await tx.insert(purchaseOrderItems).values(input.items.map((i) => ({ ...i, poId: po.id })));
      if (input.prId) await tx.update(purchaseRequests).set({ status: 'ORDERED' }).where(eq(purchaseRequests.id, input.prId));
      return po;
    });
  }

  async approvePo(user: AuthUser, id: string) {
    const [po] = await this.db.select().from(purchaseOrders).where(and(eq(purchaseOrders.id, id), eq(purchaseOrders.facilityId, user.facilityId)));
    if (!po) throw notFound('PO', id);
    if (po.status !== 'DRAFT') throw conflict('PO_NOT_DRAFT', `Status PO ${po.status}`);
    if (po.createdBy === user.id) throw forbidden('SELF_APPROVAL', 'Pembuat PO tidak boleh menyetujui PO-nya sendiri');
    const [row] = await this.db.update(purchaseOrders).set({ status: 'APPROVED', approvedBy: user.id, approvedAt: new Date() }).where(eq(purchaseOrders.id, id)).returning();
    return row;
  }

  async listPo(facilityId: string, status?: string) {
    const conds: SQL[] = [eq(purchaseOrders.facilityId, facilityId)];
    if (status) conds.push(inArray(purchaseOrders.status, status.split(',')));
    const pos = await this.db
      .select({ po: purchaseOrders, vendorName: vendors.name })
      .from(purchaseOrders)
      .innerJoin(vendors, eq(vendors.id, purchaseOrders.vendorId))
      .where(and(...conds))
      .orderBy(desc(purchaseOrders.createdAt));
    if (!pos.length) return [];
    const lines = await this.db
      .select({ line: purchaseOrderItems, itemName: items.name, uom: items.uom })
      .from(purchaseOrderItems)
      .innerJoin(items, eq(items.id, purchaseOrderItems.itemId))
      .where(inArray(purchaseOrderItems.poId, pos.map((p) => p.po.id)));
    return pos.map((p) => ({ ...p, items: lines.filter((l) => l.line.poId === p.po.id) }));
  }

  /* ------------------------------ Penerimaan ------------------------------ */

  /**
   * Penerimaan barang + inspeksi. Item lolos inspeksi masuk stok (batch/ED tercatat).
   * Jurnal: Dr Persediaan — Cr Utang Barang Diterima Belum Ditagih.
   */
  async receive(user: AuthUser, input: z.infer<typeof GrSchema>) {
    const today = await this.facility.today(user.facilityId);
    const [wh] = await this.db.select().from(warehouses).where(and(eq(warehouses.id, input.warehouseId), eq(warehouses.facilityId, user.facilityId)));
    if (!wh) throw notFound('Gudang', input.warehouseId);
    return this.db.transaction(async (tx) => {
      const [po] = await tx.select().from(purchaseOrders).where(and(eq(purchaseOrders.id, input.poId), eq(purchaseOrders.facilityId, user.facilityId))).for('update');
      if (!po) throw notFound('PO', input.poId);
      if (!['APPROVED', 'PARTIAL'].includes(po.status)) throw conflict('PO_NOT_RECEIVABLE', 'PO belum disetujui atau sudah diterima penuh');
      const poLines = await tx.select().from(purchaseOrderItems).where(eq(purchaseOrderItems.poId, po.id));

      const grNo = await this.seq.document(tx, user.facilityId, 'GR', today, '/');
      const [gr] = await tx.insert(goodsReceipts).values({ facilityId: user.facilityId, grNo, poId: po.id, warehouseId: wh.id, vendorDeliveryNo: input.vendorDeliveryNo, notes: input.notes, receivedBy: user.id }).returning();

      let accepted = 0;
      for (const it of input.items) {
        const line = poLines.find((l) => l.id === it.poItemId);
        if (!line) throw invalid('PO_ITEM_INVALID', 'Item tidak ada pada PO');
        if (it.expiryDate <= today) throw invalid('EXPIRED_ON_RECEIPT', `Batch ${it.batchNo} sudah kedaluwarsa`);
        const accQty = it.inspectionPassed ? it.quantity : 0;
        if (round2(line.receivedQty + accQty) > line.quantity) throw invalid('OVER_RECEIPT', 'Jumlah diterima melebihi jumlah PO');
        await tx.insert(goodsReceiptItems).values({ grId: gr.id, poItemId: line.id, itemId: line.itemId, batchNo: it.batchNo, expiryDate: it.expiryDate, quantity: it.quantity, unitPrice: line.unitPrice, inspectionPassed: it.inspectionPassed });
        if (accQty > 0) {
          await this.inventory.receive(tx, { facilityId: user.facilityId, warehouseId: wh.id, itemId: line.itemId, batchNo: it.batchNo, expiryDate: it.expiryDate, quantity: accQty, unitCost: line.unitPrice, type: 'RECEIPT', refType: 'GOODS_RECEIPT', refId: gr.id, userId: user.id });
          await tx.update(purchaseOrderItems).set({ receivedQty: round2(line.receivedQty + accQty) }).where(eq(purchaseOrderItems.id, line.id));
          line.receivedQty = round2(line.receivedQty + accQty);
          accepted = round2(accepted + accQty * line.unitPrice);
        }
      }
      const complete = poLines.every((l) => l.receivedQty >= l.quantity);
      await tx.update(purchaseOrders).set({ status: complete ? 'RECEIVED' : 'PARTIAL' }).where(eq(purchaseOrders.id, po.id));
      await tx.update(goodsReceipts).set({ totalValue: accepted }).where(eq(goodsReceipts.id, gr.id));
      if (accepted > 0) {
        await this.ledger.post(
          tx,
          user.facilityId,
          { date: today, description: `Penerimaan ${grNo} atas ${po.poNo}`, sourceType: 'GOODS_RECEIPT', sourceId: gr.id, lines: [{ accountCode: ACC.PERSEDIAAN_FARMASI, debit: accepted }, { accountCode: ACC.UTANG_BELUM_DITAGIH, credit: accepted }] },
          user.id,
        );
      }
      return { ...gr, totalValue: accepted, poStatus: complete ? 'RECEIVED' : 'PARTIAL' };
    });
  }

  listReceipts(facilityId: string) {
    return this.db
      .select({ gr: goodsReceipts, poNo: purchaseOrders.poNo, vendorName: vendors.name, warehouseName: warehouses.name })
      .from(goodsReceipts)
      .innerJoin(purchaseOrders, eq(purchaseOrders.id, goodsReceipts.poId))
      .innerJoin(vendors, eq(vendors.id, purchaseOrders.vendorId))
      .innerJoin(warehouses, eq(warehouses.id, goodsReceipts.warehouseId))
      .where(eq(goodsReceipts.facilityId, facilityId))
      .orderBy(desc(goodsReceipts.createdAt));
  }

  /* ------------------------------ Hutang usaha ------------------------------ */

  /**
   * Faktur pemasok dengan three-way match (PO × penerimaan × faktur).
   * Jurnal: Dr Utang Belum Ditagih + Dr PPN Masukan — Cr Utang Usaha.
   */
  async createApInvoice(user: AuthUser, input: z.infer<typeof ApInvoiceSchema>) {
    const [po] = await this.db
      .select({ po: purchaseOrders, vendor: vendors })
      .from(purchaseOrders)
      .innerJoin(vendors, eq(vendors.id, purchaseOrders.vendorId))
      .where(and(eq(purchaseOrders.id, input.poId), eq(purchaseOrders.facilityId, user.facilityId)));
    if (!po) throw notFound('PO', input.poId);
    const dup = await this.db.select({ id: apInvoices.id }).from(apInvoices).where(and(eq(apInvoices.vendorId, po.vendor.id), eq(apInvoices.invoiceNo, input.invoiceNo)));
    if (dup.length) throw conflict('AP_INVOICE_DUPLICATE', 'Nomor faktur pemasok sudah tercatat');

    const lines = await this.db.select().from(purchaseOrderItems).where(eq(purchaseOrderItems.poId, po.po.id));
    const receivedValue = sum(lines.map((l) => l.receivedQty * l.unitPrice));
    const [{ invoiced }] = await this.db.select({ invoiced: sql<string>`coalesce(sum(${apInvoices.subtotal}),0)` }).from(apInvoices).where(eq(apInvoices.poId, po.po.id));
    const uninvoiced = round2(receivedValue - Number(invoiced));
    const diff = Math.abs(input.subtotal - uninvoiced);
    if (uninvoiced <= 0 || diff > Math.max(1, uninvoiced * MATCH_TOLERANCE)) {
      throw invalid('THREE_WAY_MISMATCH', `Faktur tidak cocok dengan barang diterima (belum ditagih Rp ${uninvoiced}, faktur Rp ${input.subtotal})`, { receivedValue, alreadyInvoiced: Number(invoiced) });
    }
    const total = round2(input.subtotal + input.tax);
    const due = new Date(`${input.invoiceDate}T00:00:00Z`);
    due.setUTCDate(due.getUTCDate() + po.vendor.paymentTermDays);
    const today = await this.facility.today(user.facilityId);
    return this.db.transaction(async (tx) => {
      const [inv] = await tx
        .insert(apInvoices)
        .values({ facilityId: user.facilityId, vendorId: po.vendor.id, poId: po.po.id, invoiceNo: input.invoiceNo, invoiceDate: input.invoiceDate, dueDate: due.toISOString().slice(0, 10), subtotal: input.subtotal, tax: input.tax, total, matchStatus: 'MATCHED' })
        .returning();
      await this.ledger.post(
        tx,
        user.facilityId,
        {
          date: today,
          description: `Faktur ${input.invoiceNo} ${po.vendor.name} (${po.po.poNo})`,
          sourceType: 'AP_INVOICE',
          sourceId: inv.id,
          lines: [
            { accountCode: ACC.UTANG_BELUM_DITAGIH, debit: input.subtotal },
            { accountCode: ACC.PPN_MASUKAN, debit: input.tax },
            { accountCode: ACC.UTANG_USAHA, credit: total },
          ],
        },
        user.id,
      );
      return inv;
    });
  }

  listApInvoices(facilityId: string, status?: string) {
    const conds: SQL[] = [eq(apInvoices.facilityId, facilityId)];
    if (status) conds.push(inArray(apInvoices.status, status.split(',')));
    return this.db
      .select({ invoice: apInvoices, vendorName: vendors.name, poNo: purchaseOrders.poNo })
      .from(apInvoices)
      .innerJoin(vendors, eq(vendors.id, apInvoices.vendorId))
      .leftJoin(purchaseOrders, eq(purchaseOrders.id, apInvoices.poId))
      .where(and(...conds))
      .orderBy(apInvoices.dueDate);
  }

  /** Pembayaran hutang. Jurnal: Dr Utang Usaha — Cr Bank/Kas. */
  async payAp(user: AuthUser, id: string, input: z.infer<typeof ApPaymentSchema>) {
    const today = await this.facility.today(user.facilityId);
    return this.db.transaction(async (tx) => {
      const [inv] = await tx.select().from(apInvoices).where(and(eq(apInvoices.id, id), eq(apInvoices.facilityId, user.facilityId))).for('update');
      if (!inv) throw notFound('Faktur', id);
      const outstanding = round2(inv.total - inv.paidAmount);
      if (input.amount > outstanding) throw invalid('OVERPAYMENT', `Melebihi sisa hutang Rp ${outstanding}`);
      const [pay] = await tx.insert(apPayments).values({ ...input, facilityId: user.facilityId, apInvoiceId: id, paidBy: user.id }).returning();
      const paid = round2(inv.paidAmount + input.amount);
      await tx.update(apInvoices).set({ paidAmount: paid, status: paid >= inv.total ? 'PAID' : 'PARTIAL' }).where(eq(apInvoices.id, id));
      await this.ledger.post(
        tx,
        user.facilityId,
        { date: today, description: `Pembayaran faktur ${inv.invoiceNo}`, sourceType: 'AP_PAYMENT', sourceId: pay.id, lines: [{ accountCode: ACC.UTANG_USAHA, debit: input.amount }, { accountCode: input.method === 'TUNAI' ? ACC.KAS_KASIR : ACC.BANK, credit: input.amount }] },
        user.id,
      );
      return { ...pay, status: paid >= inv.total ? 'PAID' : 'PARTIAL' };
    });
  }

  /** Evaluasi vendor: ketepatan waktu kirim & tingkat penolakan inspeksi. */
  async vendorPerformance(facilityId: string) {
    const rows = await this.db
      .select({
        vendorId: vendors.id,
        vendorName: vendors.name,
        poCount: sql<number>`count(distinct ${purchaseOrders.id})::int`,
        receipts: sql<number>`count(distinct ${goodsReceipts.id})::int`,
        onTime: sql<number>`count(distinct ${goodsReceipts.id}) filter (where ${purchaseOrders.expectedDate} is null or ${goodsReceipts.createdAt}::date <= ${purchaseOrders.expectedDate})::int`,
        rejectedLines: sql<number>`count(${goodsReceiptItems.id}) filter (where ${goodsReceiptItems.inspectionPassed} = false)::int`,
        totalLines: sql<number>`count(${goodsReceiptItems.id})::int`,
      })
      .from(vendors)
      .leftJoin(purchaseOrders, eq(purchaseOrders.vendorId, vendors.id))
      .leftJoin(goodsReceipts, eq(goodsReceipts.poId, purchaseOrders.id))
      .leftJoin(goodsReceiptItems, eq(goodsReceiptItems.grId, goodsReceipts.id))
      .where(eq(vendors.facilityId, facilityId))
      .groupBy(vendors.id, vendors.name);
    return rows.map((r) => ({
      ...r,
      onTimeRate: r.receipts ? round2((r.onTime / r.receipts) * 100) : null,
      rejectRate: r.totalLines ? round2((r.rejectedLines / r.totalLines) * 100) : null,
    }));
  }
}

@Controller('procurement')
@AuditResource('Procurement')
export class ProcurementController {
  constructor(private readonly svc: ProcurementService) {}

  @Get('requests')
  @Permissions('procurement.read')
  listPr(@CurrentUser() u: AuthUser, @Query('status') status?: string) {
    return this.svc.listPr(u.facilityId, status);
  }

  @Post('requests')
  @Permissions('procurement.write', 'inventory.write')
  createPr(@CurrentUser() u: AuthUser, @Body(new ZodPipe(PrSchema)) body: z.infer<typeof PrSchema>) {
    return this.svc.createPr(u, body);
  }

  @Post('requests/:id/approve')
  @Permissions('procurement.approve')
  approvePr(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.svc.decidePr(u, id, true);
  }

  @Post('requests/:id/reject')
  @Permissions('procurement.approve')
  rejectPr(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body(new ZodPipe(z.object({ reason: z.string().min(3) }))) body: { reason: string }) {
    return this.svc.decidePr(u, id, false, body.reason);
  }

  @Get('orders')
  @Permissions('procurement.read')
  listPo(@CurrentUser() u: AuthUser, @Query('status') status?: string) {
    return this.svc.listPo(u.facilityId, status);
  }

  @Post('orders')
  @Permissions('procurement.write')
  createPo(@CurrentUser() u: AuthUser, @Body(new ZodPipe(PoSchema)) body: z.infer<typeof PoSchema>) {
    return this.svc.createPo(u, body);
  }

  @Post('orders/:id/approve')
  @Permissions('procurement.approve')
  approvePo(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.svc.approvePo(u, id);
  }

  @Get('receipts')
  @Permissions('procurement.read')
  receipts(@CurrentUser() u: AuthUser) {
    return this.svc.listReceipts(u.facilityId);
  }

  @Post('receipts')
  @Permissions('procurement.receive')
  receive(@CurrentUser() u: AuthUser, @Body(new ZodPipe(GrSchema)) body: z.infer<typeof GrSchema>) {
    return this.svc.receive(u, body);
  }

  @Get('ap-invoices')
  @Permissions('ap.write', 'finance.read')
  apInvoices(@CurrentUser() u: AuthUser, @Query('status') status?: string) {
    return this.svc.listApInvoices(u.facilityId, status);
  }

  @Post('ap-invoices')
  @Permissions('ap.write')
  createAp(@CurrentUser() u: AuthUser, @Body(new ZodPipe(ApInvoiceSchema)) body: z.infer<typeof ApInvoiceSchema>) {
    return this.svc.createApInvoice(u, body);
  }

  @Post('ap-invoices/:id/payments')
  @Permissions('ap.write')
  payAp(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body(new ZodPipe(ApPaymentSchema)) body: z.infer<typeof ApPaymentSchema>) {
    return this.svc.payAp(u, id, body);
  }

  @Get('vendor-performance')
  @Permissions('procurement.read')
  vendorPerformance(@CurrentUser() u: AuthUser) {
    return this.svc.vendorPerformance(u.facilityId);
  }
}

@Module({
  imports: [FinanceModule, InventoryModule],
  controllers: [ProcurementController],
  providers: [ProcurementService],
})
export class ProcurementModule {}
