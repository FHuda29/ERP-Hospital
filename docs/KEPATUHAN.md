# Ketertelusuran Regulasi & Kontrol (Blueprint §8–9, §15)

Tabel ini memetakan persyaratan ke implementasi agar mudah diverifikasi oleh tim hukum, komite rekam medis, dan auditor. **Rujukan regulasi wajib dicek ulang ke naskah resmi terbaru (JDIH Kemenkes, peraturan.bpk.go.id).**

| Rujukan | Persyaratan (ringkas) | Implementasi | Lokasi |
|---|---|---|---|
| Permenkes 24/2022 (Rekam Medis) | RME memuat identitas, asesmen, diagnosis, tindakan, resume; dapat ditelusuri perubahan; akses terbatas | Catatan SOAP/CPPT/asesmen/resume; tanda tangan elektronik dengan hash SHA-256; catatan bertanda tangan tidak dapat diubah, koreksi melalui amandemen beralasan; resume medis wajib sebelum pulang rawat inap | `modules/clinical`, `modules/registration` (discharge) |
| Permenkes 24/2022 | Integrasi ke SATUSEHAT | Outbox Encounter/Condition/Observation (FHIR R4), IHS lookup via NIK, mode mock/sandbox/production | `modules/integration` |
| UU 27/2022 (PDP) | Data kesehatan = data pribadi spesifik; keamanan, pembatasan akses, akuntabilitas | NIK terenkripsi AES-256-GCM + hash HMAC untuk pencarian; masking; pembukaan NIK wajib alasan & diaudit; RBAC + ABAC; break-glass berbatas waktu & ditinjau; audit akses baca RME; payload outbox hanya referensi (minim PHI); error tidak membocorkan detail | `core/crypto.service.ts`, `core/care-access.service.ts`, `modules/iam`, `core/audit.service.ts` |
| UU 17/2023 (Kesehatan) | Kerahasiaan & keselamatan pasien | Kontrol di atas + keselamatan klinis di bawah | — |
| Permenkes 82/2013 (SIMRS) | SIMRS terintegrasi, keamanan & kerahasiaan, interoperabilitas | Modul terpadu satu basis data; API berversi; FHIR facade | seluruh repo |
| Permenkes 11/2017 (Keselamatan Pasien) | Pelaporan insiden KTD/KNC/KTC/KPC/sentinel, grading | Modul insiden + grading BIRU–MERAH | `modules/management` |
| Sasaran Keselamatan Pasien | Identifikasi 2 identitas; obat high-alert; komunikasi hasil kritis | Patient banner (nama + RM + tgl lahir + alergi); eMAR wajib verifikasi 2 identitas & double check perawat lain untuk high-alert; hasil HH/LL → notifikasi & konfirmasi dokter | `shared/components.ts`, `modules/pharmacy`, `modules/orders` |
| Standar pelayanan kefarmasian | Telaah resep, CDS | Cek alergi, interaksi (MAJOR memblokir tanpa alasan), duplikasi, high-alert, narkotika (SIPNAP), non-Fornas JKN; telaah apoteker sebelum serah; FEFO | `modules/pharmacy`, `modules/inventory` |
| BPJS Kesehatan (VClaim, klaim) | Eligibilitas, SEP, klaim INA-CBG | Cek peserta & SEP saat registrasi (fallback bila layanan BPJS tak tersedia), klaim dengan coding & mesin status, selisih tarif terjurnal | `modules/integration/bpjs.client.ts`, `modules/claims` |
| Perpres 59/2024 (KRIS) | Kelas Rawat Inap Standar | Kelas `KRIS` pada ruang & tarif | `database/schema.ts`, seed |
| Akuntansi (SAK/BLUD) | Pencatatan double-entry, jejak dokumen | Ledger seimbang tervalidasi, pembalikan (tanpa hapus), posting otomatis dari dokumen sumber | `modules/finance` |
| Pengendalian internal | Segregation of duties | Pemohon PR/pembuat PO tidak dapat menyetujui sendiri; validasi hasil lab oleh petugas berbeda; three-way match | `modules/procurement`, `modules/orders` |
| Tata kelola data | Audit tamper-evident | `audit_events` append-only (trigger DB menolak UPDATE/DELETE) + hash berantai + endpoint verifikasi | `database/database.ts`, `core/audit.service.ts` |

## Kontrol keamanan aplikasi

- Login: lockout 15 menit setelah 5 kali gagal; kebijakan kata sandi; bcrypt cost 12; sesi frontend di `sessionStorage` (tertutup bersama tab).
- Header keamanan (helmet/nginx), CORS terbatas, validasi semua input (Zod), error code stabil.
- Idempotency-Key pada mutasi (mencegah pembayaran/transaksi ganda saat retry).
- Request-ID untuk korelasi log.

## Sebelum produksi (wajib)

1. Ganti `JWT_SECRET` & `DATA_ENCRYPTION_KEY` dengan rahasia dari secret manager; rencanakan rotasi kunci.
2. Registrasi organisasi/lokasi/praktisi SATUSEHAT; uji sandbox; isi `satusehat_*_id` di master data.
3. Perjanjian kerja sama & kredensial BPJS; validasi payload VClaim/antrean terhadap katalog terbaru.
4. Impor ICD-10/ICD-9-CM resmi, KFA, formularium RS, interaksi obat dari sumber tervalidasi.
5. Tetapkan tarif resmi (SK direksi/Perda untuk RSUD-BLUD) dan bagan akun final.
6. DPIA, threat model, pentest, uji restore, BCP/DRP, kebijakan retensi RME (minimal sesuai Permenkes 24/2022).
7. MFA/SSO untuk peran sensitif; pertimbangkan isolasi schema per tenant untuk SaaS.
8. UAT klinis per persona, pelatihan, cutover & rollback plan (blueprint §13).
