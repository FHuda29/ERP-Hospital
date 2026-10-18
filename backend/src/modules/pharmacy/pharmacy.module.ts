import { Body, Controller, Get, Inject, Injectable, Module, Param, Post, Query } from '@nestjs/common';
import { and, desc, eq, inArray, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { DB, type Db, type DbOrTx } from '../../database/database.js';
import {
  drugInteractions,
  encounters,
  items,
  medicationAdministrations,
  patientAllergies,
  patients,
  payers,
  prescriptionItems,
  prescriptions,
  units,
  users,
  warehouses,
} from '../../database/schema.js';
import { AuditResource, CurrentUser, Permissions, type AuthUser } from '../../common/auth.js';
import { conflict, forbidden, invalid, notFound } from '../../common/errors.js';
import { round2 } from '../../common/util.js';
import { ZodPipe } from '../../common/zod.pipe.js';
import { CareAccessService } from '../../core/care-access.service.js';
import { FacilityService } from '../../core/core.module.js';
import { SequenceService } from '../../core/sequence.service.js';
import { BillingModule } from '../billing/billing.module.js';
import { ChargeService } from '../billing/charge.service.js';
import { FinanceModule } from '../finance/finance.module.js';
import { LedgerService } from '../finance/ledger.service.js';
import { ACC } from '../finance/coa.js';
import { InventoryModule, InventoryService } from '../inventory/inventory.module.js';

const RxItemSchema = z.object({
  itemId: z.uuid(),
  quantity: z.number().positive().max(10000),
  dose: z.string().min(1).max(64),
  frequency: z.string().min(1).max(64),
  route: z.enum(['ORAL', 'IV', 'IM', 'SC', 'TOPIKAL', 'INHALASI', 'SUBLINGUAL', 'REKTAL', 'TETES_MATA', 'TETES_TELINGA', 'LAINNYA']),
  durationDays: z.number().int().positive().max(365).optional(),
  instructions: z.string().max(500).optional(),
});
const RxSchema = z.object({
  encounterId: z.uuid(),
  items: z.array(RxItemSchema).min(1).max(30),
  notes: z.string().max(2000).optional(),
  /** Wajib bila ada peringatan berat (alergi, interaksi mayor, duplikasi) */
  overrideReason: z.string().min(10).optional(),
});
const MarSchema = z.object({
  prescriptionItemId: z.uuid(),
  status: z.enum(['GIVEN', 'HELD', 'REFUSED']),
  doseGiven: z.string().max(64).optional(),
  notes: z.string().max(1000).optional(),
  twoIdentifiersVerified: z.literal(true, { error: 'Verifikasi dua identitas pasien wajib dilakukan' }),
  doubleCheckedBy: z.uuid().optional(),
});

export interface SafetyAlert {
  type: 'ALERGI' | 'INTERAKSI' | 'DUPLIKASI' | 'HIGH_ALERT' | 'NARKOTIKA' | 'NON_FORMULARIUM';
  severity: 'BLOCK' | 'WARNING' | 'INFO';
  message: string;
}

const ACTIVE_RX = ['SUBMITTED', 'VERIFIED', 'DISPENSED'];

@Injectable()
export class PharmacyService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly seq: SequenceService,
    private readonly facility: FacilityService,
    private readonly inventory: InventoryService,
    private readonly chargesSvc: ChargeService,
    private readonly ledger: LedgerService,
    private readonly access: CareAccessService,
  ) {}

  /**
   * Clinical decision support: alergi, interaksi obat, duplikasi terapi, obat high-alert,
   * narkotika/psikotropika, dan obat non-formularium untuk pasien JKN.
   */
  async safetyCheck(db: DbOrTx, facilityId: string, encounterId: string, rxItems: { itemId: string }[]): Promise<SafetyAlert[]> {
    const [enc] = await db
      .select({ e: encounters, payerType: payers.type })
      .from(encounters)
      .innerJoin(payers, eq(payers.id, encounters.payerId))
      .where(and(eq(encounters.id, encounterId), eq(encounters.facilityId, facilityId)));
    if (!enc) throw notFound('Kunjungan', encounterId);
    const newItems = await db.select().from(items).where(and(eq(items.facilityId, facilityId), inArray(items.id, rxItems.map((i) => i.itemId))));
    if (newItems.length !== new Set(rxItems.map((i) => i.itemId)).size) throw invalid('ITEM_NOT_FOUND', 'Sebagian obat tidak ditemukan di formularium');

    const alerts: SafetyAlert[] = [];
    const norm = (s: string | null | undefined) => (s ?? '').toLowerCase().trim();

    const allergies = await db
      .select()
      .from(patientAllergies)
      .where(and(eq(patientAllergies.patientId, enc.e.patientId), eq(patientAllergies.active, true), eq(patientAllergies.category, 'OBAT')));
    for (const it of newItems) {
      for (const a of allergies) {
        const sub = norm(a.substance);
        if ([norm(it.genericName), norm(it.name)].some((n) => n && (n.includes(sub) || sub.includes(n)))) {
          alerts.push({ type: 'ALERGI', severity: 'BLOCK', message: `Pasien alergi ${a.substance} (${a.severity}${a.reaction ? `: ${a.reaction}` : ''}) — ${it.name}` });
        }
      }
    }

    // Obat aktif lain pada kunjungan yang sama
    const current = await db
      .select({ generic: items.genericName, name: items.name })
      .from(prescriptionItems)
      .innerJoin(prescriptions, eq(prescriptions.id, prescriptionItems.prescriptionId))
      .innerJoin(items, eq(items.id, prescriptionItems.itemId))
      .where(and(eq(prescriptions.encounterId, encounterId), inArray(prescriptions.status, ACTIVE_RX)));
    const newGenerics = newItems.map((i) => norm(i.genericName ?? i.name));
    const allGenerics = [...new Set([...newGenerics, ...current.map((c) => norm(c.generic ?? c.name))])];

    const seen = new Map<string, number>();
    for (const g of [...newGenerics, ...current.map((c) => norm(c.generic ?? c.name))]) seen.set(g, (seen.get(g) ?? 0) + 1);
    for (const [g, n] of seen) if (n > 1 && newGenerics.includes(g)) alerts.push({ type: 'DUPLIKASI', severity: 'BLOCK', message: `Duplikasi terapi: ${g}` });

    if (allGenerics.length > 1) {
      const inter = await db
        .select()
        .from(drugInteractions)
        .where(and(inArray(drugInteractions.genericA, allGenerics), inArray(drugInteractions.genericB, allGenerics)));
      for (const x of inter) {
        if (!newGenerics.includes(x.genericA) && !newGenerics.includes(x.genericB)) continue;
        alerts.push({
          type: 'INTERAKSI',
          severity: x.severity === 'MAJOR' ? 'BLOCK' : 'WARNING',
          message: `Interaksi ${x.severity.toLowerCase()} ${x.genericA} × ${x.genericB}: ${x.description}`,
        });
      }
    }

    for (const it of newItems) {
      if (it.isHighAlert) alerts.push({ type: 'HIGH_ALERT', severity: 'WARNING', message: `${it.name} obat high-alert — wajib double check saat pemberian` });
      if (it.isNarcotic) alerts.push({ type: 'NARKOTIKA', severity: 'INFO', message: `${it.name} narkotika/psikotropika — resep asli & pencatatan SIPNAP` });
      if (enc.payerType === 'BPJS' && !it.isFormulary) alerts.push({ type: 'NON_FORMULARIUM', severity: 'WARNING', message: `${it.name} non-Fornas — biaya ditanggung pasien` });
    }
    return alerts;
  }

  async check(user: AuthUser, encounterId: string, rxItems: { itemId: string }[]) {
    return { alerts: await this.safetyCheck(this.db, user.facilityId, encounterId, rxItems) };
  }

  async create(user: AuthUser, input: z.infer<typeof RxSchema>) {
    const [enc] = await this.db.select().from(encounters).where(and(eq(encounters.id, input.encounterId), eq(encounters.facilityId, user.facilityId)));
    if (!enc) throw notFound('Kunjungan', input.encounterId);
    await this.access.assertCanAccessPatient(user, enc.patientId);
    if (!['REGISTERED', 'TRIAGED', 'IN_PROGRESS'].includes(enc.status)) throw conflict('ENCOUNTER_CLOSED', 'Kunjungan sudah selesai');

    const alerts = await this.safetyCheck(this.db, user.facilityId, input.encounterId, input.items);
    if (alerts.some((a) => a.severity === 'BLOCK') && !input.overrideReason) {
      throw invalid('PRESCRIPTION_SAFETY_BLOCK', 'Resep memiliki peringatan keselamatan yang memerlukan alasan override', { alerts });
    }
    const itemRows = await this.db.select().from(items).where(inArray(items.id, input.items.map((i) => i.itemId)));
    const today = await this.facility.today(user.facilityId);
    return this.db.transaction(async (tx) => {
      const rxNo = await this.seq.document(tx, user.facilityId, 'RX', today);
      const [rx] = await tx
        .insert(prescriptions)
        .values({
          facilityId: user.facilityId,
          rxNo,
          encounterId: enc.id,
          patientId: enc.patientId,
          prescriberId: user.id,
          prescriberName: user.name,
          notes: input.notes,
          alerts,
          overrideReason: input.overrideReason ?? null,
        })
        .returning();
      const lines = await tx
        .insert(prescriptionItems)
        .values(input.items.map((i) => ({ ...i, prescriptionId: rx.id, itemName: itemRows.find((r) => r.id === i.itemId)!.name })))
        .returning();
      return { ...rx, items: lines };
    });
  }

  async list(facilityId: string, status?: string) {
    const conds: SQL[] = [eq(prescriptions.facilityId, facilityId)];
    conds.push(status ? inArray(prescriptions.status, status.split(',')) : inArray(prescriptions.status, ['SUBMITTED', 'VERIFIED']));
    const rows = await this.db
      .select({ rx: prescriptions, patientName: patients.name, mrn: patients.mrn, birthDate: patients.birthDate, encounterNo: encounters.encounterNo, encounterType: encounters.type, unitName: units.name, payerName: payers.name, payerType: payers.type })
      .from(prescriptions)
      .innerJoin(patients, eq(patients.id, prescriptions.patientId))
      .innerJoin(encounters, eq(encounters.id, prescriptions.encounterId))
      .innerJoin(units, eq(units.id, encounters.unitId))
      .innerJoin(payers, eq(payers.id, encounters.payerId))
      .where(and(...conds))
      .orderBy(prescriptions.createdAt)
      .limit(300);
    const ids = rows.map((r) => r.rx.id);
    const lines = ids.length ? await this.db.select().from(prescriptionItems).where(inArray(prescriptionItems.prescriptionId, ids)) : [];
    return rows.map((r) => ({ ...r, items: lines.filter((l) => l.prescriptionId === r.rx.id) }));
  }

  private async getRx(facilityId: string, id: string) {
    const [rx] = await this.db.select().from(prescriptions).where(and(eq(prescriptions.id, id), eq(prescriptions.facilityId, facilityId)));
    if (!rx) throw notFound('Resep', id);
    return rx;
  }

  /** Telaah resep oleh apoteker (kesesuaian administratif, farmasetik, klinis). */
  async verify(user: AuthUser, id: string, reviewNotes?: string) {
    const rx = await this.getRx(user.facilityId, id);
    if (rx.status !== 'SUBMITTED') throw conflict('RX_NOT_SUBMITTED', `Status resep ${rx.status}`);
    const [row] = await this.db
      .update(prescriptions)
      .set({ status: 'VERIFIED', verifiedBy: user.id, verifiedAt: new Date(), reviewNotes: reviewNotes ?? null })
      .where(eq(prescriptions.id, id))
      .returning();
    return row;
  }

  async reject(user: AuthUser, id: string, reason: string) {
    const rx = await this.getRx(user.facilityId, id);
    if (!['SUBMITTED', 'VERIFIED'].includes(rx.status)) throw conflict('RX_NOT_REJECTABLE', `Status resep ${rx.status}`);
    const [row] = await this.db.update(prescriptions).set({ status: 'REJECTED', reviewNotes: reason }).where(eq(prescriptions.id, id)).returning();
    return row;
  }

  /**
   * Dispensing: stok keluar FEFO dari depo farmasi, charge obat dibuat,
   * jurnal HPP: Dr HPP Obat — Cr Persediaan.
   */
  async dispense(user: AuthUser, id: string, warehouseId?: string) {
    const rx = await this.getRx(user.facilityId, id);
    if (rx.status !== 'VERIFIED') throw conflict('RX_NOT_VERIFIED', 'Resep harus ditelaah apoteker sebelum diserahkan');
    const today = await this.facility.today(user.facilityId);
    let whId = warehouseId;
    if (!whId) {
      const [wh] = await this.db.select().from(warehouses).where(and(eq(warehouses.facilityId, user.facilityId), eq(warehouses.type, 'DEPO_FARMASI'))).limit(1);
      if (!wh) throw invalid('NO_PHARMACY_DEPOT', 'Depo farmasi belum dikonfigurasi');
      whId = wh.id;
    }
    return this.db.transaction(async (tx) => {
      const [locked] = await tx.select().from(prescriptions).where(eq(prescriptions.id, id)).for('update');
      if (locked.status !== 'VERIFIED') throw conflict('RX_NOT_VERIFIED', 'Resep sudah diproses');
      const lines = await tx.select().from(prescriptionItems).where(eq(prescriptionItems.prescriptionId, id));
      const ctx = await this.chargesSvc.context(tx, user.facilityId, rx.encounterId, user.id, today);
      let totalCost = 0;
      const dispensed = [];
      for (const line of lines) {
        const [item] = await tx.select().from(items).where(eq(items.id, line.itemId));
        const out = await this.inventory.consumeFefo(tx, { facilityId: user.facilityId, warehouseId: whId, itemId: line.itemId, quantity: line.quantity, type: 'DISPENSE', refType: 'PRESCRIPTION_ITEM', refId: line.id, userId: user.id, today });
        await tx.update(prescriptionItems).set({ dispensedQty: line.quantity }).where(eq(prescriptionItems.id, line.id));
        await this.chargesSvc.addItem(tx, ctx, item, line.quantity, out.cost, line.id);
        totalCost = round2(totalCost + out.cost);
        dispensed.push({ itemName: line.itemName, quantity: line.quantity, batches: out.batches });
      }
      if (totalCost > 0) {
        await this.ledger.post(
          tx,
          user.facilityId,
          { date: today, description: `HPP resep ${rx.rxNo}`, sourceType: 'DISPENSE', sourceId: rx.id, lines: [{ accountCode: ACC.HPP_FARMASI, debit: totalCost }, { accountCode: ACC.PERSEDIAAN_FARMASI, credit: totalCost }] },
          user.id,
        );
      }
      await tx.update(prescriptions).set({ status: 'DISPENSED', dispensedBy: user.id, dispensedAt: new Date() }).where(eq(prescriptions.id, id));
      return { id, status: 'DISPENSED', patientId: rx.patientId, totalCost, dispensed };
    });
  }

  /** eMAR: daftar obat aktif pasien rawat inap + riwayat pemberian. */
  async mar(user: AuthUser, encounterId: string) {
    const [enc] = await this.db.select().from(encounters).where(and(eq(encounters.id, encounterId), eq(encounters.facilityId, user.facilityId)));
    if (!enc) throw notFound('Kunjungan', encounterId);
    await this.access.assertCanAccessPatient(user, enc.patientId);
    const lines = await this.db
      .select({ line: prescriptionItems, rxNo: prescriptions.rxNo, rxStatus: prescriptions.status, isHighAlert: items.isHighAlert })
      .from(prescriptionItems)
      .innerJoin(prescriptions, eq(prescriptions.id, prescriptionItems.prescriptionId))
      .innerJoin(items, eq(items.id, prescriptionItems.itemId))
      .where(and(eq(prescriptions.encounterId, encounterId), eq(prescriptions.status, 'DISPENSED')));
    const admins = await this.db
      .select({ admin: medicationAdministrations, nurse: users.fullName })
      .from(medicationAdministrations)
      .innerJoin(users, eq(users.id, medicationAdministrations.administeredBy))
      .where(eq(medicationAdministrations.encounterId, encounterId))
      .orderBy(desc(medicationAdministrations.administeredAt));
    return lines.map((l) => ({ ...l, administrations: admins.filter((a) => a.admin.prescriptionItemId === l.line.id) }));
  }

  /** Pencatatan pemberian obat (closed-loop): 2 identitas + double-check untuk high-alert. */
  async administer(user: AuthUser, input: z.infer<typeof MarSchema>) {
    const [row] = await this.db
      .select({ line: prescriptionItems, rx: prescriptions, item: items })
      .from(prescriptionItems)
      .innerJoin(prescriptions, eq(prescriptions.id, prescriptionItems.prescriptionId))
      .innerJoin(items, eq(items.id, prescriptionItems.itemId))
      .where(and(eq(prescriptionItems.id, input.prescriptionItemId), eq(prescriptions.facilityId, user.facilityId)));
    if (!row) throw notFound('Item resep', input.prescriptionItemId);
    await this.access.assertCanAccessPatient(user, row.rx.patientId);
    if (row.rx.status !== 'DISPENSED') throw conflict('RX_NOT_DISPENSED', 'Obat belum diserahkan farmasi');
    if (row.item.isHighAlert && input.status === 'GIVEN') {
      if (!input.doubleCheckedBy) throw invalid('DOUBLE_CHECK_REQUIRED', `${row.item.name} adalah obat high-alert: wajib double check perawat kedua`);
      if (input.doubleCheckedBy === user.id) throw forbidden('DOUBLE_CHECK_SELF', 'Double check harus oleh perawat lain');
      const [checker] = await this.db.select({ id: users.id }).from(users).where(and(eq(users.id, input.doubleCheckedBy), eq(users.facilityId, user.facilityId), eq(users.active, true)));
      if (!checker) throw invalid('DOUBLE_CHECKER_INVALID', 'Petugas double check tidak valid');
    }
    const [admin] = await this.db
      .insert(medicationAdministrations)
      .values({ ...input, facilityId: user.facilityId, encounterId: row.rx.encounterId, administeredBy: user.id })
      .returning();
    return { ...admin, patientId: row.rx.patientId };
  }

  /** Daftar petugas klinis untuk pilihan double-check. */
  async clinicalStaff(facilityId: string) {
    const rows = await this.db.select({ id: users.id, fullName: users.fullName, roles: users.roles }).from(users).where(and(eq(users.facilityId, facilityId), eq(users.active, true)));
    return rows.filter((r) => r.roles.some((x) => ['PERAWAT', 'BIDAN', 'DOKTER', 'FARMASI'].includes(x)));
  }
}

@Controller('pharmacy')
@AuditResource('Pharmacy')
export class PharmacyController {
  constructor(private readonly svc: PharmacyService) {}

  @Post('prescriptions/check')
  @Permissions('rx.write')
  check(@CurrentUser() u: AuthUser, @Body(new ZodPipe(z.object({ encounterId: z.uuid(), items: z.array(z.object({ itemId: z.uuid() })).min(1) }))) body: { encounterId: string; items: { itemId: string }[] }) {
    return this.svc.check(u, body.encounterId, body.items);
  }

  @Post('prescriptions')
  @Permissions('rx.write')
  create(@CurrentUser() u: AuthUser, @Body(new ZodPipe(RxSchema)) body: z.infer<typeof RxSchema>) {
    return this.svc.create(u, body);
  }

  @Get('prescriptions')
  @Permissions('rx.verify', 'rx.dispense')
  list(@CurrentUser() u: AuthUser, @Query('status') status?: string) {
    return this.svc.list(u.facilityId, status);
  }

  @Post('prescriptions/:id/verify')
  @Permissions('rx.verify')
  verify(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body(new ZodPipe(z.object({ reviewNotes: z.string().optional() }))) body: { reviewNotes?: string }) {
    return this.svc.verify(u, id, body.reviewNotes);
  }

  @Post('prescriptions/:id/reject')
  @Permissions('rx.verify')
  reject(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body(new ZodPipe(z.object({ reason: z.string().min(5) }))) body: { reason: string }) {
    return this.svc.reject(u, id, body.reason);
  }

  @Post('prescriptions/:id/dispense')
  @Permissions('rx.dispense')
  dispense(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body(new ZodPipe(z.object({ warehouseId: z.uuid().optional() }))) body: { warehouseId?: string }) {
    return this.svc.dispense(u, id, body.warehouseId);
  }

  @Get('encounters/:id/mar')
  @Permissions('emar.write', 'clinical.read')
  mar(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.svc.mar(u, id);
  }

  @Post('mar')
  @Permissions('emar.write')
  administer(@CurrentUser() u: AuthUser, @Body(new ZodPipe(MarSchema)) body: z.infer<typeof MarSchema>) {
    return this.svc.administer(u, body);
  }

  @Get('staff')
  @Permissions('emar.write')
  staff(@CurrentUser() u: AuthUser) {
    return this.svc.clinicalStaff(u.facilityId);
  }
}

@Module({
  imports: [BillingModule, FinanceModule, InventoryModule],
  controllers: [PharmacyController],
  providers: [PharmacyService],
})
export class PharmacyModule {}
