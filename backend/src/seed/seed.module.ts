import { Inject, Injectable, Logger, Module, OnApplicationBootstrap } from '@nestjs/common';
import bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { DB, type Db } from '../database/database.js';
import {
  accounts,
  beds,
  costCenters,
  drugInteractions,
  facilities,
  icd10,
  icd9cm,
  items,
  patientAllergies,
  patients,
  payers,
  practitionerSchedules,
  practitioners,
  rooms,
  services,
  tariffs,
  units,
  users,
  vendors,
  warehouses,
} from '../database/schema.js';
import { APP_CONFIG } from '../core/tokens.js';
import { CryptoService } from '../core/crypto.service.js';
import { SequenceService } from '../core/sequence.service.js';
import { FacilityService } from '../core/core.module.js';
import type { AppConfig } from '../config.js';
import { ACC, DEFAULT_COA } from '../modules/finance/coa.js';
import { FinanceModule } from '../modules/finance/finance.module.js';
import { LedgerService } from '../modules/finance/ledger.service.js';
import { InventoryModule, InventoryService } from '../modules/inventory/inventory.module.js';
import { ICD10, ICD9CM, INTERACTIONS, ITEMS, SERVICES } from './reference-data.js';

export const DEMO_FACILITY_CODE = 'RSDEMO';
export const DEMO_PASSWORD = 'Simrs2026!';

const REVENUE_BY_CATEGORY: Record<string, string> = {
  ADMINISTRASI: ACC.PDP_ADMINISTRASI,
  KONSULTASI: ACC.PDP_KONSULTASI,
  VISITE: ACC.PDP_KONSULTASI,
  AKOMODASI: ACC.PDP_AKOMODASI,
  LAB: ACC.PDP_LAB,
  RADIOLOGI: ACC.PDP_RADIOLOGI,
  TINDAKAN: ACC.PDP_TINDAKAN,
  OPERASI: ACC.PDP_TINDAKAN,
};

/** Seed referensi global (idempoten) + fasilitas demo bila SEED_DEMO=true. */
@Injectable()
export class SeedService implements OnApplicationBootstrap {
  private readonly logger = new Logger('Seed');

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly crypto: CryptoService,
    private readonly seq: SequenceService,
    private readonly ledger: LedgerService,
    private readonly inventory: InventoryService,
    private readonly facility: FacilityService,
  ) {}

  async onApplicationBootstrap() {
    await this.seedReference();
    if (this.config.seedDemo) await this.seedDemo();
  }

  async seedReference() {
    await this.db.insert(icd10).values(ICD10.map(([code, display, displayId]) => ({ code, display, displayId }))).onConflictDoNothing();
    await this.db.insert(icd9cm).values(ICD9CM.map(([code, display]) => ({ code, display }))).onConflictDoNothing();
    const [anyInteraction] = await this.db.select({ id: drugInteractions.id }).from(drugInteractions).limit(1);
    if (!anyInteraction) {
      await this.db.insert(drugInteractions).values(INTERACTIONS.map(([genericA, genericB, severity, description]) => ({ genericA, genericB, severity, description })));
    }
  }

  async seedDemo(): Promise<string> {
    const [existing] = await this.db.select().from(facilities).where(eq(facilities.code, DEMO_FACILITY_CODE));
    if (existing) return existing.id;
    this.logger.log('Membuat fasilitas demo RSDEMO …');

    const [f] = await this.db
      .insert(facilities)
      .values({
        code: DEMO_FACILITY_CODE,
        name: 'RS Umum Demo Sehat Sejahtera',
        type: 'RS_UMUM',
        hospitalClass: 'C',
        kemkesCode: '3201000',
        bpjsPpkCode: '0301R001',
        address: 'Jl. Contoh Raya No. 1',
        city: 'Kota Demo',
        province: 'Jawa Barat',
        timezone: 'Asia/Jakarta',
        features: { inpatient: true, bpjs: true, satusehat: true, procurement: true },
      })
      .returning();
    const fid = f.id;

    await this.db.insert(accounts).values(DEFAULT_COA.map((a) => ({ ...a, facilityId: fid, normalBalance: a.type === 'ASSET' || a.type === 'EXPENSE' ? 'D' : 'C', isPostable: a.isPostable ?? true })));

    const unitDefs = [
      { code: 'POLI-UMUM', name: 'Poli Umum', type: 'POLI', bpjsPoliCode: 'UMU', queuePrefix: 'A' },
      { code: 'POLI-PD', name: 'Poli Penyakit Dalam', type: 'POLI', bpjsPoliCode: 'INT', queuePrefix: 'B' },
      { code: 'POLI-ANAK', name: 'Poli Anak', type: 'POLI', bpjsPoliCode: 'ANA', queuePrefix: 'C' },
      { code: 'POLI-OBG', name: 'Poli Kebidanan & Kandungan', type: 'POLI', bpjsPoliCode: 'OBG', queuePrefix: 'D' },
      { code: 'IGD', name: 'Instalasi Gawat Darurat', type: 'IGD', queuePrefix: 'E' },
      { code: 'RI-MELATI', name: 'Bangsal Melati', type: 'RAWAT_INAP' },
      { code: 'ICU', name: 'Intensive Care Unit', type: 'ICU' },
      { code: 'LAB', name: 'Laboratorium Klinik', type: 'LAB' },
      { code: 'RAD', name: 'Radiologi', type: 'RADIOLOGI' },
      { code: 'FARMASI', name: 'Instalasi Farmasi', type: 'FARMASI' },
      { code: 'KASIR', name: 'Kasir', type: 'KASIR' },
      { code: 'GUDANG', name: 'Gudang Logistik', type: 'GUDANG' },
      { code: 'RM', name: 'Rekam Medis', type: 'REKAM_MEDIS' },
      { code: 'ADMIN', name: 'Manajemen', type: 'ADMIN' },
    ];
    const unitRows = await this.db.insert(units).values(unitDefs.map((u) => ({ ...u, facilityId: fid }))).returning();
    const unit = (code: string) => unitRows.find((u) => u.code === code)!;

    await this.db.insert(costCenters).values(unitRows.map((u) => ({ facilityId: fid, code: u.code, name: u.name, unitId: u.id })));

    const roomDefs = [
      { unit: 'RI-MELATI', code: 'M-101', name: 'Melati 101', careClass: 'KELAS_1', beds: 2 },
      { unit: 'RI-MELATI', code: 'M-201', name: 'Melati 201', careClass: 'KELAS_2', beds: 3 },
      { unit: 'RI-MELATI', code: 'M-301', name: 'Melati 301', careClass: 'KELAS_3', beds: 4 },
      { unit: 'RI-MELATI', code: 'M-401', name: 'Melati 401 (KRIS)', careClass: 'KRIS', beds: 4 },
      { unit: 'RI-MELATI', code: 'M-VIP', name: 'Melati VIP', careClass: 'VIP', beds: 1 },
      { unit: 'ICU', code: 'ICU-1', name: 'ICU 1', careClass: 'ICU', beds: 2 },
    ];
    for (const r of roomDefs) {
      const [room] = await this.db.insert(rooms).values({ facilityId: fid, unitId: unit(r.unit).id, code: r.code, name: r.name, careClass: r.careClass }).returning();
      await this.db.insert(beds).values(Array.from({ length: r.beds }, (_, i) => ({ facilityId: fid, roomId: room.id, code: `${r.code}-${String.fromCharCode(65 + i)}` })));
    }

    const pr = await this.db
      .insert(practitioners)
      .values([
        { facilityId: fid, name: 'dr. Andi Wijaya, Sp.PD', profession: 'DOKTER_SPESIALIS', specialty: 'Penyakit Dalam', strNumber: 'STR-DEMO-0001', strExpiry: '2030-12-31', sipNumber: 'SIP-DEMO-0001', sipExpiry: '2028-12-31', bpjsDpjpCode: '10001' },
        { facilityId: fid, name: 'dr. Sari Lestari', profession: 'DOKTER', specialty: 'Umum', strNumber: 'STR-DEMO-0002', strExpiry: '2030-12-31', sipNumber: 'SIP-DEMO-0002', sipExpiry: '2028-12-31', bpjsDpjpCode: '10002' },
        { facilityId: fid, name: 'dr. Bima Pratama, Sp.A', profession: 'DOKTER_SPESIALIS', specialty: 'Anak', strNumber: 'STR-DEMO-0003', strExpiry: '2030-12-31', sipNumber: 'SIP-DEMO-0003', sipExpiry: '2028-12-31', bpjsDpjpCode: '10003' },
        { facilityId: fid, name: 'Ns. Budi Hartono, S.Kep', profession: 'PERAWAT', strNumber: 'STR-DEMO-0101', sipNumber: 'SIPP-DEMO-0101', sipExpiry: '2028-12-31' },
        { facilityId: fid, name: 'Ns. Rina Puspita, S.Kep', profession: 'PERAWAT', strNumber: 'STR-DEMO-0102', sipNumber: 'SIPP-DEMO-0102', sipExpiry: '2028-12-31' },
        { facilityId: fid, name: 'apt. Dewi Anggraini, S.Farm', profession: 'APOTEKER', strNumber: 'STRA-DEMO-0201', sipNumber: 'SIPA-DEMO-0201', sipExpiry: '2028-12-31' },
      ])
      .returning();
    const [drAndi, drSari, drBima, nsBudi, nsRina, aptDewi] = pr;

    const sched: (typeof practitionerSchedules.$inferInsert)[] = [];
    for (let d = 1; d <= 6; d++) {
      if (d <= 5) sched.push({ facilityId: fid, practitionerId: drAndi.id, unitId: unit('POLI-PD').id, dayOfWeek: d, startTime: '08:00', endTime: '12:00', quota: 30 });
      sched.push({ facilityId: fid, practitionerId: drSari.id, unitId: unit('POLI-UMUM').id, dayOfWeek: d, startTime: '08:00', endTime: '14:00', quota: 40 });
      if (d % 2 === 1) sched.push({ facilityId: fid, practitionerId: drBima.id, unitId: unit('POLI-ANAK').id, dayOfWeek: d, startTime: '13:00', endTime: '16:00', quota: 20 });
    }
    // Hari Minggu: poli umum tetap buka untuk demo
    sched.push({ facilityId: fid, practitionerId: drSari.id, unitId: unit('POLI-UMUM').id, dayOfWeek: 7, startTime: '08:00', endTime: '12:00', quota: 20 });
    await this.db.insert(practitionerSchedules).values(sched);

    const hash = await bcrypt.hash(DEMO_PASSWORD, 10);
    const userDefs: { username: string; fullName: string; roles: string[]; unit?: string; practitionerId?: string }[] = [
      { username: 'admin', fullName: 'Administrator Sistem', roles: ['ADMIN'], unit: 'ADMIN' },
      { username: 'direktur', fullName: 'Direktur Utama', roles: ['DIREKSI'], unit: 'ADMIN' },
      { username: 'dr.andi', fullName: drAndi.name, roles: ['DOKTER'], unit: 'POLI-PD', practitionerId: drAndi.id },
      { username: 'dr.sari', fullName: drSari.name, roles: ['DOKTER'], unit: 'IGD', practitionerId: drSari.id },
      { username: 'dr.bima', fullName: drBima.name, roles: ['DOKTER'], unit: 'POLI-ANAK', practitionerId: drBima.id },
      { username: 'ns.budi', fullName: nsBudi.name, roles: ['PERAWAT'], unit: 'RI-MELATI', practitionerId: nsBudi.id },
      { username: 'ns.rina', fullName: nsRina.name, roles: ['PERAWAT'], unit: 'RI-MELATI', practitionerId: nsRina.id },
      { username: 'admisi', fullName: 'Petugas Admisi', roles: ['ADMISI'] },
      { username: 'rekammedis', fullName: 'Petugas Rekam Medis', roles: ['REKAM_MEDIS'], unit: 'RM' },
      { username: 'apoteker', fullName: aptDewi.name, roles: ['FARMASI'], unit: 'FARMASI', practitionerId: aptDewi.id },
      { username: 'lab', fullName: 'Analis Laboratorium', roles: ['LAB'], unit: 'LAB' },
      { username: 'lab2', fullName: 'Penanggung Jawab Lab', roles: ['LAB'], unit: 'LAB' },
      { username: 'radiologi', fullName: 'Radiografer', roles: ['RADIOLOGI'], unit: 'RAD' },
      { username: 'kasir', fullName: 'Kasir Utama', roles: ['KASIR'], unit: 'KASIR' },
      { username: 'casemix', fullName: 'Petugas Casemix', roles: ['CASEMIX'] },
      { username: 'keuangan', fullName: 'Staf Akuntansi', roles: ['KEUANGAN'] },
      { username: 'gudang', fullName: 'Petugas Gudang', roles: ['GUDANG'], unit: 'GUDANG' },
      { username: 'pengadaan', fullName: 'Staf Pengadaan', roles: ['PENGADAAN'] },
      { username: 'mutu', fullName: 'Komite Mutu & Keselamatan Pasien', roles: ['MUTU'] },
    ];
    await this.db.insert(users).values(
      userDefs.map((u) => ({ facilityId: fid, username: u.username, fullName: u.fullName, roles: u.roles, passwordHash: hash, unitId: u.unit ? unit(u.unit).id : null, practitionerId: u.practitionerId ?? null })),
    );
    const [admin] = await this.db.select().from(users).where(eq(users.username, 'admin'));

    await this.db.insert(payers).values([
      { facilityId: fid, code: 'UMUM', name: 'Umum / Pribadi', type: 'UMUM', receivableAccount: ACC.PIUTANG_PASIEN },
      { facilityId: fid, code: 'BPJS', name: 'BPJS Kesehatan (JKN)', type: 'BPJS', receivableAccount: ACC.PIUTANG_BPJS },
      { facilityId: fid, code: 'ASR-SEHAT', name: 'Asuransi Sehat Sentosa (demo)', type: 'ASURANSI', receivableAccount: ACC.PIUTANG_ASURANSI },
      { facilityId: fid, code: 'PRS-MAJU', name: 'PT Maju Bersama (demo)', type: 'PERUSAHAAN', receivableAccount: ACC.PIUTANG_ASURANSI },
    ]);

    for (const s of SERVICES) {
      const [svc] = await this.db
        .insert(services)
        .values({ facilityId: fid, code: s.code, name: s.name, category: s.category, icd9cmCode: s.icd9 ?? null, loincCode: s.loinc ?? null, revenueAccount: REVENUE_BY_CATEGORY[s.category] })
        .returning();
      const priceRows = typeof s.prices === 'number' ? [{ careClass: null, price: s.prices }] : Object.entries(s.prices).map(([careClass, price]) => ({ careClass, price }));
      await this.db.insert(tariffs).values(priceRows.map((p) => ({ facilityId: fid, serviceId: svc.id, careClass: p.careClass, price: p.price, effectiveFrom: '2026-01-01' })));
    }

    const itemRows = await this.db
      .insert(items)
      .values(
        ITEMS.map((i) => ({
          facilityId: fid,
          code: i.code,
          name: i.name,
          genericName: i.generic,
          category: i.category,
          dosageForm: i.form ?? null,
          strength: i.strength ?? null,
          uom: i.uom,
          salePrice: i.price,
          minStock: i.min,
          isHighAlert: i.highAlert ?? false,
          isNarcotic: i.narcotic ?? false,
          isFormulary: i.formulary ?? true,
          kfaCode: i.kfa ?? null,
        })),
      )
      .returning();

    await this.db.insert(vendors).values([
      { facilityId: fid, code: 'PBF-01', name: 'PT Farma Nusantara Distribusi (demo)', npwp: '00.000.000.0-000.000', licenseNo: 'PBF-DEMO-001', paymentTermDays: 30 },
      { facilityId: fid, code: 'ALK-01', name: 'PT Alkes Sejahtera (demo)', npwp: '00.000.000.0-000.001', paymentTermDays: 45 },
    ]);

    const [, depo] = await this.db
      .insert(warehouses)
      .values([
        { facilityId: fid, code: 'GU', name: 'Gudang Utama', type: 'GUDANG_UTAMA', unitId: unit('GUDANG').id },
        { facilityId: fid, code: 'DF', name: 'Depo Farmasi', type: 'DEPO_FARMASI', unitId: unit('FARMASI').id },
      ])
      .returning();

    // Saldo awal persediaan (dua batch per item untuk demonstrasi FEFO)
    const today = await this.facility.today(fid);
    const plusDays = (d: number) => new Date(Date.parse(today) + d * 86_400_000).toISOString().slice(0, 10);
    let openingValue = 0;
    await this.db.transaction(async (tx) => {
      for (const it of itemRows) {
        const def = ITEMS.find((x) => x.code === it.code)!;
        const qty = Math.max(def.min * 2, 20);
        const nearExpiry = it.code === 'OB-AMX500';
        await this.inventory.receive(tx, { facilityId: fid, warehouseId: depo.id, itemId: it.id, batchNo: `${it.code}-A`, expiryDate: nearExpiry ? plusDays(60) : plusDays(400), quantity: Math.round(qty / 2), unitCost: def.cost, type: 'ADJUSTMENT', refType: 'OPENING', refId: null, userId: admin.id });
        await this.inventory.receive(tx, { facilityId: fid, warehouseId: depo.id, itemId: it.id, batchNo: `${it.code}-B`, expiryDate: plusDays(720), quantity: qty - Math.round(qty / 2), unitCost: def.cost, type: 'ADJUSTMENT', refType: 'OPENING', refId: null, userId: admin.id });
        openingValue += qty * def.cost;
      }
      await this.ledger.post(
        tx,
        fid,
        { date: today, description: 'Saldo awal persediaan (go-live)', sourceType: 'OPENING_STOCK', lines: [{ accountCode: ACC.PERSEDIAAN_FARMASI, debit: openingValue }, { accountCode: ACC.EKUITAS, credit: openingValue }] },
        admin.id,
      );
      await this.ledger.post(
        tx,
        fid,
        { date: today, description: 'Saldo awal kas & bank (go-live)', sourceType: 'OPENING_BALANCE', lines: [{ accountCode: ACC.KAS_KASIR, debit: 5_000_000 }, { accountCode: ACC.BANK, debit: 500_000_000 }, { accountCode: ACC.EKUITAS, credit: 505_000_000 }] },
        admin.id,
      );
    });

    // Pasien contoh (data fiktif)
    const demoPatients = [
      { nik: '3201010101800001', name: 'BUDI SANTOSO', birthDate: '1980-01-01', gender: 'L', phone: '081200000001', address: 'Jl. Melati No. 10', city: 'Kota Demo', bpjsNumber: '0001234567891', motherName: 'SITI' },
      { nik: '3201014505900002', name: 'SITI AMINAH', birthDate: '1990-05-05', gender: 'P', phone: '081200000002', address: 'Jl. Kenanga No. 5', city: 'Kota Demo', bpjsNumber: null, motherName: 'AISYAH' },
      { nik: '3201012012150003', name: 'ANDI PUTRA', birthDate: '2015-12-20', gender: 'L', phone: '081200000003', address: 'Jl. Mawar No. 3', city: 'Kota Demo', bpjsNumber: '0001234567893', motherName: 'RATNA' },
    ];
    for (const p of demoPatients) {
      const mrn = await this.seq.mrn(this.db, fid);
      const [row] = await this.db
        .insert(patients)
        .values({ ...p, facilityId: fid, mrn, nikEncrypted: this.crypto.encrypt(p.nik), nikHash: this.crypto.lookupHash(p.nik), nikLast4: p.nik.slice(-4) })
        .returning();
      if (p.name === 'SITI AMINAH') {
        await this.db.insert(patientAllergies).values({ facilityId: fid, patientId: row.id, substance: 'Amoxicillin', category: 'OBAT', reaction: 'Urtikaria, sesak', severity: 'BERAT', recordedBy: admin.id });
      }
    }
    this.logger.log(`Fasilitas demo siap. Login: kode ${DEMO_FACILITY_CODE}, user admin / ${DEMO_PASSWORD}`);
    return fid;
  }
}

@Module({
  imports: [FinanceModule, InventoryModule],
  providers: [SeedService],
  exports: [SeedService],
})
export class SeedModule {}
