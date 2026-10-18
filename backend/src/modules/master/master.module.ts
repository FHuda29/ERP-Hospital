import { Body, Controller, Get, Inject, Injectable, Module, Param, Patch, Post, Query } from '@nestjs/common';
import { and, asc, eq, gte, ilike, isNull, lte, or, sql, type SQL } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import { DB, type Db, type DbOrTx } from '../../database/database.js';
import {
  beds,
  facilities,
  icd10,
  icd9cm,
  items,
  payers,
  practitionerSchedules,
  practitioners,
  rooms,
  services,
  tariffs,
  units,
  vendors,
  warehouses,
} from '../../database/schema.js';
import { AuditResource, CurrentUser, Permissions, type AuthUser } from '../../common/auth.js';
import { invalid, notFound } from '../../common/errors.js';
import { ZodPipe, zDate } from '../../common/zod.pipe.js';
import { FacilityService } from '../../core/core.module.js';
import { CryptoService } from '../../core/crypto.service.js';

/* ------------------------------- Skema DTO ------------------------------- */

const UnitSchema = z.object({
  code: z.string().min(1).max(32),
  name: z.string().min(2),
  type: z.enum(['POLI', 'IGD', 'RAWAT_INAP', 'ICU', 'OK', 'LAB', 'RADIOLOGI', 'FARMASI', 'KASIR', 'GUDANG', 'ADMIN', 'REKAM_MEDIS']),
  bpjsPoliCode: z.string().max(16).nullish(),
  satusehatLocationId: z.string().nullish(),
  queuePrefix: z.string().max(4).nullish(),
  active: z.boolean().optional(),
});
const CARE_CLASSES = ['KRIS', 'VVIP', 'VIP', 'KELAS_1', 'KELAS_2', 'KELAS_3', 'ICU', 'ISOLASI'] as const;
const RoomSchema = z.object({ unitId: z.uuid(), code: z.string().min(1), name: z.string().min(1), careClass: z.enum(CARE_CLASSES) });
const BedSchema = z.object({ roomId: z.uuid(), code: z.string().min(1), status: z.enum(['AVAILABLE', 'CLEANING', 'MAINTENANCE']).optional() });
const PractitionerSchema = z.object({
  name: z.string().min(2),
  profession: z.enum(['DOKTER', 'DOKTER_SPESIALIS', 'DOKTER_GIGI', 'PERAWAT', 'BIDAN', 'APOTEKER', 'TTK', 'ANALIS', 'RADIOGRAFER', 'NUTRISIONIS']),
  specialty: z.string().nullish(),
  nik: z.string().regex(/^\d{16}$/).optional(),
  strNumber: z.string().nullish(),
  strExpiry: zDate.nullish(),
  sipNumber: z.string().nullish(),
  sipExpiry: zDate.nullish(),
  satusehatId: z.string().nullish(),
  bpjsDpjpCode: z.string().nullish(),
  phone: z.string().nullish(),
  active: z.boolean().optional(),
});
const ScheduleSchema = z.object({
  practitionerId: z.uuid(),
  unitId: z.uuid(),
  dayOfWeek: z.number().int().min(1).max(7),
  startTime: z.string().regex(/^\d{2}:\d{2}$/),
  endTime: z.string().regex(/^\d{2}:\d{2}$/),
  quota: z.number().int().min(1).max(500),
});
const PayerSchema = z.object({
  code: z.string().min(1),
  name: z.string().min(2),
  type: z.enum(['UMUM', 'BPJS', 'ASURANSI', 'PERUSAHAAN', 'JAMKESDA']),
  receivableAccount: z.string(),
  active: z.boolean().optional(),
});
const ServiceSchema = z.object({
  code: z.string().min(1),
  name: z.string().min(2),
  category: z.enum(['KONSULTASI', 'TINDAKAN', 'LAB', 'RADIOLOGI', 'AKOMODASI', 'ADMINISTRASI', 'VISITE', 'OPERASI']),
  icd9cmCode: z.string().nullish(),
  loincCode: z.string().nullish(),
  revenueAccount: z.string(),
  active: z.boolean().optional(),
});
const TariffSchema = z.object({
  serviceId: z.uuid(),
  payerType: z.enum(['UMUM', 'BPJS', 'ASURANSI', 'PERUSAHAAN', 'JAMKESDA']).nullish(),
  careClass: z.enum(CARE_CLASSES).nullish(),
  price: z.number().nonnegative(),
  effectiveFrom: zDate,
  effectiveTo: zDate.nullish(),
});
const ItemSchema = z.object({
  code: z.string().min(1),
  name: z.string().min(2),
  genericName: z.string().nullish(),
  kfaCode: z.string().nullish(),
  category: z.enum(['OBAT', 'ALKES', 'BMHP']),
  dosageForm: z.string().nullish(),
  strength: z.string().nullish(),
  uom: z.string().min(1),
  isHighAlert: z.boolean().optional(),
  isNarcotic: z.boolean().optional(),
  isFormulary: z.boolean().optional(),
  salePrice: z.number().nonnegative(),
  minStock: z.number().nonnegative().optional(),
  active: z.boolean().optional(),
});
const VendorSchema = z.object({
  code: z.string().min(1),
  name: z.string().min(2),
  npwp: z.string().nullish(),
  licenseNo: z.string().nullish(),
  address: z.string().nullish(),
  phone: z.string().nullish(),
  paymentTermDays: z.number().int().min(0).max(365).optional(),
  active: z.boolean().optional(),
});
const WarehouseSchema = z.object({
  code: z.string().min(1),
  name: z.string().min(2),
  type: z.enum(['GUDANG_UTAMA', 'DEPO_FARMASI', 'DEPO_UNIT']),
  unitId: z.uuid().nullish(),
});
const FacilitySchema = z.object({
  name: z.string().min(2).optional(),
  hospitalClass: z.enum(['A', 'B', 'C', 'D']).nullish(),
  kemkesCode: z.string().nullish(),
  bpjsPpkCode: z.string().nullish(),
  satusehatOrgId: z.string().nullish(),
  address: z.string().nullish(),
  city: z.string().nullish(),
  province: z.string().nullish(),
  phone: z.string().nullish(),
  timezone: z.enum(['Asia/Jakarta', 'Asia/Makassar', 'Asia/Jayapura']).optional(),
  features: z.record(z.string(), z.boolean()).optional(),
});

/* ------------------------------- Service ------------------------------- */

type Entity = 'units' | 'rooms' | 'beds' | 'practitioners' | 'schedules' | 'payers' | 'services' | 'tariffs' | 'items' | 'vendors' | 'warehouses';

const TABLES: Record<Entity, { table: PgTable; schema: z.ZodObject; order: string }> = {
  units: { table: units, schema: UnitSchema, order: 'code' },
  rooms: { table: rooms, schema: RoomSchema, order: 'code' },
  beds: { table: beds, schema: BedSchema, order: 'code' },
  practitioners: { table: practitioners, schema: PractitionerSchema, order: 'name' },
  schedules: { table: practitionerSchedules, schema: ScheduleSchema, order: 'dayOfWeek' },
  payers: { table: payers, schema: PayerSchema, order: 'code' },
  services: { table: services, schema: ServiceSchema, order: 'code' },
  tariffs: { table: tariffs, schema: TariffSchema, order: 'effectiveFrom' },
  items: { table: items, schema: ItemSchema, order: 'code' },
  vendors: { table: vendors, schema: VendorSchema, order: 'code' },
  warehouses: { table: warehouses, schema: WarehouseSchema, order: 'code' },
};

@Injectable()
export class MasterService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly crypto: CryptoService,
    private readonly facility: FacilityService,
  ) {}

  /* eslint-disable @typescript-eslint/no-explicit-any */
  async list(entity: Entity, facilityId: string, q?: string) {
    const { table, order } = TABLES[entity];
    const t = table as any;
    const conds: SQL[] = [eq(t.facilityId, facilityId)];
    if (q && t.name) conds.push(or(ilike(t.name, `%${q}%`), t.code ? ilike(t.code, `%${q}%`) : sql`false`)!);
    const rows = await (this.db.select().from(table) as any).where(and(...conds)).orderBy(asc(t[order])).limit(1000);
    if (entity === 'practitioners') return rows.map((r: any) => ({ ...r, nikEncrypted: undefined, hasNik: !!r.nikEncrypted }));
    return rows;
  }

  async create(entity: Entity, facilityId: string, body: unknown) {
    const { table, schema } = TABLES[entity];
    const data: any = new ZodPipe(schema).transform(body);
    await this.assertRefs(facilityId, data);
    if (entity === 'practitioners' && data.nik) {
      data.nikEncrypted = this.crypto.encrypt(data.nik);
      delete data.nik;
    }
    const [row] = await (this.db.insert(table) as any).values({ ...data, facilityId }).returning();
    return row;
  }

  async update(entity: Entity, facilityId: string, id: string, body: unknown) {
    const { table, schema } = TABLES[entity];
    const data: any = new ZodPipe(schema.partial()).transform(body);
    await this.assertRefs(facilityId, data);
    if (entity === 'practitioners' && data.nik) {
      data.nikEncrypted = this.crypto.encrypt(data.nik);
      delete data.nik;
    }
    const t = table as any;
    const [row] = await (this.db.update(table) as any)
      .set(data)
      .where(and(eq(t.id, id), eq(t.facilityId, facilityId)))
      .returning();
    if (!row) throw notFound(entity, id);
    return row;
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */

  /** Pastikan referensi (unit/ruang/layanan/dst.) milik tenant yang sama. */
  private async assertRefs(facilityId: string, data: Record<string, unknown>) {
    const refs: [string, PgTable][] = [
      ['unitId', units],
      ['roomId', rooms],
      ['serviceId', services],
      ['practitionerId', practitioners],
    ];
    for (const [key, table] of refs) {
      const v = data[key];
      if (typeof v !== 'string') continue;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const t = table as any;
      const found = await this.db.select({ id: t.id }).from(table).where(and(eq(t.id, v), eq(t.facilityId, facilityId)));
      if (!found.length) throw invalid('REFERENCE_INVALID', `${key} tidak valid untuk fasilitas ini`);
    }
  }

  async getFacility(facilityId: string) {
    return this.facility.get(facilityId);
  }

  async updateFacility(facilityId: string, input: z.infer<typeof FacilitySchema>) {
    const [row] = await this.db.update(facilities).set(input).where(eq(facilities.id, facilityId)).returning();
    this.facility.invalidate(facilityId);
    return row;
  }

  searchIcd10(q: string) {
    return this.db
      .select()
      .from(icd10)
      .where(or(ilike(icd10.code, `${q}%`), ilike(icd10.display, `%${q}%`), ilike(icd10.displayId, `%${q}%`)))
      .orderBy(icd10.code)
      .limit(30);
  }

  searchIcd9(q: string) {
    return this.db
      .select()
      .from(icd9cm)
      .where(or(ilike(icd9cm.code, `${q}%`), ilike(icd9cm.display, `%${q}%`)))
      .orderBy(icd9cm.code)
      .limit(30);
  }

  /** Denah bed untuk bed management. */
  async bedBoard(facilityId: string) {
    return this.db
      .select({
        bedId: beds.id,
        bedCode: beds.code,
        status: beds.status,
        encounterId: beds.currentEncounterId,
        roomId: rooms.id,
        roomName: rooms.name,
        careClass: rooms.careClass,
        unitId: units.id,
        unitName: units.name,
      })
      .from(beds)
      .innerJoin(rooms, eq(rooms.id, beds.roomId))
      .innerJoin(units, eq(units.id, rooms.unitId))
      .where(eq(beds.facilityId, facilityId))
      .orderBy(units.name, rooms.name, beds.code);
  }
}

/**
 * Resolusi tarif: layanan × jenis penjamin × kelas rawat pada tanggal pelayanan.
 * Tarif paling spesifik menang (payer+kelas > payer > kelas > umum).
 */
@Injectable()
export class TariffService {
  async resolve(db: DbOrTx, facilityId: string, serviceId: string, payerType: string, careClass: string | null, onDate: string) {
    const rows = await db
      .select()
      .from(tariffs)
      .where(
        and(
          eq(tariffs.facilityId, facilityId),
          eq(tariffs.serviceId, serviceId),
          lte(tariffs.effectiveFrom, onDate),
          or(isNull(tariffs.effectiveTo), gte(tariffs.effectiveTo, onDate)),
          or(isNull(tariffs.payerType), eq(tariffs.payerType, payerType)),
          careClass ? or(isNull(tariffs.careClass), eq(tariffs.careClass, careClass)) : isNull(tariffs.careClass),
        ),
      );
    if (!rows.length) return null;
    const score = (t: (typeof rows)[number]) => (t.payerType ? 2 : 0) + (t.careClass ? 1 : 0);
    rows.sort((a, b) => score(b) - score(a) || b.effectiveFrom.localeCompare(a.effectiveFrom));
    return rows[0].price;
  }
}

/* ------------------------------- Controller ------------------------------- */

@Controller('master')
@AuditResource('MasterData')
export class MasterController {
  constructor(private readonly svc: MasterService) {}

  @Get('facility')
  facility(@CurrentUser() u: AuthUser) {
    return this.svc.getFacility(u.facilityId);
  }

  @Patch('facility')
  @Permissions('master.write')
  updateFacility(@CurrentUser() u: AuthUser, @Body(new ZodPipe(FacilitySchema)) body: z.infer<typeof FacilitySchema>) {
    return this.svc.updateFacility(u.facilityId, body);
  }

  @Get('icd10')
  icd10(@Query('q') q = '') {
    return this.svc.searchIcd10(q);
  }

  @Get('icd9cm')
  icd9(@Query('q') q = '') {
    return this.svc.searchIcd9(q);
  }

  @Get('bed-board')
  bedBoard(@CurrentUser() u: AuthUser) {
    return this.svc.bedBoard(u.facilityId);
  }

  @Get(':entity')
  list(@CurrentUser() u: AuthUser, @Param('entity') entity: string, @Query('q') q?: string) {
    return this.svc.list(this.entity(entity), u.facilityId, q);
  }

  @Post(':entity')
  @Permissions('master.write')
  create(@CurrentUser() u: AuthUser, @Param('entity') entity: string, @Body() body: unknown) {
    return this.svc.create(this.entity(entity), u.facilityId, body);
  }

  @Patch(':entity/:id')
  @Permissions('master.write')
  update(@CurrentUser() u: AuthUser, @Param('entity') entity: string, @Param('id') id: string, @Body() body: unknown) {
    return this.svc.update(this.entity(entity), u.facilityId, id, body);
  }

  private entity(e: string): Entity {
    if (!(e in TABLES)) throw notFound('Master data', e);
    return e as Entity;
  }
}

@Module({
  controllers: [MasterController],
  providers: [MasterService, TariffService],
  exports: [TariffService],
})
export class MasterModule {}
