/**
 * Uji end-to-end sesuai acceptance criteria blueprint (§15):
 * - Pendaftaran → pelayanan → order/hasil → farmasi → billing → pembayaran/klaim → jurnal
 *   untuk penjamin berbeda (Umum rawat jalan, BPJS rawat inap).
 * - Keselamatan klinis: alergi, interaksi, high-alert double check, hasil kritis, duplikasi pasien.
 * - Keamanan: RBAC, ABAC hubungan perawatan + break-glass, isolasi tenant, audit append-only.
 * - Integrasi: outbox SATUSEHAT, FHIR facade, idempotency.
 */
process.env.PGLITE_DIR = 'memory';
process.env.OUTBOX_WORKER = 'false';
process.env.SEED_DEMO = 'true';

import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import { sql } from 'drizzle-orm';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/main.js';
import { DB, type Db } from '../src/database/database.js';
import { facilities, users } from '../src/database/schema.js';
import { DEMO_PASSWORD } from '../src/seed/seed.module.js';

let app: INestApplication;
let db: Db;
const tokens: Record<string, string> = {};
const ids: Record<string, string> = {};

const http = () => request(app.getHttpServer());
const as = (user: string) => ({
  get: (url: string) => http().get(`/api/v1${url}`).set('Authorization', `Bearer ${tokens[user]}`),
  post: (url: string, body: object = {}) => http().post(`/api/v1${url}`).set('Authorization', `Bearer ${tokens[user]}`).send(body),
  patch: (url: string, body: object = {}) => http().patch(`/api/v1${url}`).set('Authorization', `Bearer ${tokens[user]}`).send(body),
});

async function login(username: string, facilityCode = 'RSDEMO', password = DEMO_PASSWORD) {
  const res = await http().post('/api/v1/auth/login').send({ facilityCode, username, password });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  tokens[username] = res.body.accessToken;
  return res.body;
}

function expectOk(res: request.Response, status = 201) {
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  return res.body;
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = configureApp(moduleRef.createNestApplication());
  await app.init();
  db = app.get(DB);
  for (const u of ['admin', 'admisi', 'dr.andi', 'dr.bima', 'ns.budi', 'ns.rina', 'apoteker', 'lab', 'lab2', 'kasir', 'casemix', 'keuangan', 'pengadaan', 'direktur', 'gudang']) {
    await login(u);
  }
  const units = (await as('admin').get('/master/units')).body as { id: string; code: string }[];
  for (const u of units) ids[`unit:${u.code}`] = u.id;
  const prs = (await as('admin').get('/master/practitioners')).body as { id: string; name: string }[];
  ids.drAndi = prs.find((p) => p.name.includes('Andi'))!.id;
  const payers = (await as('admin').get('/master/payers')).body as { id: string; code: string }[];
  for (const p of payers) ids[`payer:${p.code}`] = p.id;
  const items = (await as('admin').get('/master/items')).body as { id: string; code: string }[];
  for (const i of items) ids[`item:${i.code}`] = i.id;
  const services = (await as('admin').get('/master/services')).body as { id: string; code: string }[];
  for (const s of services) ids[`svc:${s.code}`] = s.id;
  const staff = (await as('admin').get('/users')).body as { id: string; username: string }[];
  for (const s of staff) ids[`user:${s.username}`] = s.id;
}, 120_000);

afterAll(async () => {
  await app?.close();
});

describe('Rawat jalan pasien UMUM: registrasi → klinis → lab → farmasi → kasir → jurnal', () => {
  it('mendaftarkan pasien baru & menolak duplikasi NIK', async () => {
    const body = { nik: '3271010101990011', name: 'Rahmat Hidayat', birthDate: '1999-01-01', gender: 'L', phone: '0812000099' };
    const p = expectOk(await as('admisi').post('/patients', body));
    expect(p.mrn).toMatch(/^\d{8}$/);
    expect(p.nikMasked).toBe('************0011');
    expect(p.nikEncrypted).toBeUndefined();
    ids.patientUmum = p.id;

    const dup = await as('admisi').post('/patients', { ...body, name: 'Rahmat H' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('DUPLICATE_PATIENT_NIK');

    const similar = await as('admisi').post('/patients', { name: 'Rahmat Hidayat', birthDate: '1999-01-01', gender: 'L' });
    expect(similar.body.error.code).toBe('POSSIBLE_DUPLICATE_PATIENT');

    const found = expectOk(await as('admisi').get('/patients?q=3271010101990011'), 200);
    expect(found[0].id).toBe(p.id);
  });

  it('registrasi rawat jalan menghasilkan nomor antrean & charge otomatis', async () => {
    const enc = expectOk(
      await as('admisi').post('/encounters', { patientId: ids.patientUmum, type: 'RAWAT_JALAN', unitId: ids['unit:POLI-PD'], practitionerId: ids.drAndi, payerId: ids['payer:UMUM'], chiefComplaint: 'Pusing' }),
    );
    expect(enc.encounterNo).toMatch(/^RJ\d{4}-\d{5}$/);
    expect(enc.queue.label).toMatch(/^B-\d{3}$/);
    ids.encUmum = enc.id;

    const again = await as('admisi').post('/encounters', { patientId: ids.patientUmum, type: 'RAWAT_JALAN', unitId: ids['unit:POLI-PD'], practitionerId: ids.drAndi, payerId: ids['payer:UMUM'] });
    expect(again.body.error.code).toBe('ACTIVE_ENCOUNTER_EXISTS');

    const bill = expectOk(await as('kasir').get(`/billing/encounters/${ids.encUmum}`), 200);
    expect(bill.totals.patient).toBe(25000 + 150000);
  });

  it('dokter mengisi SOAP, tanda vital (EWS), diagnosis ICD-10, dan order lab', async () => {
    const v = expectOk(await as('dr.andi').post(`/clinical/encounters/${ids.encUmum}/vitals`, { systolic: 170, diastolic: 100, heartRate: 88, respRate: 18, temperature: 36.7, spo2: 98 }));
    expect(v.ews).toBe(0);

    const note = expectOk(
      await as('dr.andi').post(`/clinical/encounters/${ids.encUmum}/notes`, { type: 'SOAP', subjective: 'Pusing 3 hari', objective: 'TD 170/100', assessment: 'Hipertensi', plan: 'Amlodipine 10 mg', signNow: true }),
    );
    expect(note.status).toBe('SIGNED');
    expect(note.signatureHash).toHaveLength(64);
    const edit = await as('dr.andi').patch(`/clinical/notes/${note.id}`, { plan: 'ubah' });
    expect(edit.body.error.code).toBe('NOTE_SIGNED');
    expectOk(await as('dr.andi').post(`/clinical/notes/${note.id}/amend`, { plan: 'Amlodipine 10 mg 1x1 pagi', reason: 'Koreksi aturan pakai' }));

    const bad = await as('dr.andi').post(`/clinical/encounters/${ids.encUmum}/diagnoses`, { icd10Code: 'XXX.9', rank: 'PRIMER' });
    expect(bad.body.error.code).toBe('ICD10_NOT_FOUND');
    expectOk(await as('dr.andi').post(`/clinical/encounters/${ids.encUmum}/diagnoses`, { icd10Code: 'I10', rank: 'PRIMER' }));

    const ord = expectOk(await as('dr.andi').post('/orders', { encounterId: ids.encUmum, items: [{ serviceId: ids['svc:LAB-ELEK'], priority: 'CITO' }] }));
    ids.orderLab = ord.orders[0].id;
  });

  it('lab: hasil kritis memerlukan validasi petugas lain & konfirmasi dokter', async () => {
    const wl = expectOk(await as('lab').get('/orders/worklist?category=LAB'), 200);
    expect(wl.some((w: { order: { id: string } }) => w.order.id === ids.orderLab)).toBe(true);
    expectOk(await as('lab').post(`/orders/${ids.orderLab}/start`));
    const res = expectOk(
      await as('lab').post(`/orders/${ids.orderLab}/result`, { observations: [{ name: 'Kalium', value: '6.8', unit: 'mmol/L', referenceRange: '3.5-5.1', flag: 'HH' }, { name: 'Natrium', value: '138', unit: 'mmol/L', flag: 'N' }] }),
    );
    expect(res.isCritical).toBe(true);

    const self = await as('lab').post(`/orders/${ids.orderLab}/verify`);
    expect(self.body.error.code).toBe('SELF_VERIFICATION');
    expectOk(await as('lab2').post(`/orders/${ids.orderLab}/verify`));

    const crit = expectOk(await as('dr.andi').get('/orders/critical'), 200);
    expect(crit.some((c: { orderId: string }) => c.orderId === ids.orderLab)).toBe(true);
    expectOk(await as('dr.andi').post(`/orders/${ids.orderLab}/acknowledge-critical`));
  });

  it('farmasi: telaah → dispensing FEFO mengurangi stok batch terdekat', async () => {
    const before = (expectOk(await as('apoteker').get('/inventory/stock?q=Amlodipine'), 200) as { onHand: number }[])[0].onHand;
    const rx = expectOk(
      await as('dr.andi').post('/pharmacy/prescriptions', { encounterId: ids.encUmum, items: [{ itemId: ids['item:OB-AML10'], quantity: 30, dose: '10 mg', frequency: '1x sehari', route: 'ORAL', durationDays: 30 }] }),
    );
    const notVerified = await as('apoteker').post(`/pharmacy/prescriptions/${rx.id}/dispense`);
    expect(notVerified.body.error.code).toBe('RX_NOT_VERIFIED');
    expectOk(await as('apoteker').post(`/pharmacy/prescriptions/${rx.id}/verify`, { reviewNotes: 'Telaah OK' }));
    const disp = expectOk(await as('apoteker').post(`/pharmacy/prescriptions/${rx.id}/dispense`));
    expect(disp.dispensed[0].batches[0].batchNo).toBe('OB-AML10-A');
    const after = (expectOk(await as('apoteker').get('/inventory/stock?q=Amlodipine'), 200) as { onHand: number }[])[0].onHand;
    expect(after).toBe(before - 30);
  });

  it('pulang → invoice pasien → pembayaran idempoten → jurnal seimbang', async () => {
    expectOk(await as('dr.andi').post(`/encounters/${ids.encUmum}/discharge`, { disposition: 'KONTROL' }));
    const gen = expectOk(await as('kasir').post(`/billing/encounters/${ids.encUmum}/invoices`));
    expect(gen.invoices).toHaveLength(1);
    const inv = gen.invoices[0];
    expect(inv.billTo).toBe('PASIEN');
    expect(inv.total).toBe(25000 + 150000 + 150000 + 30 * 700);

    const key = 'pay-' + inv.id;
    const pay1 = await http().post(`/api/v1/billing/invoices/${inv.id}/payments`).set('Authorization', `Bearer ${tokens.kasir}`).set('Idempotency-Key', key).send({ amount: inv.total, method: 'QRIS' });
    const pay2 = await http().post(`/api/v1/billing/invoices/${inv.id}/payments`).set('Authorization', `Bearer ${tokens.kasir}`).set('Idempotency-Key', key).send({ amount: inv.total, method: 'QRIS' });
    expectOk(pay1);
    expect(pay2.headers['idempotent-replay']).toBe('true');
    expect(pay2.body.id).toBe(pay1.body.id);
    expect(pay1.body.invoiceStatus).toBe('PAID');

    const tb = expectOk(await as('keuangan').get('/finance/reports/trial-balance'), 200);
    expect(tb.balanced).toBe(true);
    const lab = tb.lines.find((l: { code: string }) => l.code === '4-1300');
    expect(lab.balance).toBe(150000);
  });
});

describe('Rawat inap pasien BPJS: SEP → bed → eMAR → resume → klaim INA-CBG', () => {
  it('admisi rawat inap dengan SEP & bed', async () => {
    const [budi] = expectOk(await as('admisi').get('/patients?q=BUDI SANTOSO'), 200);
    ids.patientBpjs = budi.id;
    const board = expectOk(await as('admisi').get('/master/bed-board'), 200) as { bedId: string; status: string; careClass: string; unitName: string; unitId: string }[];
    const bed = board.find((b) => b.status === 'AVAILABLE' && b.careClass === 'KELAS_1')!;
    const enc = expectOk(
      await as('admisi').post('/encounters', { patientId: budi.id, type: 'RAWAT_INAP', unitId: bed.unitId, practitionerId: ids.drAndi, payerId: ids['payer:BPJS'], bedId: bed.bedId, initialDiagnosis: 'A91' }),
    );
    expect(enc.sepNumber).toBeTruthy();
    expect(enc.careClass).toBe('KELAS_1');
    ids.encBpjs = enc.id;
    ids.bedBpjs = bed.bedId;
    const after = expectOk(await as('admisi').get('/master/bed-board'), 200) as { bedId: string; status: string }[];
    expect(after.find((b) => b.bedId === bed.bedId)!.status).toBe('OCCUPIED');
  });

  it('peserta JKN nonaktif ditolak', async () => {
    const p = expectOk(await as('admisi').post('/patients', { name: 'Peserta Nonaktif', birthDate: '1970-02-02', gender: 'P', bpjsNumber: '0009999999990' }));
    const res = await as('admisi').post('/encounters', { patientId: p.id, type: 'RAWAT_JALAN', unitId: ids['unit:POLI-PD'], practitionerId: ids.drAndi, payerId: ids['payer:BPJS'] });
    expect(res.body.error.code).toBe('BPJS_NOT_ACTIVE');
  });

  it('resep dengan interaksi mayor diblokir tanpa alasan override', async () => {
    const items = [
      { itemId: ids['item:OB-WAR2'], quantity: 5, dose: '2 mg', frequency: '1x sehari', route: 'ORAL' },
      { itemId: ids['item:OB-ASA80'], quantity: 5, dose: '80 mg', frequency: '1x sehari', route: 'ORAL' },
    ];
    const blocked = await as('dr.andi').post('/pharmacy/prescriptions', { encounterId: ids.encBpjs, items });
    expect(blocked.body.error.code).toBe('PRESCRIPTION_SAFETY_BLOCK');
    expect(blocked.body.error.details.alerts.some((a: { type: string }) => a.type === 'INTERAKSI')).toBe(true);

    const rx = expectOk(await as('dr.andi').post('/pharmacy/prescriptions', { encounterId: ids.encBpjs, items, overrideReason: 'Indikasi AF + PJK, INR dimonitor ketat' }));
    expectOk(await as('apoteker').post(`/pharmacy/prescriptions/${rx.id}/verify`));
    expectOk(await as('apoteker').post(`/pharmacy/prescriptions/${rx.id}/dispense`));
    ids.warfarinLine = rx.items.find((i: { itemId: string }) => i.itemId === ids['item:OB-WAR2']).id;
  });

  it('eMAR: obat high-alert wajib double check perawat lain', async () => {
    const base = { prescriptionItemId: ids.warfarinLine, status: 'GIVEN', doseGiven: '2 mg', twoIdentifiersVerified: true };
    const noCheck = await as('ns.budi').post('/pharmacy/mar', base);
    expect(noCheck.body.error.code).toBe('DOUBLE_CHECK_REQUIRED');
    const self = await as('ns.budi').post('/pharmacy/mar', { ...base, doubleCheckedBy: ids['user:ns.budi'] });
    expect(self.body.error.code).toBe('DOUBLE_CHECK_SELF');
    const noId = await as('ns.budi').post('/pharmacy/mar', { ...base, twoIdentifiersVerified: false, doubleCheckedBy: ids['user:ns.rina'] });
    expect(noId.body.error.code).toBe('VALIDATION_FAILED');
    expectOk(await as('ns.budi').post('/pharmacy/mar', { ...base, doubleCheckedBy: ids['user:ns.rina'] }));
    const v = expectOk(await as('ns.budi').post(`/clinical/encounters/${ids.encBpjs}/vitals`, { systolic: 85, heartRate: 125, respRate: 26, temperature: 39.5, spo2: 91 }));
    expect(v.alert.level).toBe('MERAH');
  });

  it('pulang rawat inap wajib resume medis; charge akomodasi & visite terbentuk', async () => {
    expectOk(await as('dr.andi').post(`/clinical/encounters/${ids.encBpjs}/notes`, { type: 'CPPT', subjective: 'Demam hari ke-4', assessment: 'DBD', plan: 'Observasi trombosit', signNow: true }));
    expectOk(await as('dr.andi').post(`/clinical/encounters/${ids.encBpjs}/diagnoses`, { icd10Code: 'A91', rank: 'PRIMER' }));
    const noResume = await as('dr.andi').post(`/encounters/${ids.encBpjs}/discharge`, { disposition: 'PULANG' });
    expect(noResume.body.error.code).toBe('DISCHARGE_SUMMARY_REQUIRED');
    expectOk(await as('dr.andi').post(`/clinical/encounters/${ids.encBpjs}/notes`, { type: 'RESUME_MEDIS', assessment: 'DBD grade I, perbaikan', plan: 'Kontrol 1 minggu', signNow: true }));
    expectOk(await as('dr.andi').post(`/encounters/${ids.encBpjs}/discharge`, { disposition: 'PULANG' }));

    const bill = expectOk(await as('kasir').get(`/billing/encounters/${ids.encBpjs}`), 200);
    const types = bill.charges.map((c: { sourceType: string }) => c.sourceType);
    expect(types).toEqual(expect.arrayContaining(['ADMIN', 'BED', 'VISIT', 'DISPENSE']));
    expect(bill.totals.patient).toBe(0);
    const board = expectOk(await as('admisi').get('/master/bed-board'), 200) as { bedId: string; status: string }[];
    expect(board.find((b) => b.bedId === ids.bedBpjs)!.status).toBe('CLEANING');
  });

  it('klaim BPJS: coding INA-CBG → submit → disetujui → dibayar dengan selisih tarif', async () => {
    const gen = expectOk(await as('kasir').post(`/billing/encounters/${ids.encBpjs}/invoices`));
    const inv = gen.invoices[0];
    expect(inv.billTo).toBe('PENJAMIN');
    const payDirect = await as('kasir').post(`/billing/invoices/${inv.id}/payments`, { amount: 1000, method: 'TUNAI' });
    expect(payDirect.body.error.code).toBe('INVOICE_IS_PAYER_CLAIM');

    const claim = expectOk(await as('casemix').post('/claims', { encounterId: ids.encBpjs }));
    const noCbg = await as('casemix').post(`/claims/${claim.id}/code`, {});
    expect(noCbg.body.error.code).toBe('INACBG_REQUIRED');
    const coded = expectOk(await as('casemix').post(`/claims/${claim.id}/code`, { inacbgCode: 'A-4-14-I', inacbgTariff: 2_500_000 }));
    expect(coded.claimedAmount).toBe(2_500_000);
    expectOk(await as('casemix').post(`/claims/${claim.id}/submit`));
    const skip = await as('keuangan').post(`/claims/${claim.id}/payment`, { amount: 1 });
    expect(skip.body.error.code).toBe('CLAIM_NOT_APPROVED');
    expectOk(await as('casemix').post(`/claims/${claim.id}/decision`, { status: 'APPROVED', note: 'Verifikasi BPJS lolos' }));
    const paid = expectOk(await as('keuangan').post(`/claims/${claim.id}/payment`, { amount: 2_500_000, reference: 'TRF-BPJS-001' }));
    expect(paid.status).toBe('PAID');
    expect(paid.variance).toBe(2_500_000 - inv.total);

    const tb = expectOk(await as('keuangan').get('/finance/reports/trial-balance'), 200);
    expect(tb.balanced).toBe(true);
    expect(tb.lines.find((l: { code: string }) => l.code === '1-1310').balance).toBe(0);
    const bs = expectOk(await as('keuangan').get('/finance/reports/balance-sheet'), 200);
    expect(bs.totalAssets).toBe(bs.totalLiabilitiesAndEquity);
  });
});

describe('Keselamatan klinis', () => {
  it('resep obat yang pasien alergi diblokir', async () => {
    const [siti] = expectOk(await as('admisi').get('/patients?q=SITI AMINAH'), 200);
    const enc = expectOk(await as('admisi').post('/encounters', { patientId: siti.id, type: 'RAWAT_JALAN', unitId: ids['unit:POLI-PD'], practitionerId: ids.drAndi, payerId: ids['payer:UMUM'] }));
    const check = expectOk(await as('dr.andi').post('/pharmacy/prescriptions/check', { encounterId: enc.id, items: [{ itemId: ids['item:OB-AMX500'] }] }));
    expect(check.alerts[0]).toMatchObject({ type: 'ALERGI', severity: 'BLOCK' });
    const res = await as('dr.andi').post('/pharmacy/prescriptions', { encounterId: enc.id, items: [{ itemId: ids['item:OB-AMX500'], quantity: 10, dose: '500 mg', frequency: '3x sehari', route: 'ORAL' }] });
    expect(res.body.error.code).toBe('PRESCRIPTION_SAFETY_BLOCK');
  });
});

describe('Keamanan & tata kelola data', () => {
  it('RBAC: kasir tidak dapat membuka RME', async () => {
    const res = await as('kasir').get(`/clinical/encounters/${ids.encUmum}/record`);
    expect(res.status).toBe(403);
  });

  it('ABAC: dokter tanpa hubungan perawatan perlu break-glass, tercatat di audit', async () => {
    const denied = await as('dr.bima').get(`/encounters/${ids.encBpjs}`);
    expect(denied.body.error.code).toBe('CARE_RELATIONSHIP_REQUIRED');
    const shortReason = await as('dr.bima').post('/auth/break-glass', { patientId: ids.patientBpjs, reason: 'darurat' });
    expect(shortReason.status).toBe(400);
    expectOk(await as('dr.bima').post('/auth/break-glass', { patientId: ids.patientBpjs, reason: 'Konsul cito pasien kejang di IGD, DPJP tidak dapat dihubungi' }));
    const ok = expectOk(await as('dr.bima').get(`/encounters/${ids.encBpjs}`), 200);
    expect(ok.accessBasis).toBe('BREAK_GLASS');
    const pending = expectOk(await as('direktur').get('/auth/break-glass?pending=true'), 200);
    expect(pending.length).toBeGreaterThan(0);
  });

  it('isolasi tenant: pengguna fasilitas lain tidak dapat melihat pasien', async () => {
    const [f] = await db.insert(facilities).values({ code: 'KLINIK2', name: 'Klinik Pratama Lain', type: 'KLINIK_PRATAMA' }).returning();
    await db.insert(users).values({ facilityId: f.id, username: 'admin', fullName: 'Admin Klinik', roles: ['ADMIN'], passwordHash: await bcrypt.hash('Klinik2026!', 4) });
    const body = await http().post('/api/v1/auth/login').send({ facilityCode: 'KLINIK2', username: 'admin', password: 'Klinik2026!' });
    tokens.other = body.body.accessToken;
    const res = await as('other').get(`/patients/${ids.patientUmum}`);
    expect(res.status).toBe(404);
    const list = expectOk(await as('other').get('/patients?q=RAHMAT'), 200);
    expect(list).toHaveLength(0);
  });

  it('audit append-only & rantai hash valid', async () => {
    const v = expectOk(await as('admin').get('/audit/verify'), 200);
    expect(v.valid).toBe(true);
    expect(v.checked).toBeGreaterThan(10);
    await expect(db.execute(sql`update audit_events set action = 'X'`)).rejects.toThrow();
    const trail = expectOk(await as('admin').get(`/audit?patientId=${ids.patientBpjs}`), 200);
    expect(trail.some((t: { action: string }) => t.action === 'BREAK_GLASS')).toBe(true);
  });
});

describe('Pengadaan hingga pembayaran (procure-to-pay)', () => {
  it('PR → approval → PO → penerimaan batch → faktur three-way match → bayar', async () => {
    const pr = expectOk(await as('pengadaan').post('/procurement/requests', { unitId: ids['unit:FARMASI'], items: [{ itemId: ids['item:OB-PCT500'], quantity: 1000 }] }));
    const selfApprove = await as('pengadaan').post(`/procurement/requests/${pr.id}/approve`);
    expect(selfApprove.status).toBe(403);
    expectOk(await as('direktur').post(`/procurement/requests/${pr.id}/approve`));

    const vendors = expectOk(await as('pengadaan').get('/master/vendors'), 200);
    const po = expectOk(await as('pengadaan').post('/procurement/orders', { vendorId: vendors[0].id, prId: pr.id, items: [{ itemId: ids['item:OB-PCT500'], quantity: 1000, unitPrice: 200 }] }));
    expect(po.total).toBe(222000);
    expectOk(await as('direktur').post(`/procurement/orders/${po.id}/approve`));

    const [poFull] = (expectOk(await as('gudang').get('/procurement/orders?status=APPROVED'), 200) as { po: { id: string }; items: { line: { id: string } }[] }[]).filter((p) => p.po.id === po.id);
    const whs = expectOk(await as('admin').get('/master/warehouses'), 200) as { id: string; type: string }[];
    const gr = expectOk(
      await as('gudang').post('/procurement/receipts', { poId: po.id, warehouseId: whs.find((w) => w.type === 'GUDANG_UTAMA')!.id, items: [{ poItemId: poFull.items[0].line.id, batchNo: 'PCT-NEW-01', expiryDate: '2029-06-30', quantity: 1000 }] }),
    );
    expect(gr.totalValue).toBe(200000);
    expect(gr.poStatus).toBe('RECEIVED');

    const mismatch = await as('keuangan').post('/procurement/ap-invoices', { poId: po.id, invoiceNo: 'FKT-001', invoiceDate: '2026-10-18', subtotal: 250000, tax: 27500 });
    expect(mismatch.body.error.code).toBe('THREE_WAY_MISMATCH');
    const ap = expectOk(await as('keuangan').post('/procurement/ap-invoices', { poId: po.id, invoiceNo: 'FKT-001', invoiceDate: '2026-10-18', subtotal: 200000, tax: 22000 }));
    const paid = expectOk(await as('keuangan').post(`/procurement/ap-invoices/${ap.id}/payments`, { amount: 222000, method: 'TRANSFER' }));
    expect(paid.status).toBe('PAID');

    const tb = expectOk(await as('keuangan').get('/finance/reports/trial-balance'), 200);
    expect(tb.balanced).toBe(true);
    expect(tb.lines.find((l: { code: string }) => l.code === '2-1110').balance).toBe(0);
  });
});

describe('Interoperabilitas', () => {
  it('outbox SATUSEHAT terkirim (mode mock) & FHIR facade valid', async () => {
    const r = expectOk(await as('admin').post('/integration/outbox/process'));
    expect(r.sent).toBeGreaterThan(0);
    const status = expectOk(await as('admin').get('/integration/status'), 200);
    expect(status.satusehatMode).toBe('mock');

    const enc = expectOk(await as('dr.andi').get(`/fhir/R4/Encounter/${ids.encUmum}`), 200);
    expect(enc.resourceType).toBe('Encounter');
    expect(enc.class.code).toBe('AMB');
    expect(enc.status).toBe('finished');
    const cond = expectOk(await as('dr.andi').get(`/fhir/R4/Condition?encounter=${ids.encUmum}`), 200);
    expect(cond.entry[0].resource.code.coding[0]).toMatchObject({ system: 'http://hl7.org/fhir/sid/icd-10', code: 'I10' });
  });

  it('dashboard KPI direksi', async () => {
    const o = expectOk(await as('direktur').get('/dashboard/overview'), 200);
    expect(o.revenue.month).toBeGreaterThan(0);
    expect(o.inpatient.discharges).toBe(1);
    expect(o.inpatient.beds).toBe(16);
  });
});
