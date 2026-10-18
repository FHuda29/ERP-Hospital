import { Body, Controller, Get, Inject, Injectable, Module, Param, Post, Query } from '@nestjs/common';
import { and, asc, desc, eq, gt, ilike, lte, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { DB, type Db, type DbOrTx } from '../../database/database.js';
import { items, stockBatches, stockMovements, warehouses } from '../../database/schema.js';
import { AuditResource, CurrentUser, Permissions, type AuthUser } from '../../common/auth.js';
import { conflict, invalid, notFound } from '../../common/errors.js';
import { round2 } from '../../common/util.js';
import { ZodPipe, zDate } from '../../common/zod.pipe.js';
import { FacilityService } from '../../core/core.module.js';
import { FinanceModule } from '../finance/finance.module.js';
import { LedgerService } from '../finance/ledger.service.js';
import { ACC } from '../finance/coa.js';

const AdjustmentSchema = z.object({
  batchId: z.uuid(),
  /** Positif = penambahan (selisih lebih), negatif = pengurangan (rusak/hilang/stock opname) */
  quantityDelta: z.number().refine((n) => n !== 0, 'Tidak boleh 0'),
  reason: z.string().min(5),
});

const TransferSchema = z.object({
  fromWarehouseId: z.uuid(),
  toWarehouseId: z.uuid(),
  itemId: z.uuid(),
  quantity: z.number().positive(),
});

const OpeningSchema = z.object({
  warehouseId: z.uuid(),
  itemId: z.uuid(),
  batchNo: z.string().min(1),
  expiryDate: zDate,
  quantity: z.number().positive(),
  unitCost: z.number().nonnegative(),
});

export interface ConsumedBatch {
  batchId: string;
  batchNo: string;
  expiryDate: string;
  quantity: number;
  unitCost: number;
}

@Injectable()
export class InventoryService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly ledger: LedgerService,
    private readonly facility: FacilityService,
  ) {}

  /**
   * Pengeluaran stok FEFO (First Expired First Out). Batch kedaluwarsa tidak pernah dikeluarkan.
   * Mengembalikan rincian batch & total HPP.
   */
  async consumeFefo(
    tx: DbOrTx,
    p: { facilityId: string; warehouseId: string; itemId: string; quantity: number; type: string; refType: string; refId: string; userId: string; today: string },
  ): Promise<{ cost: number; batches: ConsumedBatch[] }> {
    const batches = await tx
      .select()
      .from(stockBatches)
      .where(
        and(
          eq(stockBatches.warehouseId, p.warehouseId),
          eq(stockBatches.itemId, p.itemId),
          gt(stockBatches.qtyOnHand, 0),
          gt(stockBatches.expiryDate, p.today),
        ),
      )
      .orderBy(asc(stockBatches.expiryDate), asc(stockBatches.createdAt))
      .for('update');
    const available = batches.reduce((s, b) => s + b.qtyOnHand, 0);
    if (available < p.quantity) {
      const [item] = await tx.select({ name: items.name }).from(items).where(eq(items.id, p.itemId));
      throw conflict('INSUFFICIENT_STOCK', `Stok ${item?.name ?? p.itemId} tidak cukup (tersedia ${available}, diminta ${p.quantity})`);
    }
    let remaining = p.quantity;
    let cost = 0;
    const used: ConsumedBatch[] = [];
    for (const b of batches) {
      if (remaining <= 0) break;
      const take = Math.min(remaining, b.qtyOnHand);
      await tx.update(stockBatches).set({ qtyOnHand: round2(b.qtyOnHand - take) }).where(eq(stockBatches.id, b.id));
      await tx.insert(stockMovements).values({
        facilityId: p.facilityId,
        warehouseId: p.warehouseId,
        itemId: p.itemId,
        batchId: b.id,
        type: p.type,
        quantity: -take,
        unitCost: b.unitCost,
        refType: p.refType,
        refId: p.refId,
        createdBy: p.userId,
      });
      used.push({ batchId: b.id, batchNo: b.batchNo, expiryDate: b.expiryDate, quantity: take, unitCost: b.unitCost });
      cost += take * b.unitCost;
      remaining = round2(remaining - take);
    }
    return { cost: round2(cost), batches: used };
  }

  /** Penerimaan stok ke batch (dibuat bila belum ada). Harga pokok batch = rata-rata tertimbang. */
  async receive(
    tx: DbOrTx,
    p: { facilityId: string; warehouseId: string; itemId: string; batchNo: string; expiryDate: string; quantity: number; unitCost: number; type: string; refType: string; refId: string | null; userId: string },
  ) {
    const [existing] = await tx
      .select()
      .from(stockBatches)
      .where(and(eq(stockBatches.warehouseId, p.warehouseId), eq(stockBatches.itemId, p.itemId), eq(stockBatches.batchNo, p.batchNo)))
      .for('update');
    let batchId: string;
    if (existing) {
      if (existing.expiryDate !== p.expiryDate) throw invalid('BATCH_EXPIRY_MISMATCH', `Batch ${p.batchNo} sudah tercatat dengan ED ${existing.expiryDate}`);
      const newQty = round2(existing.qtyOnHand + p.quantity);
      const avgCost = newQty > 0 ? round2((existing.qtyOnHand * existing.unitCost + p.quantity * p.unitCost) / newQty) : p.unitCost;
      await tx.update(stockBatches).set({ qtyOnHand: newQty, unitCost: avgCost }).where(eq(stockBatches.id, existing.id));
      batchId = existing.id;
    } else {
      const [b] = await tx
        .insert(stockBatches)
        .values({ facilityId: p.facilityId, warehouseId: p.warehouseId, itemId: p.itemId, batchNo: p.batchNo, expiryDate: p.expiryDate, qtyOnHand: p.quantity, unitCost: p.unitCost })
        .returning();
      batchId = b.id;
    }
    await tx.insert(stockMovements).values({
      facilityId: p.facilityId,
      warehouseId: p.warehouseId,
      itemId: p.itemId,
      batchId,
      type: p.type,
      quantity: p.quantity,
      unitCost: p.unitCost,
      refType: p.refType,
      refId: p.refId,
      createdBy: p.userId,
    });
    return batchId;
  }

  async stock(facilityId: string, warehouseId?: string, q?: string) {
    const today = await this.facility.today(facilityId);
    const conds: SQL[] = [eq(items.facilityId, facilityId), eq(items.active, true)];
    if (q) conds.push(ilike(items.name, `%${q}%`));
    const joinOn = warehouseId
      ? and(eq(stockBatches.itemId, items.id), eq(stockBatches.warehouseId, warehouseId))
      : eq(stockBatches.itemId, items.id);
    return this.db
      .select({
        itemId: items.id,
        code: items.code,
        name: items.name,
        genericName: items.genericName,
        category: items.category,
        uom: items.uom,
        minStock: items.minStock,
        isHighAlert: items.isHighAlert,
        isNarcotic: items.isNarcotic,
        isFormulary: items.isFormulary,
        salePrice: items.salePrice,
        onHand: sql<number>`coalesce(sum(${stockBatches.qtyOnHand}) filter (where ${stockBatches.expiryDate} > ${today}), 0)::float`,
        expiredQty: sql<number>`coalesce(sum(${stockBatches.qtyOnHand}) filter (where ${stockBatches.expiryDate} <= ${today}), 0)::float`,
        nearestExpiry: sql<string | null>`min(${stockBatches.expiryDate}) filter (where ${stockBatches.qtyOnHand} > 0 and ${stockBatches.expiryDate} > ${today})`,
        value: sql<number>`coalesce(sum(${stockBatches.qtyOnHand} * ${stockBatches.unitCost}), 0)::float`,
      })
      .from(items)
      .leftJoin(stockBatches, joinOn)
      .where(and(...conds))
      .groupBy(items.id)
      .orderBy(items.name);
  }

  batches(facilityId: string, itemId: string) {
    return this.db
      .select({ batch: stockBatches, warehouseName: warehouses.name })
      .from(stockBatches)
      .innerJoin(warehouses, eq(warehouses.id, stockBatches.warehouseId))
      .where(and(eq(stockBatches.facilityId, facilityId), eq(stockBatches.itemId, itemId)))
      .orderBy(stockBatches.expiryDate);
  }

  /** Kartu stok (mutasi) per item. */
  stockCard(facilityId: string, itemId: string, warehouseId?: string) {
    const conds: SQL[] = [eq(stockMovements.facilityId, facilityId), eq(stockMovements.itemId, itemId)];
    if (warehouseId) conds.push(eq(stockMovements.warehouseId, warehouseId));
    return this.db
      .select({ movement: stockMovements, batchNo: stockBatches.batchNo, expiryDate: stockBatches.expiryDate, warehouseName: warehouses.name })
      .from(stockMovements)
      .innerJoin(stockBatches, eq(stockBatches.id, stockMovements.batchId))
      .innerJoin(warehouses, eq(warehouses.id, stockMovements.warehouseId))
      .where(and(...conds))
      .orderBy(desc(stockMovements.createdAt))
      .limit(500);
  }

  /** Peringatan: stok di bawah minimum, mendekati kedaluwarsa (≤90 hari), sudah kedaluwarsa. */
  async alerts(facilityId: string) {
    const today = await this.facility.today(facilityId);
    const stock = await this.stock(facilityId);
    const lowStock = stock.filter((s) => s.onHand < s.minStock);
    const expiring = await this.db
      .select({ batch: stockBatches, itemName: items.name, warehouseName: warehouses.name })
      .from(stockBatches)
      .innerJoin(items, eq(items.id, stockBatches.itemId))
      .innerJoin(warehouses, eq(warehouses.id, stockBatches.warehouseId))
      .where(and(eq(stockBatches.facilityId, facilityId), gt(stockBatches.qtyOnHand, 0), lte(stockBatches.expiryDate, sql`(${today}::date + 90)`)))
      .orderBy(stockBatches.expiryDate);
    return {
      lowStock,
      expiringSoon: expiring.filter((e) => e.batch.expiryDate > today),
      expired: expiring.filter((e) => e.batch.expiryDate <= today),
    };
  }

  /** Penyesuaian stok (stock opname/rusak). Jurnal: Persediaan ↔ Beban selisih persediaan. */
  async adjust(user: AuthUser, input: z.infer<typeof AdjustmentSchema>) {
    const today = await this.facility.today(user.facilityId);
    return this.db.transaction(async (tx) => {
      const [b] = await tx.select().from(stockBatches).where(and(eq(stockBatches.id, input.batchId), eq(stockBatches.facilityId, user.facilityId))).for('update');
      if (!b) throw notFound('Batch', input.batchId);
      const newQty = round2(b.qtyOnHand + input.quantityDelta);
      if (newQty < 0) throw invalid('NEGATIVE_STOCK', 'Stok tidak boleh negatif');
      await tx.update(stockBatches).set({ qtyOnHand: newQty }).where(eq(stockBatches.id, b.id));
      const [mv] = await tx
        .insert(stockMovements)
        .values({ facilityId: user.facilityId, warehouseId: b.warehouseId, itemId: b.itemId, batchId: b.id, type: 'ADJUSTMENT', quantity: input.quantityDelta, unitCost: b.unitCost, notes: input.reason, createdBy: user.id })
        .returning();
      const value = round2(Math.abs(input.quantityDelta) * b.unitCost);
      if (value > 0) {
        const plus = input.quantityDelta > 0;
        await this.ledger.post(
          tx,
          user.facilityId,
          {
            date: today,
            description: `Penyesuaian stok batch ${b.batchNo}: ${input.reason}`,
            sourceType: 'STOCK_ADJUSTMENT',
            sourceId: mv.id,
            lines: [
              { accountCode: ACC.PERSEDIAAN_FARMASI, debit: plus ? value : 0, credit: plus ? 0 : value },
              { accountCode: ACC.BEBAN_PERSEDIAAN, debit: plus ? 0 : value, credit: plus ? value : 0 },
            ],
          },
          user.id,
        );
      }
      return { ...mv, qtyOnHand: newQty };
    });
  }

  /** Mutasi antar gudang (mis. gudang utama → depo farmasi), batch & ED ikut terbawa. */
  async transfer(user: AuthUser, input: z.infer<typeof TransferSchema>) {
    if (input.fromWarehouseId === input.toWarehouseId) throw invalid('SAME_WAREHOUSE', 'Gudang asal dan tujuan sama');
    const today = await this.facility.today(user.facilityId);
    const whs = await this.db.select().from(warehouses).where(eq(warehouses.facilityId, user.facilityId));
    if (!whs.find((w) => w.id === input.fromWarehouseId) || !whs.find((w) => w.id === input.toWarehouseId)) throw notFound('Gudang');
    return this.db.transaction(async (tx) => {
      const refId = crypto.randomUUID();
      const out = await this.consumeFefo(tx, { facilityId: user.facilityId, warehouseId: input.fromWarehouseId, itemId: input.itemId, quantity: input.quantity, type: 'TRANSFER_OUT', refType: 'TRANSFER', refId, userId: user.id, today });
      for (const b of out.batches) {
        await this.receive(tx, { facilityId: user.facilityId, warehouseId: input.toWarehouseId, itemId: input.itemId, batchNo: b.batchNo, expiryDate: b.expiryDate, quantity: b.quantity, unitCost: b.unitCost, type: 'TRANSFER_IN', refType: 'TRANSFER', refId, userId: user.id });
      }
      return { transferId: refId, batches: out.batches };
    });
  }

  /** Saldo awal (migrasi/go-live). Jurnal: Persediaan — Ekuitas. */
  async opening(user: AuthUser, input: z.infer<typeof OpeningSchema>) {
    const today = await this.facility.today(user.facilityId);
    return this.db.transaction(async (tx) => {
      const batchId = await this.receive(tx, { ...input, facilityId: user.facilityId, type: 'ADJUSTMENT', refType: 'OPENING', refId: null, userId: user.id });
      const value = round2(input.quantity * input.unitCost);
      if (value > 0) {
        await this.ledger.post(
          tx,
          user.facilityId,
          { date: today, description: `Saldo awal persediaan batch ${input.batchNo}`, sourceType: 'OPENING_STOCK', sourceId: batchId, lines: [{ accountCode: ACC.PERSEDIAAN_FARMASI, debit: value }, { accountCode: ACC.EKUITAS, credit: value }] },
          user.id,
        );
      }
      return { batchId };
    });
  }
}

@Controller('inventory')
@AuditResource('Inventory')
export class InventoryController {
  constructor(private readonly svc: InventoryService) {}

  @Get('stock')
  @Permissions('inventory.read', 'rx.write')
  stock(@CurrentUser() u: AuthUser, @Query('warehouseId') warehouseId?: string, @Query('q') q?: string) {
    return this.svc.stock(u.facilityId, warehouseId, q);
  }

  @Get('alerts')
  @Permissions('inventory.read')
  alerts(@CurrentUser() u: AuthUser) {
    return this.svc.alerts(u.facilityId);
  }

  @Get('items/:id/batches')
  @Permissions('inventory.read')
  batches(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.svc.batches(u.facilityId, id);
  }

  @Get('items/:id/stock-card')
  @Permissions('inventory.read')
  card(@CurrentUser() u: AuthUser, @Param('id') id: string, @Query('warehouseId') warehouseId?: string) {
    return this.svc.stockCard(u.facilityId, id, warehouseId);
  }

  @Post('adjustments')
  @Permissions('inventory.write')
  adjust(@CurrentUser() u: AuthUser, @Body(new ZodPipe(AdjustmentSchema)) body: z.infer<typeof AdjustmentSchema>) {
    return this.svc.adjust(u, body);
  }

  @Post('transfers')
  @Permissions('inventory.write')
  transfer(@CurrentUser() u: AuthUser, @Body(new ZodPipe(TransferSchema)) body: z.infer<typeof TransferSchema>) {
    return this.svc.transfer(u, body);
  }

  @Post('opening')
  @Permissions('inventory.write')
  opening(@CurrentUser() u: AuthUser, @Body(new ZodPipe(OpeningSchema)) body: z.infer<typeof OpeningSchema>) {
    return this.svc.opening(u, body);
  }
}

@Module({
  imports: [FinanceModule],
  controllers: [InventoryController],
  providers: [InventoryService],
  exports: [InventoryService],
})
export class InventoryModule {}
