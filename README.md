# SIMRS Terpadu — Hospital Management System + ERP

Implementasi end-to-end dari *Blueprint Sistem Manajemen Rumah Sakit* (v1.0, 17 Okt 2026) untuk rumah sakit & klinik di Indonesia: perjalanan pasien, layanan klinis (RME), farmasi, revenue cycle & klaim, ERP (keuangan, inventori, pengadaan), mutu, dan analitik dalam satu sumber data yang dapat diaudit.

> Rancangan ini **bukan** pernyataan sertifikasi atau jaminan kepatuhan. Seluruh integrasi, tarif, standar klinis, dan regulasi wajib diverifikasi ulang terhadap sumber resmi sebelum produksi (lihat [docs/KEPATUHAN.md](docs/KEPATUHAN.md)).

## Stack (Blueprint §5.1)

| Lapisan | Teknologi |
|---|---|
| Frontend | Angular 22 (standalone, signals, zoneless), Tailwind CSS 4, design token blueprint §7.1 |
| Backend | NestJS 12 — *modular monolith* per domain, validasi DTO Zod |
| Database | PostgreSQL 17 (produksi) · PGlite/PostgreSQL embedded (dev & test) · Drizzle ORM + migrasi SQL |
| Integrasi | Transactional outbox (retry, backoff, dead-letter, replay), FHIR R4 facade, adapter SATUSEHAT & BPJS VClaim |
| Keamanan | JWT, RBAC 16 peran + ABAC hubungan perawatan, break-glass, AES-256-GCM untuk NIK, audit append-only berantai hash |

## Menjalankan

### Pengembangan (tanpa Docker)

```bash
# Backend — database embedded tersimpan di backend/data/pglite, data demo otomatis
cd backend && npm install && npm run build && PORT=3000 npm run start:prod

# Frontend — http://localhost:4200 (proxy /api → :3000, lihat proxy.conf.json)
cd frontend && npm install && npm start
```

### Docker Compose (PostgreSQL)

```bash
export JWT_SECRET=$(openssl rand -hex 32)
export DATA_ENCRYPTION_KEY=$(openssl rand -base64 32)
SEED_DEMO=true docker compose up -d --build     # web: http://localhost:8080
```

### Akun demo

Kode fasilitas **RSDEMO**, kata sandi **`Simrs2026!`**:
`admin`, `direktur`, `dr.andi` (Sp.PD, Poli Penyakit Dalam), `dr.sari` (IGD), `dr.bima` (Sp.A), `ns.budi` & `ns.rina` (Bangsal Melati), `admisi`, `rekammedis`, `apoteker`, `lab`, `lab2`, `radiologi`, `kasir`, `casemix`, `keuangan`, `gudang`, `pengadaan`, `mutu`.

Pasien contoh (fiktif): BUDI SANTOSO (peserta JKN), SITI AMINAH (alergi amoxicillin), ANDI PUTRA (anak).

### Pengujian

```bash
cd backend
npm test            # unit: enkripsi NIK, EWS, hash audit, zona waktu
npm run test:e2e    # 20 skenario acceptance criteria blueprint §15
```

Skenario e2e mencakup: rawat jalan pasien umum (registrasi → SOAP → lab dengan nilai kritis → farmasi FEFO → kasir idempoten → jurnal seimbang), rawat inap BPJS (SEP → bed → interaksi obat → eMAR high-alert → resume medis → klaim INA-CBG → selisih tarif), alergi obat, RBAC, ABAC + break-glass, isolasi tenant, audit tidak dapat diubah, procure-to-pay dengan three-way match, outbox SATUSEHAT & FHIR.

## Peta modul (Blueprint §3)

| Domain | Backend (`backend/src/modules`) | Frontend (`frontend/src/app/pages`) |
|---|---|---|
| Front office | `patients` (MPI, dedup, merge, alergi, consent), `registration` (janji temu, antrean, RJ/IGD/RI, triase, bed, SEP, pemulangan) | patients, patient-detail, registration, appointments, queue, beds |
| Clinical | `clinical` (tanda vital + EWS, SOAP/CPPT/asesmen/resume dengan tanda tangan & amandemen, ICD-10, ICD-9-CM) , `orders` (CPOE, hasil, validasi ganda, nilai kritis) | encounters, workspace, ancillary |
| Pharmacy | `pharmacy` (CDS alergi/interaksi/duplikasi/high-alert/narkotika/non-Fornas, telaah, dispensing FEFO, eMAR closed-loop) | pharmacy, workspace › Resep/eMAR |
| Revenue cycle | `billing` (charge capture otomatis, invoice pasien vs penjamin, kasir, void, AR aging, rekap kasir), `claims` (coding, INA-CBG, mesin status, appeal, pembayaran & rekonsiliasi) | billing, billing-encounter, invoice, claims |
| ERP Finance | `finance` (bagan akun, jurnal double-entry, pembalikan, neraca saldo, laba rugi, neraca) | finance |
| ERP Operations | `inventory` (batch/ED, FEFO, mutasi, opname, saldo awal), `procurement` (PR → PO → GR+inspeksi → faktur 3-way match → bayar, evaluasi vendor, segregation of duties) | inventory, procurement |
| Management | `management` (BOR/ALOS/TOI/BTO/GDR, 10 besar penyakit, kunjungan per unit, insiden keselamatan pasien, audit) | home, quality, governance |
| Platform | `iam` (login + lockout, pengguna, break-glass), `master` (configurator), `integration` (outbox, SATUSEHAT, BPJS, FHIR) | users, master, governance |

## Posting jurnal otomatis

| Peristiwa | Debit | Kredit |
|---|---|---|
| Invoice terbit | Piutang pasien / BPJS / asuransi | Pendapatan per jenis layanan |
| Pembayaran kasir | Kas / Bank | Piutang |
| Dispensing obat | HPP obat | Persediaan |
| Penerimaan barang | Persediaan | Utang belum ditagih |
| Faktur pemasok | Utang belum ditagih + PPN masukan | Utang usaha |
| Bayar pemasok | Utang usaha | Bank |
| Klaim dibayar | Bank ± Selisih tarif klaim | Piutang penjamin |
| Stock opname | Persediaan ↔ Beban selisih persediaan | |

## Konfigurasi penting (env backend)

| Variabel | Keterangan |
|---|---|
| `DATABASE_URL` | PostgreSQL produksi. Kosong → PGlite (`PGLITE_DIR`, `memory` untuk in-memory) |
| `JWT_SECRET`, `DATA_ENCRYPTION_KEY` | Wajib di production (kunci 32 byte base64, simpan di secret manager/KMS) |
| `SEED_DEMO` | `true` membuat fasilitas RSDEMO |
| `SATUSEHAT_MODE` | `mock` (default) / `sandbox` / `production` + `SATUSEHAT_CLIENT_ID/SECRET` |
| `BPJS_MODE` | `mock` (default) / `live` + `BPJS_CONS_ID/SECRET_KEY/USER_KEY/VCLAIM_URL` |
| `OUTBOX_WORKER` | `false` untuk menonaktifkan worker integrasi |
| `CORS_ORIGIN`, `BREAK_GLASS_MINUTES`, `JWT_EXPIRES_IN` | |

## Kontrak API

Basis `/api/v1`. Semua mutasi menerima `Idempotency-Key` (frontend mengirim otomatis) dan `X-Request-Id`; error berformat stabil `{ error: { code, message, details }, requestId }`. FHIR facade: `/api/v1/fhir/R4/{metadata, Patient/:id, Encounter/:id, Condition?encounter=, Observation?encounter=}`. Kesehatan layanan: `/health`.

## Status & batasan yang perlu diketahui

- **Integrasi eksternal berjalan dalam mode simulasi.** Adapter SATUSEHAT (OAuth2 + FHIR) dan BPJS VClaim (signature HMAC, dekripsi AES + LZ-string) sudah ditulis, tetapi belum diuji terhadap sandbox resmi karena memerlukan registrasi & kredensial. Struktur payload SEP/FHIR wajib divalidasi terhadap katalog versi berlaku.
- **INA-CBG**: kode & tarif diinput petugas casemix dari aplikasi E-Klaim; grouper tidak disertakan.
- **Data referensi** (ICD-10, ICD-9-CM, formularium, interaksi obat) hanya subset demo — impor data resmi sebelum go-live.
- **Isolasi tenant** saat ini di level aplikasi (`facility_id` + guard + uji isolasi). Untuk SaaS data klinis multi-RS, blueprint §10 menyarankan isolasi schema/database per tenant dan kunci enkripsi per tenant — belum diterapkan.
- **Belum dibangun (P2 blueprint)**: HR/payroll, CMMS/aset tetap, cost accounting, portal pasien, MFA/SSO (OIDC), PACS/DICOM, LIS/RIS dengan HL7 v2, laporan RL SIRS lengkap.
- Frontend telah dibangun (`ng build` bersih) dan diuji asap lewat API; pengujian usability per persona (blueprint §15) belum dilakukan.
