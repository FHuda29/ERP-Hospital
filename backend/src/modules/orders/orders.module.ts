import { Body, Controller, Get, Inject, Injectable, Module, Param, Post, Query } from '@nestjs/common';
import { and, desc, eq, inArray, isNull, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { DB, type Db } from '../../database/database.js';
import { encounters, orders, patients, results, services, units } from '../../database/schema.js';
import { AuditResource, CurrentUser, Permissions, type AuthUser } from '../../common/auth.js';
import { conflict, forbidden, invalid, notFound } from '../../common/errors.js';
import { ZodPipe } from '../../common/zod.pipe.js';
import { CareAccessService } from '../../core/care-access.service.js';
import { FacilityService } from '../../core/core.module.js';
import { SequenceService } from '../../core/sequence.service.js';
import { BillingModule } from '../billing/billing.module.js';
import { ChargeService } from '../billing/charge.service.js';

const OrderSchema = z.object({
  encounterId: z.uuid(),
  items: z
    .array(
      z.object({
        serviceId: z.uuid(),
        priority: z.enum(['RUTIN', 'CITO']).default('RUTIN'),
        clinicalInfo: z.string().max(2000).optional(),
      }),
    )
    .min(1)
    .max(30),
});

const ObservationSchema = z.object({
  name: z.string().min(1),
  value: z.string().min(1),
  unit: z.string().optional(),
  referenceRange: z.string().optional(),
  flag: z.enum(['N', 'H', 'L', 'HH', 'LL', 'A']).optional(),
  loinc: z.string().optional(),
});
const ResultSchema = z.object({
  observations: z.array(ObservationSchema).default([]),
  conclusion: z.string().max(10000).optional(),
});

const CATEGORY_BY_SERVICE: Record<string, 'LAB' | 'RADIOLOGI' | 'TINDAKAN'> = {
  LAB: 'LAB',
  RADIOLOGI: 'RADIOLOGI',
  TINDAKAN: 'TINDAKAN',
  OPERASI: 'TINDAKAN',
};

@Injectable()
export class OrdersService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly seq: SequenceService,
    private readonly facility: FacilityService,
    private readonly chargesSvc: ChargeService,
    private readonly access: CareAccessService,
  ) {}

  /** CPOE — order penunjang dari dokter; satu order per layanan agar status & hasil tertelusur. */
  async create(user: AuthUser, input: z.infer<typeof OrderSchema>) {
    const [enc] = await this.db.select().from(encounters).where(and(eq(encounters.id, input.encounterId), eq(encounters.facilityId, user.facilityId)));
    if (!enc) throw notFound('Kunjungan', input.encounterId);
    await this.access.assertCanAccessPatient(user, enc.patientId);
    if (!['REGISTERED', 'TRIAGED', 'IN_PROGRESS'].includes(enc.status)) throw conflict('ENCOUNTER_CLOSED', 'Kunjungan sudah selesai');

    const svcRows = await this.db
      .select()
      .from(services)
      .where(and(eq(services.facilityId, user.facilityId), inArray(services.id, input.items.map((i) => i.serviceId))));
    const today = await this.facility.today(user.facilityId);
    return this.db.transaction(async (tx) => {
      const created = [];
      for (const item of input.items) {
        const svc = svcRows.find((s) => s.id === item.serviceId);
        if (!svc) throw notFound('Layanan', item.serviceId);
        const category = CATEGORY_BY_SERVICE[svc.category];
        if (!category) throw invalid('SERVICE_NOT_ORDERABLE', `${svc.name} bukan layanan penunjang/tindakan`);
        const orderNo = await this.seq.document(tx, user.facilityId, 'ORD', today);
        const [row] = await tx
          .insert(orders)
          .values({
            facilityId: user.facilityId,
            orderNo,
            encounterId: enc.id,
            patientId: enc.patientId,
            category,
            serviceId: svc.id,
            serviceName: svc.name,
            priority: item.priority,
            clinicalInfo: item.clinicalInfo,
            orderedBy: user.id,
            orderedByName: user.name,
          })
          .returning();
        created.push(row);
      }
      return { encounterId: enc.id, patientId: enc.patientId, orders: created };
    });
  }

  /** Worklist unit penunjang: CITO di atas. */
  async worklist(facilityId: string, category: string, status?: string) {
    const conds: SQL[] = [eq(orders.facilityId, facilityId), eq(orders.category, category)];
    conds.push(status ? inArray(orders.status, status.split(',')) : inArray(orders.status, ['ORDERED', 'IN_PROGRESS', 'RESULTED']));
    const rows = await this.db
      .select({
        order: orders,
        patientName: patients.name,
        mrn: patients.mrn,
        birthDate: patients.birthDate,
        gender: patients.gender,
        encounterNo: encounters.encounterNo,
        encounterType: encounters.type,
        unitName: units.name,
      })
      .from(orders)
      .innerJoin(patients, eq(patients.id, orders.patientId))
      .innerJoin(encounters, eq(encounters.id, orders.encounterId))
      .innerJoin(units, eq(units.id, encounters.unitId))
      .where(and(...conds))
      .orderBy(desc(orders.priority), orders.createdAt)
      .limit(300);
    const ids = rows.map((r) => r.order.id);
    const res = ids.length ? await this.db.select().from(results).where(inArray(results.orderId, ids)) : [];
    return rows.map((r) => ({ ...r, result: res.find((x) => x.orderId === r.order.id) ?? null }));
  }

  private async getOrder(facilityId: string, id: string) {
    const [o] = await this.db.select().from(orders).where(and(eq(orders.id, id), eq(orders.facilityId, facilityId)));
    if (!o) throw notFound('Order', id);
    return o;
  }

  /** Spesimen diambil / pemeriksaan dimulai. */
  async start(user: AuthUser, id: string) {
    const o = await this.getOrder(user.facilityId, id);
    if (o.status !== 'ORDERED') throw conflict('ORDER_NOT_STARTABLE', `Status order ${o.status}`);
    const [row] = await this.db.update(orders).set({ status: 'IN_PROGRESS' }).where(eq(orders.id, id)).returning();
    return row;
  }

  /** Input hasil. Flag HH/LL = nilai kritis → wajib dilaporkan & dikonfirmasi dokter. Charge diambil saat hasil keluar. */
  async submitResult(user: AuthUser, id: string, input: z.infer<typeof ResultSchema>) {
    const o = await this.getOrder(user.facilityId, id);
    if (!['ORDERED', 'IN_PROGRESS'].includes(o.status)) throw conflict('ORDER_NOT_RESULTABLE', `Status order ${o.status}`);
    if (!input.observations.length && !input.conclusion) throw invalid('RESULT_EMPTY', 'Hasil atau kesimpulan wajib diisi');
    const isCritical = input.observations.some((x) => x.flag === 'HH' || x.flag === 'LL');
    const today = await this.facility.today(user.facilityId);
    return this.db.transaction(async (tx) => {
      const [res] = await tx
        .insert(results)
        .values({ facilityId: user.facilityId, orderId: id, encounterId: o.encounterId, observations: input.observations, conclusion: input.conclusion, isCritical, resultedBy: user.id })
        .returning();
      await tx.update(orders).set({ status: 'RESULTED' }).where(eq(orders.id, id));
      const ctx = await this.chargesSvc.context(tx, user.facilityId, o.encounterId, user.id, today);
      await this.chargesSvc.addService(tx, ctx, o.serviceId, { sourceType: 'ORDER', sourceId: o.id, description: o.serviceName });
      return { ...res, patientId: o.patientId };
    });
  }

  /** Validasi hasil oleh petugas berbeda (dual control). */
  async verify(user: AuthUser, id: string) {
    const o = await this.getOrder(user.facilityId, id);
    if (o.status !== 'RESULTED') throw conflict('ORDER_NOT_RESULTED', 'Hasil belum diinput');
    const [res] = await this.db.select().from(results).where(eq(results.orderId, id));
    if (res.resultedBy === user.id) throw forbidden('SELF_VERIFICATION', 'Validasi hasil harus dilakukan petugas lain (dual control)');
    await this.db.update(results).set({ verifiedBy: user.id, verifiedAt: new Date() }).where(eq(results.id, res.id));
    const [row] = await this.db.update(orders).set({ status: 'VERIFIED' }).where(eq(orders.id, id)).returning();
    return { ...row, isCritical: res.isCritical };
  }

  /** Konfirmasi penerimaan nilai kritis oleh dokter. */
  async acknowledgeCritical(user: AuthUser, id: string) {
    const o = await this.getOrder(user.facilityId, id);
    await this.access.assertCanAccessPatient(user, o.patientId);
    const [res] = await this.db
      .update(results)
      .set({ criticalAckBy: user.id, criticalAckAt: new Date() })
      .where(and(eq(results.orderId, id), eq(results.isCritical, true), isNull(results.criticalAckAt)))
      .returning();
    if (!res) throw conflict('NO_UNACKED_CRITICAL', 'Tidak ada nilai kritis yang menunggu konfirmasi');
    return { ...res, patientId: o.patientId };
  }

  /** Hasil kritis yang belum dikonfirmasi — tampil di beranda dokter. */
  async pendingCritical(user: AuthUser) {
    const conds: SQL[] = [eq(results.facilityId, user.facilityId), eq(results.isCritical, true), isNull(results.criticalAckAt)];
    if (user.practitionerId && !user.roles.includes('ADMIN')) conds.push(eq(encounters.practitionerId, user.practitionerId));
    return this.db
      .select({ orderId: orders.id, orderNo: orders.orderNo, serviceName: orders.serviceName, patientName: patients.name, mrn: patients.mrn, encounterId: encounters.id, resultedAt: results.resultedAt, observations: results.observations })
      .from(results)
      .innerJoin(orders, eq(orders.id, results.orderId))
      .innerJoin(encounters, eq(encounters.id, results.encounterId))
      .innerJoin(patients, eq(patients.id, orders.patientId))
      .where(and(...conds));
  }

  async cancel(user: AuthUser, id: string, reason: string) {
    const o = await this.getOrder(user.facilityId, id);
    if (o.status !== 'ORDERED') throw conflict('ORDER_NOT_CANCELLABLE', 'Order yang sudah diproses tidak dapat dibatalkan');
    const [row] = await this.db.update(orders).set({ status: 'CANCELLED', cancelReason: reason }).where(eq(orders.id, id)).returning();
    return row;
  }
}

@Controller('orders')
@AuditResource('Order')
export class OrdersController {
  constructor(private readonly svc: OrdersService) {}

  @Post()
  @Permissions('order.write')
  create(@CurrentUser() u: AuthUser, @Body(new ZodPipe(OrderSchema)) body: z.infer<typeof OrderSchema>) {
    return this.svc.create(u, body);
  }

  @Get('worklist')
  @Permissions('order.process', 'order.write')
  worklist(@CurrentUser() u: AuthUser, @Query('category') category = 'LAB', @Query('status') status?: string) {
    return this.svc.worklist(u.facilityId, category, status);
  }

  @Get('critical')
  @Permissions('clinical.read')
  critical(@CurrentUser() u: AuthUser) {
    return this.svc.pendingCritical(u);
  }

  @Post(':id/start')
  @Permissions('order.process')
  start(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.svc.start(u, id);
  }

  @Post(':id/result')
  @Permissions('result.write', 'clinical.write')
  result(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body(new ZodPipe(ResultSchema)) body: z.infer<typeof ResultSchema>) {
    return this.svc.submitResult(u, id, body);
  }

  @Post(':id/verify')
  @Permissions('result.verify', 'clinical.sign')
  verify(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.svc.verify(u, id);
  }

  @Post(':id/acknowledge-critical')
  @Permissions('clinical.read')
  ack(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.svc.acknowledgeCritical(u, id);
  }

  @Post(':id/cancel')
  @Permissions('order.write')
  cancel(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body(new ZodPipe(z.object({ reason: z.string().min(5) }))) body: { reason: string }) {
    return this.svc.cancel(u, id, body.reason);
  }
}

@Module({
  imports: [BillingModule],
  controllers: [OrdersController],
  providers: [OrdersService],
})
export class OrdersModule {}
