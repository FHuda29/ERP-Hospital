import { Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { DbOrTx } from '../../database/database.js';
import { charges, encounters, items, payers, services } from '../../database/schema.js';
import { invalid, notFound } from '../../common/errors.js';
import { round2 } from '../../common/util.js';
import { TariffService } from '../master/master.module.js';
import { ACC } from '../finance/coa.js';

export type EncounterRow = typeof encounters.$inferSelect;
export type PayerRow = typeof payers.$inferSelect;

export interface ChargeContext {
  encounter: EncounterRow;
  payer: PayerRow;
  userId: string;
  onDate: string;
}

/**
 * Charge capture: setiap layanan/obat yang diberikan menghasilkan charge yang tertelusur
 * ke sumbernya (order, tindakan, dispensing, bed). Unique (source_type, source_id)
 * mencegah charge ganda.
 */
@Injectable()
export class ChargeService {
  constructor(private readonly tariffs: TariffService) {}

  async context(db: DbOrTx, facilityId: string, encounterId: string, userId: string, onDate: string): Promise<ChargeContext> {
    const [row] = await db
      .select({ encounter: encounters, payer: payers })
      .from(encounters)
      .innerJoin(payers, eq(payers.id, encounters.payerId))
      .where(and(eq(encounters.id, encounterId), eq(encounters.facilityId, facilityId)));
    if (!row) throw notFound('Kunjungan', encounterId);
    return { ...row, userId, onDate };
  }

  async addService(
    db: DbOrTx,
    ctx: ChargeContext,
    serviceId: string,
    opts: { quantity?: number; sourceType: string; sourceId?: string | null; description?: string; careClass?: string | null },
  ) {
    const { encounter, payer } = ctx;
    const [svc] = await db.select().from(services).where(and(eq(services.id, serviceId), eq(services.facilityId, encounter.facilityId)));
    if (!svc) throw notFound('Layanan', serviceId);
    const careClass = opts.careClass !== undefined ? opts.careClass : encounter.careClass;
    const price = await this.tariffs.resolve(db, encounter.facilityId, serviceId, payer.type, careClass, ctx.onDate);
    if (price === null) {
      throw invalid('TARIFF_NOT_FOUND', `Tarif ${svc.name} untuk penjamin ${payer.type}${careClass ? ` kelas ${careClass}` : ''} belum diatur`);
    }
    const quantity = opts.quantity ?? 1;
    const [row] = await db
      .insert(charges)
      .values({
        facilityId: encounter.facilityId,
        encounterId: encounter.id,
        patientId: encounter.patientId,
        serviceId,
        description: opts.description ?? svc.name,
        quantity,
        unitPrice: price,
        amount: round2(price * quantity),
        sourceType: opts.sourceType,
        sourceId: opts.sourceId ?? null,
        revenueAccount: svc.revenueAccount,
        billTo: payer.type === 'UMUM' ? 'PASIEN' : 'PENJAMIN',
        createdBy: ctx.userId,
      })
      .onConflictDoNothing()
      .returning();
    return row ?? null;
  }

  async addServiceByCode(db: DbOrTx, ctx: ChargeContext, code: string, opts: Parameters<ChargeService['addService']>[3]) {
    const [svc] = await db
      .select({ id: services.id })
      .from(services)
      .where(and(eq(services.facilityId, ctx.encounter.facilityId), eq(services.code, code)));
    if (!svc) throw invalid('SERVICE_CODE_NOT_CONFIGURED', `Layanan dengan kode ${code} belum dikonfigurasi di master tarif`);
    return this.addService(db, ctx, svc.id, opts);
  }

  /** Charge obat/BMHP. Obat non-formularium pada pasien JKN ditagihkan ke pasien. */
  async addItem(
    db: DbOrTx,
    ctx: ChargeContext,
    item: typeof items.$inferSelect,
    quantity: number,
    costAmount: number,
    sourceId: string,
  ) {
    const { encounter, payer } = ctx;
    const coveredByPayer = payer.type !== 'UMUM' && !(payer.type === 'BPJS' && !item.isFormulary);
    const [row] = await db
      .insert(charges)
      .values({
        facilityId: encounter.facilityId,
        encounterId: encounter.id,
        patientId: encounter.patientId,
        itemId: item.id,
        description: `${item.name}${item.strength ? ' ' + item.strength : ''}`,
        quantity,
        unitPrice: item.salePrice,
        amount: round2(item.salePrice * quantity),
        sourceType: 'DISPENSE',
        sourceId,
        revenueAccount: ACC.PDP_FARMASI,
        billTo: coveredByPayer ? 'PENJAMIN' : 'PASIEN',
        costAmount: round2(costAmount),
        createdBy: ctx.userId,
      })
      .onConflictDoNothing()
      .returning();
    return row ?? null;
  }
}
