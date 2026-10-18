/**
 * Skema data SIMRS/ERP — satu sumber kebenaran untuk seluruh domain.
 *
 * Konvensi:
 * - Setiap tabel transaksional memiliki `facility_id` (tenant). Isolasi tenant
 *   ditegakkan di lapisan service (bukan di UI) — lihat TenantScope.
 * - Nilai uang memakai numeric(18,2) (mode number) dalam Rupiah.
 * - Data identitas sensitif (NIK) disimpan terenkripsi + hash HMAC untuk pencarian.
 * - audit_events bersifat append-only (dijaga trigger DB, lihat database.bootstrap.ts).
 */
import {
  pgTable,
  uuid,
  text,
  varchar,
  integer,
  boolean,
  date,
  timestamp,
  numeric,
  jsonb,
  bigserial,
  uniqueIndex,
  index,
  primaryKey,
  smallint,
} from 'drizzle-orm/pg-core';

const id = () => uuid('id').primaryKey().defaultRandom();
const facilityId = () => uuid('facility_id').notNull().references(() => facilities.id);
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();
const money = (name: string) => numeric(name, { precision: 18, scale: 2, mode: 'number' });
const qty = (name: string) => numeric(name, { precision: 14, scale: 3, mode: 'number' });

/* ============================== ORGANISASI ============================== */

export const facilities = pgTable('facilities', {
  id: id(),
  code: varchar('code', { length: 32 }).notNull().unique(),
  name: text('name').notNull(),
  /** RS_UMUM | RS_KHUSUS | KLINIK_PRATAMA | KLINIK_UTAMA */
  type: varchar('type', { length: 32 }).notNull(),
  /** Kelas RS: A | B | C | D (null untuk klinik) */
  hospitalClass: varchar('hospital_class', { length: 2 }),
  /** Kode faskes Kemenkes (SIRS / RS Online) */
  kemkesCode: varchar('kemkes_code', { length: 32 }),
  /** Kode PPK BPJS Kesehatan */
  bpjsPpkCode: varchar('bpjs_ppk_code', { length: 32 }),
  /** Organization ID SATUSEHAT */
  satusehatOrgId: varchar('satusehat_org_id', { length: 64 }),
  address: text('address'),
  city: text('city'),
  province: text('province'),
  phone: varchar('phone', { length: 32 }),
  /** Asia/Jakarta (WIB) | Asia/Makassar (WITA) | Asia/Jayapura (WIT) */
  timezone: varchar('timezone', { length: 32 }).notNull().default('Asia/Jakarta'),
  /** Feature flags per tenant, mis. {"inpatient":true,"bpjs":true} */
  features: jsonb('features').$type<Record<string, boolean>>().notNull().default({}),
  active: boolean('active').notNull().default(true),
  createdAt: createdAt(),
});

export const units = pgTable(
  'units',
  {
    id: id(),
    facilityId: facilityId(),
    code: varchar('code', { length: 32 }).notNull(),
    name: text('name').notNull(),
    /** POLI | IGD | RAWAT_INAP | ICU | OK | LAB | RADIOLOGI | FARMASI | KASIR | GUDANG | ADMIN | REKAM_MEDIS */
    type: varchar('type', { length: 32 }).notNull(),
    /** Kode poli BPJS (mis. INT, ANA, OBG) */
    bpjsPoliCode: varchar('bpjs_poli_code', { length: 16 }),
    satusehatLocationId: varchar('satusehat_location_id', { length: 64 }),
    queuePrefix: varchar('queue_prefix', { length: 4 }),
    active: boolean('active').notNull().default(true),
  },
  (t) => [uniqueIndex('units_facility_code').on(t.facilityId, t.code)],
);

export const rooms = pgTable('rooms', {
  id: id(),
  facilityId: facilityId(),
  unitId: uuid('unit_id').notNull().references(() => units.id),
  code: varchar('code', { length: 32 }).notNull(),
  name: text('name').notNull(),
  /** KRIS | VVIP | VIP | KELAS_1 | KELAS_2 | KELAS_3 | ICU | ISOLASI */
  careClass: varchar('care_class', { length: 16 }).notNull(),
});

export const beds = pgTable('beds', {
  id: id(),
  facilityId: facilityId(),
  roomId: uuid('room_id').notNull().references(() => rooms.id),
  code: varchar('code', { length: 32 }).notNull(),
  /** AVAILABLE | OCCUPIED | CLEANING | MAINTENANCE */
  status: varchar('status', { length: 16 }).notNull().default('AVAILABLE'),
  currentEncounterId: uuid('current_encounter_id'),
});

export const practitioners = pgTable('practitioners', {
  id: id(),
  facilityId: facilityId(),
  name: text('name').notNull(),
  /** DOKTER | DOKTER_SPESIALIS | DOKTER_GIGI | PERAWAT | BIDAN | APOTEKER | TTK | ANALIS | RADIOGRAFER | NUTRISIONIS */
  profession: varchar('profession', { length: 32 }).notNull(),
  specialty: text('specialty'),
  nikEncrypted: text('nik_encrypted'),
  strNumber: varchar('str_number', { length: 64 }),
  strExpiry: date('str_expiry'),
  sipNumber: varchar('sip_number', { length: 64 }),
  sipExpiry: date('sip_expiry'),
  /** IHS Number SATUSEHAT */
  satusehatId: varchar('satusehat_id', { length: 64 }),
  /** Kode DPJP BPJS */
  bpjsDpjpCode: varchar('bpjs_dpjp_code', { length: 32 }),
  phone: varchar('phone', { length: 32 }),
  active: boolean('active').notNull().default(true),
  createdAt: createdAt(),
});

export const practitionerSchedules = pgTable('practitioner_schedules', {
  id: id(),
  facilityId: facilityId(),
  practitionerId: uuid('practitioner_id').notNull().references(() => practitioners.id),
  unitId: uuid('unit_id').notNull().references(() => units.id),
  /** 1=Senin … 7=Minggu (ISO) */
  dayOfWeek: smallint('day_of_week').notNull(),
  startTime: varchar('start_time', { length: 5 }).notNull(),
  endTime: varchar('end_time', { length: 5 }).notNull(),
  quota: integer('quota').notNull().default(30),
});

/* ================================= IAM ================================= */

export const users = pgTable(
  'users',
  {
    id: id(),
    facilityId: facilityId(),
    username: varchar('username', { length: 64 }).notNull(),
    passwordHash: text('password_hash').notNull(),
    fullName: text('full_name').notNull(),
    practitionerId: uuid('practitioner_id').references(() => practitioners.id),
    /** Unit kerja utama — dipakai untuk ABAC (mis. perawat hanya melihat bangsalnya) */
    unitId: uuid('unit_id').references(() => units.id),
    roles: jsonb('roles').$type<string[]>().notNull().default([]),
    mfaEnabled: boolean('mfa_enabled').notNull().default(false),
    active: boolean('active').notNull().default(true),
    failedLogins: integer('failed_logins').notNull().default(0),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('users_facility_username').on(t.facilityId, t.username)],
);

/** Akses darurat (break-glass): wajib alasan, kedaluwarsa, ditinjau pasca-akses. */
export const breakGlassSessions = pgTable('break_glass_sessions', {
  id: id(),
  facilityId: facilityId(),
  userId: uuid('user_id').notNull().references(() => users.id),
  patientId: uuid('patient_id').notNull(),
  reason: text('reason').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  reviewedBy: uuid('reviewed_by'),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
  reviewNote: text('review_note'),
  createdAt: createdAt(),
});

/* ============================== MASTER DATA ============================== */

export const payers = pgTable(
  'payers',
  {
    id: id(),
    facilityId: facilityId(),
    code: varchar('code', { length: 32 }).notNull(),
    name: text('name').notNull(),
    /** UMUM | BPJS | ASURANSI | PERUSAHAAN | JAMKESDA */
    type: varchar('type', { length: 16 }).notNull(),
    /** Akun piutang di GL */
    receivableAccount: varchar('receivable_account', { length: 16 }).notNull(),
    active: boolean('active').notNull().default(true),
  },
  (t) => [uniqueIndex('payers_facility_code').on(t.facilityId, t.code)],
);

export const services = pgTable(
  'services',
  {
    id: id(),
    facilityId: facilityId(),
    code: varchar('code', { length: 32 }).notNull(),
    name: text('name').notNull(),
    /** KONSULTASI | TINDAKAN | LAB | RADIOLOGI | AKOMODASI | ADMINISTRASI | VISITE | OPERASI */
    category: varchar('category', { length: 16 }).notNull(),
    icd9cmCode: varchar('icd9cm_code', { length: 16 }),
    /** Kode LOINC (lab) untuk SATUSEHAT */
    loincCode: varchar('loinc_code', { length: 16 }),
    revenueAccount: varchar('revenue_account', { length: 16 }).notNull(),
    active: boolean('active').notNull().default(true),
  },
  (t) => [uniqueIndex('services_facility_code').on(t.facilityId, t.code)],
);

/** Tarif per layanan × jenis penjamin × kelas rawat; payer_type/care_class null = berlaku umum. */
export const tariffs = pgTable('tariffs', {
  id: id(),
  facilityId: facilityId(),
  serviceId: uuid('service_id').notNull().references(() => services.id),
  payerType: varchar('payer_type', { length: 16 }),
  careClass: varchar('care_class', { length: 16 }),
  price: money('price').notNull(),
  effectiveFrom: date('effective_from').notNull(),
  effectiveTo: date('effective_to'),
});

export const icd10 = pgTable('icd10', {
  code: varchar('code', { length: 16 }).primaryKey(),
  display: text('display').notNull(),
  displayId: text('display_id'),
});

export const icd9cm = pgTable('icd9cm', {
  code: varchar('code', { length: 16 }).primaryKey(),
  display: text('display').notNull(),
});

export const items = pgTable(
  'items',
  {
    id: id(),
    facilityId: facilityId(),
    code: varchar('code', { length: 32 }).notNull(),
    name: text('name').notNull(),
    genericName: text('generic_name'),
    /** Kode KFA (Kamus Farmasi dan Alat Kesehatan) SATUSEHAT */
    kfaCode: varchar('kfa_code', { length: 32 }),
    /** OBAT | ALKES | BMHP */
    category: varchar('category', { length: 8 }).notNull(),
    dosageForm: varchar('dosage_form', { length: 32 }),
    strength: varchar('strength', { length: 32 }),
    uom: varchar('uom', { length: 16 }).notNull(),
    isHighAlert: boolean('is_high_alert').notNull().default(false),
    /** Narkotika / psikotropika — pelaporan SIPNAP */
    isNarcotic: boolean('is_narcotic').notNull().default(false),
    /** Masuk Formularium Nasional / formularium RS */
    isFormulary: boolean('is_formulary').notNull().default(true),
    salePrice: money('sale_price').notNull().default(0),
    minStock: qty('min_stock').notNull().default(0),
    active: boolean('active').notNull().default(true),
  },
  (t) => [uniqueIndex('items_facility_code').on(t.facilityId, t.code)],
);

export const drugInteractions = pgTable('drug_interactions', {
  id: id(),
  genericA: text('generic_a').notNull(),
  genericB: text('generic_b').notNull(),
  /** MAJOR | MODERATE | MINOR */
  severity: varchar('severity', { length: 16 }).notNull(),
  description: text('description').notNull(),
});

/* ============================ PASIEN / MPI ============================ */

export const patients = pgTable(
  'patients',
  {
    id: id(),
    facilityId: facilityId(),
    /** Nomor Rekam Medis — unik per institusi */
    mrn: varchar('mrn', { length: 16 }).notNull(),
    nikEncrypted: text('nik_encrypted'),
    /** HMAC-SHA256(NIK) untuk pencarian/dedup tanpa membuka NIK */
    nikHash: varchar('nik_hash', { length: 64 }),
    nikLast4: varchar('nik_last4', { length: 4 }),
    name: text('name').notNull(),
    birthDate: date('birth_date').notNull(),
    birthPlace: text('birth_place'),
    /** L | P */
    gender: varchar('gender', { length: 1 }).notNull(),
    bloodType: varchar('blood_type', { length: 4 }),
    motherName: text('mother_name'),
    phone: varchar('phone', { length: 32 }),
    address: text('address'),
    city: text('city'),
    province: text('province'),
    religion: varchar('religion', { length: 16 }),
    maritalStatus: varchar('marital_status', { length: 16 }),
    occupation: text('occupation'),
    /** No. kartu JKN-KIS */
    bpjsNumber: varchar('bpjs_number', { length: 20 }),
    satusehatId: varchar('satusehat_id', { length: 64 }),
    emergencyContactName: text('emergency_contact_name'),
    emergencyContactPhone: varchar('emergency_contact_phone', { length: 32 }),
    /** ACTIVE | MERGED | DECEASED */
    status: varchar('status', { length: 16 }).notNull().default('ACTIVE'),
    mergedIntoId: uuid('merged_into_id'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('patients_facility_mrn').on(t.facilityId, t.mrn),
    index('patients_nik_hash').on(t.facilityId, t.nikHash),
    index('patients_name').on(t.facilityId, t.name),
  ],
);

export const patientAllergies = pgTable('patient_allergies', {
  id: id(),
  facilityId: facilityId(),
  patientId: uuid('patient_id').notNull().references(() => patients.id),
  substance: text('substance').notNull(),
  /** OBAT | MAKANAN | LINGKUNGAN */
  category: varchar('category', { length: 16 }).notNull(),
  reaction: text('reaction'),
  /** RINGAN | SEDANG | BERAT */
  severity: varchar('severity', { length: 8 }).notNull(),
  active: boolean('active').notNull().default(true),
  recordedBy: uuid('recorded_by'),
  createdAt: createdAt(),
});

export const patientConsents = pgTable('patient_consents', {
  id: id(),
  facilityId: facilityId(),
  patientId: uuid('patient_id').notNull().references(() => patients.id),
  encounterId: uuid('encounter_id'),
  /** GENERAL_CONSENT | TINDAKAN_MEDIS | BERBAGI_DATA_SATUSEHAT | PENOLAKAN_TINDAKAN */
  type: varchar('type', { length: 32 }).notNull(),
  granted: boolean('granted').notNull(),
  signedBy: text('signed_by').notNull(),
  relationship: varchar('relationship', { length: 32 }),
  notes: text('notes'),
  recordedBy: uuid('recorded_by'),
  createdAt: createdAt(),
});

export const patientMerges = pgTable('patient_merges', {
  id: id(),
  facilityId: facilityId(),
  sourcePatientId: uuid('source_patient_id').notNull(),
  targetPatientId: uuid('target_patient_id').notNull(),
  reason: text('reason').notNull(),
  mergedBy: uuid('merged_by').notNull(),
  createdAt: createdAt(),
});

/* ====================== JADWAL, ANTREAN, KUNJUNGAN ====================== */

export const appointments = pgTable('appointments', {
  id: id(),
  facilityId: facilityId(),
  bookingCode: varchar('booking_code', { length: 32 }).notNull(),
  patientId: uuid('patient_id').notNull().references(() => patients.id),
  practitionerId: uuid('practitioner_id').notNull().references(() => practitioners.id),
  unitId: uuid('unit_id').notNull().references(() => units.id),
  payerId: uuid('payer_id').references(() => payers.id),
  date: date('date').notNull(),
  slotTime: varchar('slot_time', { length: 5 }),
  /** ONSITE | ONLINE | MOBILE_JKN | TELEPON */
  source: varchar('source', { length: 16 }).notNull().default('ONSITE'),
  /** BOOKED | CHECKED_IN | CANCELLED | NO_SHOW */
  status: varchar('status', { length: 16 }).notNull().default('BOOKED'),
  encounterId: uuid('encounter_id'),
  createdAt: createdAt(),
});

export const queueTickets = pgTable(
  'queue_tickets',
  {
    id: id(),
    facilityId: facilityId(),
    unitId: uuid('unit_id').notNull().references(() => units.id),
    date: date('date').notNull(),
    number: integer('number').notNull(),
    label: varchar('label', { length: 16 }).notNull(),
    patientId: uuid('patient_id'),
    encounterId: uuid('encounter_id'),
    /** WAITING | CALLED | SERVING | DONE | SKIPPED */
    status: varchar('status', { length: 16 }).notNull().default('WAITING'),
    counter: varchar('counter', { length: 32 }),
    createdAt: createdAt(),
    calledAt: timestamp('called_at', { withTimezone: true }),
    servedAt: timestamp('served_at', { withTimezone: true }),
    doneAt: timestamp('done_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('queue_unit_date_number').on(t.unitId, t.date, t.number)],
);

export const encounters = pgTable(
  'encounters',
  {
    id: id(),
    facilityId: facilityId(),
    encounterNo: varchar('encounter_no', { length: 32 }).notNull(),
    patientId: uuid('patient_id').notNull().references(() => patients.id),
    /** RAWAT_JALAN | IGD | RAWAT_INAP */
    type: varchar('type', { length: 16 }).notNull(),
    unitId: uuid('unit_id').notNull().references(() => units.id),
    /** DPJP */
    practitionerId: uuid('practitioner_id').references(() => practitioners.id),
    payerId: uuid('payer_id').notNull().references(() => payers.id),
    payerMemberNo: varchar('payer_member_no', { length: 32 }),
    /** Nomor SEP BPJS */
    sepNumber: varchar('sep_number', { length: 32 }),
    referralNo: varchar('referral_no', { length: 32 }),
    careClass: varchar('care_class', { length: 16 }),
    bedId: uuid('bed_id'),
    /** REGISTERED | TRIAGED | IN_PROGRESS | FINISHED | CANCELLED */
    status: varchar('status', { length: 16 }).notNull().default('REGISTERED'),
    triageLevel: smallint('triage_level'),
    chiefComplaint: text('chief_complaint'),
    /** PULANG | KONTROL | RUJUK | RAWAT_INAP | MENINGGAL | APS */
    dischargeDisposition: varchar('discharge_disposition', { length: 16 }),
    appointmentId: uuid('appointment_id'),
    parentEncounterId: uuid('parent_encounter_id'),
    satusehatEncounterId: varchar('satusehat_encounter_id', { length: 64 }),
    startAt: timestamp('start_at', { withTimezone: true }).notNull().defaultNow(),
    endAt: timestamp('end_at', { withTimezone: true }),
    createdBy: uuid('created_by'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('encounters_facility_no').on(t.facilityId, t.encounterNo),
    index('encounters_patient').on(t.patientId),
    index('encounters_status').on(t.facilityId, t.status),
  ],
);

export const triages = pgTable('triages', {
  id: id(),
  facilityId: facilityId(),
  encounterId: uuid('encounter_id').notNull().references(() => encounters.id),
  /** 1 (Resusitasi/Merah) … 5 (Tidak gawat/Hijau) — skala ATS/ESI */
  level: smallint('level').notNull(),
  complaint: text('complaint'),
  notes: text('notes'),
  triagedBy: uuid('triaged_by'),
  createdAt: createdAt(),
});

export const bedAssignments = pgTable('bed_assignments', {
  id: id(),
  facilityId: facilityId(),
  encounterId: uuid('encounter_id').notNull().references(() => encounters.id),
  bedId: uuid('bed_id').notNull().references(() => beds.id),
  careClass: varchar('care_class', { length: 16 }).notNull(),
  startAt: timestamp('start_at', { withTimezone: true }).notNull().defaultNow(),
  endAt: timestamp('end_at', { withTimezone: true }),
});

/* ============================= KLINIS / RME ============================= */

export const vitalSigns = pgTable('vital_signs', {
  id: id(),
  facilityId: facilityId(),
  encounterId: uuid('encounter_id').notNull().references(() => encounters.id),
  patientId: uuid('patient_id').notNull(),
  systolic: integer('systolic'),
  diastolic: integer('diastolic'),
  heartRate: integer('heart_rate'),
  respRate: integer('resp_rate'),
  temperature: numeric('temperature', { precision: 4, scale: 1, mode: 'number' }),
  spo2: integer('spo2'),
  weight: numeric('weight', { precision: 5, scale: 1, mode: 'number' }),
  height: numeric('height', { precision: 5, scale: 1, mode: 'number' }),
  painScore: smallint('pain_score'),
  gcs: smallint('gcs'),
  /** Early warning score yang dihitung sistem */
  ews: smallint('ews'),
  recordedBy: uuid('recorded_by'),
  createdAt: createdAt(),
});

/**
 * Catatan klinis: SOAP / CPPT / Asesmen / Resume Medis.
 * Setelah SIGNED tidak bisa diubah; koreksi dibuat sebagai catatan AMENDMENT
 * (Permenkes 24/2022: perubahan RME harus tercatat & dapat ditelusuri).
 */
export const clinicalNotes = pgTable('clinical_notes', {
  id: id(),
  facilityId: facilityId(),
  encounterId: uuid('encounter_id').notNull().references(() => encounters.id),
  patientId: uuid('patient_id').notNull(),
  /** SOAP | CPPT | ASESMEN_AWAL_MEDIS | ASESMEN_KEPERAWATAN | RESUME_MEDIS | AMENDMENT */
  type: varchar('type', { length: 24 }).notNull(),
  subjective: text('subjective'),
  objective: text('objective'),
  assessment: text('assessment'),
  plan: text('plan'),
  instruction: text('instruction'),
  authorId: uuid('author_id').notNull(),
  authorName: text('author_name').notNull(),
  authorRole: varchar('author_role', { length: 32 }).notNull(),
  /** DRAFT | SIGNED */
  status: varchar('status', { length: 8 }).notNull().default('DRAFT'),
  amendsNoteId: uuid('amends_note_id'),
  signedAt: timestamp('signed_at', { withTimezone: true }),
  /** SHA-256 isi catatan saat ditandatangani — deteksi perubahan */
  signatureHash: varchar('signature_hash', { length: 64 }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const diagnoses = pgTable('diagnoses', {
  id: id(),
  facilityId: facilityId(),
  encounterId: uuid('encounter_id').notNull().references(() => encounters.id),
  patientId: uuid('patient_id').notNull(),
  icd10Code: varchar('icd10_code', { length: 16 }).notNull(),
  display: text('display').notNull(),
  /** PRIMER | SEKUNDER | KOMPLIKASI */
  rank: varchar('rank', { length: 16 }).notNull(),
  /** KERJA | BANDING | AKHIR */
  status: varchar('status', { length: 8 }).notNull().default('KERJA'),
  recordedBy: uuid('recorded_by'),
  createdAt: createdAt(),
});

export const procedures = pgTable('procedures', {
  id: id(),
  facilityId: facilityId(),
  encounterId: uuid('encounter_id').notNull().references(() => encounters.id),
  patientId: uuid('patient_id').notNull(),
  icd9cmCode: varchar('icd9cm_code', { length: 16 }),
  display: text('display').notNull(),
  serviceId: uuid('service_id').references(() => services.id),
  performedBy: uuid('performed_by'),
  notes: text('notes'),
  performedAt: timestamp('performed_at', { withTimezone: true }).notNull().defaultNow(),
});

/* ============================ ORDER (CPOE) ============================ */

export const orders = pgTable(
  'orders',
  {
    id: id(),
    facilityId: facilityId(),
    orderNo: varchar('order_no', { length: 32 }).notNull(),
    encounterId: uuid('encounter_id').notNull().references(() => encounters.id),
    patientId: uuid('patient_id').notNull(),
    /** LAB | RADIOLOGI | TINDAKAN */
    category: varchar('category', { length: 16 }).notNull(),
    serviceId: uuid('service_id').notNull().references(() => services.id),
    serviceName: text('service_name').notNull(),
    /** RUTIN | CITO */
    priority: varchar('priority', { length: 8 }).notNull().default('RUTIN'),
    /** ORDERED | IN_PROGRESS | RESULTED | VERIFIED | CANCELLED */
    status: varchar('status', { length: 16 }).notNull().default('ORDERED'),
    clinicalInfo: text('clinical_info'),
    orderedBy: uuid('ordered_by').notNull(),
    orderedByName: text('ordered_by_name').notNull(),
    cancelReason: text('cancel_reason'),
    createdAt: createdAt(),
  },
  (t) => [index('orders_status').on(t.facilityId, t.category, t.status)],
);

export interface ResultObservation {
  name: string;
  value: string;
  unit?: string;
  referenceRange?: string;
  /** N | H | L | HH | LL (kritis) */
  flag?: string;
  loinc?: string;
}

export const results = pgTable('results', {
  id: id(),
  facilityId: facilityId(),
  orderId: uuid('order_id').notNull().references(() => orders.id),
  encounterId: uuid('encounter_id').notNull(),
  observations: jsonb('observations').$type<ResultObservation[]>().notNull().default([]),
  conclusion: text('conclusion'),
  isCritical: boolean('is_critical').notNull().default(false),
  resultedBy: uuid('resulted_by').notNull(),
  resultedAt: timestamp('resulted_at', { withTimezone: true }).notNull().defaultNow(),
  verifiedBy: uuid('verified_by'),
  verifiedAt: timestamp('verified_at', { withTimezone: true }),
  criticalAckBy: uuid('critical_ack_by'),
  criticalAckAt: timestamp('critical_ack_at', { withTimezone: true }),
});

/* ================================ FARMASI ================================ */

export const prescriptions = pgTable('prescriptions', {
  id: id(),
  facilityId: facilityId(),
  rxNo: varchar('rx_no', { length: 32 }).notNull(),
  encounterId: uuid('encounter_id').notNull().references(() => encounters.id),
  patientId: uuid('patient_id').notNull(),
  prescriberId: uuid('prescriber_id').notNull(),
  prescriberName: text('prescriber_name').notNull(),
  /** SUBMITTED | VERIFIED | DISPENSED | REJECTED | CANCELLED */
  status: varchar('status', { length: 16 }).notNull().default('SUBMITTED'),
  notes: text('notes'),
  /** Peringatan keselamatan saat resep dibuat (alergi, interaksi, high-alert) */
  alerts: jsonb('alerts').$type<{ type: string; severity: string; message: string }[]>().notNull().default([]),
  overrideReason: text('override_reason'),
  /** Telaah resep apoteker */
  reviewNotes: text('review_notes'),
  verifiedBy: uuid('verified_by'),
  verifiedAt: timestamp('verified_at', { withTimezone: true }),
  dispensedBy: uuid('dispensed_by'),
  dispensedAt: timestamp('dispensed_at', { withTimezone: true }),
  createdAt: createdAt(),
});

export const prescriptionItems = pgTable('prescription_items', {
  id: id(),
  prescriptionId: uuid('prescription_id').notNull().references(() => prescriptions.id),
  itemId: uuid('item_id').notNull().references(() => items.id),
  itemName: text('item_name').notNull(),
  quantity: qty('quantity').notNull(),
  dose: varchar('dose', { length: 64 }).notNull(),
  frequency: varchar('frequency', { length: 64 }).notNull(),
  route: varchar('route', { length: 32 }).notNull(),
  durationDays: integer('duration_days'),
  instructions: text('instructions'),
  dispensedQty: qty('dispensed_qty').notNull().default(0),
});

/** eMAR — pemberian obat di bangsal (closed-loop). */
export const medicationAdministrations = pgTable('medication_administrations', {
  id: id(),
  facilityId: facilityId(),
  encounterId: uuid('encounter_id').notNull().references(() => encounters.id),
  prescriptionItemId: uuid('prescription_item_id').notNull().references(() => prescriptionItems.id),
  /** GIVEN | HELD | REFUSED */
  status: varchar('status', { length: 8 }).notNull(),
  doseGiven: varchar('dose_given', { length: 64 }),
  notes: text('notes'),
  /** Verifikasi dua identitas pasien (nama + tgl lahir / No. RM) */
  twoIdentifiersVerified: boolean('two_identifiers_verified').notNull(),
  /** Double-check perawat kedua untuk obat high-alert */
  doubleCheckedBy: uuid('double_checked_by'),
  administeredBy: uuid('administered_by').notNull(),
  administeredAt: timestamp('administered_at', { withTimezone: true }).notNull().defaultNow(),
});

/* =============================== INVENTORI =============================== */

export const warehouses = pgTable('warehouses', {
  id: id(),
  facilityId: facilityId(),
  code: varchar('code', { length: 32 }).notNull(),
  name: text('name').notNull(),
  /** GUDANG_UTAMA | DEPO_FARMASI | DEPO_UNIT */
  type: varchar('type', { length: 16 }).notNull(),
  unitId: uuid('unit_id').references(() => units.id),
});

export const stockBatches = pgTable(
  'stock_batches',
  {
    id: id(),
    facilityId: facilityId(),
    warehouseId: uuid('warehouse_id').notNull().references(() => warehouses.id),
    itemId: uuid('item_id').notNull().references(() => items.id),
    batchNo: varchar('batch_no', { length: 64 }).notNull(),
    expiryDate: date('expiry_date').notNull(),
    qtyOnHand: qty('qty_on_hand').notNull().default(0),
    unitCost: money('unit_cost').notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('stock_batch_unique').on(t.warehouseId, t.itemId, t.batchNo)],
);

export const stockMovements = pgTable('stock_movements', {
  id: id(),
  facilityId: facilityId(),
  warehouseId: uuid('warehouse_id').notNull(),
  itemId: uuid('item_id').notNull(),
  batchId: uuid('batch_id').notNull(),
  /** RECEIPT | DISPENSE | TRANSFER_IN | TRANSFER_OUT | ADJUSTMENT | RETURN | EXPIRED */
  type: varchar('type', { length: 16 }).notNull(),
  quantity: qty('quantity').notNull(),
  unitCost: money('unit_cost').notNull(),
  refType: varchar('ref_type', { length: 32 }),
  refId: uuid('ref_id'),
  notes: text('notes'),
  createdBy: uuid('created_by'),
  createdAt: createdAt(),
});

/* ============================== PENGADAAN ============================== */

export const vendors = pgTable('vendors', {
  id: id(),
  facilityId: facilityId(),
  code: varchar('code', { length: 32 }).notNull(),
  name: text('name').notNull(),
  npwp: varchar('npwp', { length: 32 }),
  /** Izin PBF untuk distributor obat */
  licenseNo: varchar('license_no', { length: 64 }),
  address: text('address'),
  phone: varchar('phone', { length: 32 }),
  paymentTermDays: integer('payment_term_days').notNull().default(30),
  rating: numeric('rating', { precision: 3, scale: 2, mode: 'number' }),
  active: boolean('active').notNull().default(true),
});

export const purchaseRequests = pgTable('purchase_requests', {
  id: id(),
  facilityId: facilityId(),
  prNo: varchar('pr_no', { length: 32 }).notNull(),
  unitId: uuid('unit_id').notNull().references(() => units.id),
  /** SUBMITTED | APPROVED | REJECTED | ORDERED */
  status: varchar('status', { length: 16 }).notNull().default('SUBMITTED'),
  notes: text('notes'),
  requestedBy: uuid('requested_by').notNull(),
  approvedBy: uuid('approved_by'),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  rejectReason: text('reject_reason'),
  createdAt: createdAt(),
});

export const purchaseRequestItems = pgTable('purchase_request_items', {
  id: id(),
  prId: uuid('pr_id').notNull().references(() => purchaseRequests.id),
  itemId: uuid('item_id').notNull().references(() => items.id),
  quantity: qty('quantity').notNull(),
  notes: text('notes'),
});

export const purchaseOrders = pgTable('purchase_orders', {
  id: id(),
  facilityId: facilityId(),
  poNo: varchar('po_no', { length: 32 }).notNull(),
  vendorId: uuid('vendor_id').notNull().references(() => vendors.id),
  prId: uuid('pr_id'),
  /** DRAFT | APPROVED | PARTIAL | RECEIVED | CANCELLED */
  status: varchar('status', { length: 16 }).notNull().default('DRAFT'),
  orderDate: date('order_date').notNull(),
  expectedDate: date('expected_date'),
  subtotal: money('subtotal').notNull().default(0),
  taxRate: numeric('tax_rate', { precision: 5, scale: 2, mode: 'number' }).notNull().default(11),
  tax: money('tax').notNull().default(0),
  total: money('total').notNull().default(0),
  createdBy: uuid('created_by').notNull(),
  approvedBy: uuid('approved_by'),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  createdAt: createdAt(),
});

export const purchaseOrderItems = pgTable('purchase_order_items', {
  id: id(),
  poId: uuid('po_id').notNull().references(() => purchaseOrders.id),
  itemId: uuid('item_id').notNull().references(() => items.id),
  quantity: qty('quantity').notNull(),
  unitPrice: money('unit_price').notNull(),
  receivedQty: qty('received_qty').notNull().default(0),
});

export const goodsReceipts = pgTable('goods_receipts', {
  id: id(),
  facilityId: facilityId(),
  grNo: varchar('gr_no', { length: 32 }).notNull(),
  poId: uuid('po_id').notNull().references(() => purchaseOrders.id),
  warehouseId: uuid('warehouse_id').notNull().references(() => warehouses.id),
  vendorDeliveryNo: varchar('vendor_delivery_no', { length: 64 }),
  notes: text('notes'),
  totalValue: money('total_value').notNull().default(0),
  receivedBy: uuid('received_by').notNull(),
  createdAt: createdAt(),
});

export const goodsReceiptItems = pgTable('goods_receipt_items', {
  id: id(),
  grId: uuid('gr_id').notNull().references(() => goodsReceipts.id),
  poItemId: uuid('po_item_id').notNull().references(() => purchaseOrderItems.id),
  itemId: uuid('item_id').notNull(),
  batchNo: varchar('batch_no', { length: 64 }).notNull(),
  expiryDate: date('expiry_date').notNull(),
  quantity: qty('quantity').notNull(),
  unitPrice: money('unit_price').notNull(),
  inspectionPassed: boolean('inspection_passed').notNull().default(true),
});

export const apInvoices = pgTable('ap_invoices', {
  id: id(),
  facilityId: facilityId(),
  vendorId: uuid('vendor_id').notNull().references(() => vendors.id),
  poId: uuid('po_id').references(() => purchaseOrders.id),
  invoiceNo: varchar('invoice_no', { length: 64 }).notNull(),
  invoiceDate: date('invoice_date').notNull(),
  dueDate: date('due_date').notNull(),
  subtotal: money('subtotal').notNull(),
  tax: money('tax').notNull(),
  total: money('total').notNull(),
  paidAmount: money('paid_amount').notNull().default(0),
  /** MATCHED | MISMATCH — three-way match PO × GR × invoice */
  matchStatus: varchar('match_status', { length: 16 }).notNull(),
  matchNotes: text('match_notes'),
  /** OPEN | PARTIAL | PAID */
  status: varchar('status', { length: 8 }).notNull().default('OPEN'),
  createdAt: createdAt(),
});

export const apPayments = pgTable('ap_payments', {
  id: id(),
  facilityId: facilityId(),
  apInvoiceId: uuid('ap_invoice_id').notNull().references(() => apInvoices.id),
  amount: money('amount').notNull(),
  method: varchar('method', { length: 16 }).notNull(),
  reference: varchar('reference', { length: 64 }),
  paidBy: uuid('paid_by').notNull(),
  createdAt: createdAt(),
});

/* ============================ REVENUE CYCLE ============================ */

export const charges = pgTable(
  'charges',
  {
    id: id(),
    facilityId: facilityId(),
    encounterId: uuid('encounter_id').notNull().references(() => encounters.id),
    patientId: uuid('patient_id').notNull(),
    serviceId: uuid('service_id'),
    itemId: uuid('item_id'),
    description: text('description').notNull(),
    quantity: qty('quantity').notNull(),
    unitPrice: money('unit_price').notNull(),
    amount: money('amount').notNull(),
    /** CONSULT | ORDER | PROCEDURE | DISPENSE | BED | ADMIN | MANUAL */
    sourceType: varchar('source_type', { length: 16 }).notNull(),
    sourceId: uuid('source_id'),
    revenueAccount: varchar('revenue_account', { length: 16 }).notNull(),
    /** PENJAMIN | PASIEN — mis. obat non-formularium pada pasien JKN ditagihkan ke pasien */
    billTo: varchar('bill_to', { length: 8 }).notNull().default('PASIEN'),
    /** Nilai HPP (khusus obat/BMHP) untuk analisis margin & cost per case */
    costAmount: money('cost_amount').notNull().default(0),
    /** ACTIVE | INVOICED | VOID */
    status: varchar('status', { length: 8 }).notNull().default('ACTIVE'),
    voidReason: text('void_reason'),
    createdBy: uuid('created_by'),
    createdAt: createdAt(),
  },
  (t) => [
    index('charges_encounter').on(t.encounterId),
    // Mencegah charge ganda dari sumber yang sama (idempotensi charge capture)
    uniqueIndex('charges_source_unique').on(t.sourceType, t.sourceId),
  ],
);

export const invoices = pgTable('invoices', {
  id: id(),
  facilityId: facilityId(),
  invoiceNo: varchar('invoice_no', { length: 32 }).notNull(),
  encounterId: uuid('encounter_id').notNull().references(() => encounters.id),
  patientId: uuid('patient_id').notNull(),
  payerId: uuid('payer_id').notNull().references(() => payers.id),
  /** PASIEN | PENJAMIN — tagihan pasien dipisah dari klaim penjamin */
  billTo: varchar('bill_to', { length: 8 }).notNull(),
  /** ISSUED | PARTIAL | PAID | VOID */
  status: varchar('status', { length: 8 }).notNull().default('ISSUED'),
  subtotal: money('subtotal').notNull(),
  discount: money('discount').notNull().default(0),
  total: money('total').notNull(),
  paidAmount: money('paid_amount').notNull().default(0),
  issuedBy: uuid('issued_by').notNull(),
  createdAt: createdAt(),
});

export const invoiceLines = pgTable('invoice_lines', {
  id: id(),
  invoiceId: uuid('invoice_id').notNull().references(() => invoices.id),
  chargeId: uuid('charge_id').notNull().references(() => charges.id),
  description: text('description').notNull(),
  quantity: qty('quantity').notNull(),
  unitPrice: money('unit_price').notNull(),
  amount: money('amount').notNull(),
});

export const payments = pgTable('payments', {
  id: id(),
  facilityId: facilityId(),
  paymentNo: varchar('payment_no', { length: 32 }).notNull(),
  invoiceId: uuid('invoice_id').notNull().references(() => invoices.id),
  amount: money('amount').notNull(),
  /** TUNAI | DEBIT | KREDIT | QRIS | TRANSFER | VA | PENJAMIN */
  method: varchar('method', { length: 16 }).notNull(),
  reference: varchar('reference', { length: 64 }),
  receivedBy: uuid('received_by').notNull(),
  createdAt: createdAt(),
});

export const claims = pgTable('claims', {
  id: id(),
  facilityId: facilityId(),
  claimNo: varchar('claim_no', { length: 32 }).notNull(),
  encounterId: uuid('encounter_id').notNull().references(() => encounters.id),
  invoiceId: uuid('invoice_id').references(() => invoices.id),
  payerId: uuid('payer_id').notNull().references(() => payers.id),
  sepNumber: varchar('sep_number', { length: 32 }),
  /** Kode grouping INA-CBG (BPJS) — diisi casemix dari E-Klaim */
  inacbgCode: varchar('inacbg_code', { length: 16 }),
  inacbgTariff: money('inacbg_tariff'),
  hospitalTariff: money('hospital_tariff').notNull(),
  claimedAmount: money('claimed_amount').notNull(),
  approvedAmount: money('approved_amount'),
  paidAmount: money('paid_amount').notNull().default(0),
  /** DRAFT | CODED | SUBMITTED | PENDING | APPROVED | REJECTED | PAID */
  status: varchar('status', { length: 16 }).notNull().default('DRAFT'),
  version: integer('version').notNull().default(1),
  notes: text('notes'),
  submittedAt: timestamp('submitted_at', { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const claimEvents = pgTable('claim_events', {
  id: id(),
  claimId: uuid('claim_id').notNull().references(() => claims.id),
  fromStatus: varchar('from_status', { length: 16 }),
  toStatus: varchar('to_status', { length: 16 }).notNull(),
  note: text('note'),
  actorId: uuid('actor_id').notNull(),
  createdAt: createdAt(),
});

/* ============================== KEUANGAN (GL) ============================== */

export const accounts = pgTable(
  'accounts',
  {
    id: id(),
    facilityId: facilityId(),
    code: varchar('code', { length: 16 }).notNull(),
    name: text('name').notNull(),
    /** ASSET | LIABILITY | EQUITY | REVENUE | EXPENSE */
    type: varchar('type', { length: 16 }).notNull(),
    /** D | C */
    normalBalance: varchar('normal_balance', { length: 1 }).notNull(),
    parentCode: varchar('parent_code', { length: 16 }),
    isPostable: boolean('is_postable').notNull().default(true),
  },
  (t) => [uniqueIndex('accounts_facility_code').on(t.facilityId, t.code)],
);

export const costCenters = pgTable('cost_centers', {
  id: id(),
  facilityId: facilityId(),
  code: varchar('code', { length: 16 }).notNull(),
  name: text('name').notNull(),
  unitId: uuid('unit_id'),
});

export const journalEntries = pgTable('journal_entries', {
  id: id(),
  facilityId: facilityId(),
  journalNo: varchar('journal_no', { length: 32 }).notNull(),
  date: date('date').notNull(),
  description: text('description').notNull(),
  sourceType: varchar('source_type', { length: 32 }).notNull(),
  sourceId: uuid('source_id'),
  /** POSTED | REVERSED */
  status: varchar('status', { length: 8 }).notNull().default('POSTED'),
  reversalOf: uuid('reversal_of'),
  postedBy: uuid('posted_by'),
  createdAt: createdAt(),
});

export const journalLines = pgTable('journal_lines', {
  id: id(),
  journalId: uuid('journal_id').notNull().references(() => journalEntries.id),
  accountCode: varchar('account_code', { length: 16 }).notNull(),
  costCenterId: uuid('cost_center_id'),
  debit: money('debit').notNull().default(0),
  credit: money('credit').notNull().default(0),
  memo: text('memo'),
});

/* ========================= MUTU & KESELAMATAN PASIEN ========================= */

/** Pelaporan insiden keselamatan pasien (KTD/KNC/KTC/KPC/Sentinel). */
export const incidents = pgTable('incidents', {
  id: id(),
  facilityId: facilityId(),
  incidentNo: varchar('incident_no', { length: 32 }).notNull(),
  /** KTD | KNC | KTC | KPC | SENTINEL */
  type: varchar('type', { length: 16 }).notNull(),
  /** BIRU | HIJAU | KUNING | MERAH (grading risiko) */
  riskGrade: varchar('risk_grade', { length: 8 }),
  patientId: uuid('patient_id'),
  unitId: uuid('unit_id'),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
  description: text('description').notNull(),
  immediateAction: text('immediate_action'),
  /** REPORTED | INVESTIGATING | CLOSED */
  status: varchar('status', { length: 16 }).notNull().default('REPORTED'),
  reportedBy: uuid('reported_by').notNull(),
  createdAt: createdAt(),
});

/* ============================ INTEGRASI & PLATFORM ============================ */

/** Transactional outbox — pengiriman ke SATUSEHAT/BPJS dengan retry & dead-letter. */
export const outboxMessages = pgTable(
  'outbox_messages',
  {
    id: id(),
    facilityId: facilityId(),
    /** SATUSEHAT | BPJS_VCLAIM | BPJS_ANTREAN */
    target: varchar('target', { length: 16 }).notNull(),
    resourceType: varchar('resource_type', { length: 32 }).notNull(),
    resourceId: uuid('resource_id').notNull(),
    operation: varchar('operation', { length: 16 }).notNull(),
    payload: jsonb('payload').notNull(),
    idempotencyKey: varchar('idempotency_key', { length: 128 }).notNull().unique(),
    /** PENDING | SENT | FAILED | DEAD */
    status: varchar('status', { length: 8 }).notNull().default('PENDING'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    externalId: varchar('external_id', { length: 128 }),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index('outbox_pending').on(t.status, t.nextAttemptAt)],
);

export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    key: varchar('key', { length: 128 }).notNull(),
    userId: uuid('user_id').notNull(),
    method: varchar('method', { length: 8 }).notNull(),
    path: text('path').notNull(),
    statusCode: integer('status_code').notNull(),
    responseBody: jsonb('response_body'),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.key] })],
);

/** Penomoran dokumen per fasilitas & periode (MRN, No. Registrasi, Invoice, dst). */
export const sequences = pgTable(
  'sequences',
  {
    facilityId: uuid('facility_id').notNull(),
    key: varchar('key', { length: 32 }).notNull(),
    period: varchar('period', { length: 8 }).notNull(),
    lastValue: integer('last_value').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.facilityId, t.key, t.period] })],
);

/** Audit append-only dengan hash berantai (tamper-evident). */
export const auditEvents = pgTable(
  'audit_events',
  {
    seq: bigserial('seq', { mode: 'number' }).primaryKey(),
    facilityId: uuid('facility_id'),
    actorId: uuid('actor_id'),
    actorName: text('actor_name'),
    /** CREATE | UPDATE | DELETE | READ | LOGIN | LOGIN_FAILED | BREAK_GLASS | SIGN | EXPORT … */
    action: varchar('action', { length: 32 }).notNull(),
    resourceType: varchar('resource_type', { length: 48 }).notNull(),
    resourceId: text('resource_id'),
    patientId: uuid('patient_id'),
    reason: text('reason'),
    requestId: varchar('request_id', { length: 64 }),
    ip: varchar('ip', { length: 64 }),
    metadata: jsonb('metadata'),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    prevHash: varchar('prev_hash', { length: 64 }).notNull(),
    hash: varchar('hash', { length: 64 }).notNull(),
  },
  (t) => [index('audit_patient').on(t.patientId), index('audit_resource').on(t.resourceType, t.resourceId)],
);
