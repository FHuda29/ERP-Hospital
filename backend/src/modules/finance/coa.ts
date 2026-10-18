/**
 * Bagan akun standar rumah sakit (disederhanakan, mengacu struktur SAK/SAK EP & BLUD).
 * Dapat dikonfigurasi per fasilitas; kode di bawah dipakai oleh posting otomatis.
 */
export const ACC = {
  KAS_KASIR: '1-1110',
  BANK: '1-1200',
  PIUTANG_PASIEN: '1-1300',
  PIUTANG_BPJS: '1-1310',
  PIUTANG_ASURANSI: '1-1320',
  PERSEDIAAN_FARMASI: '1-1400',
  PPN_MASUKAN: '1-1500',
  ASET_TETAP_ALKES: '1-2100',
  UTANG_USAHA: '2-1100',
  UTANG_BELUM_DITAGIH: '2-1110',
  UTANG_PAJAK: '2-1200',
  UANG_MUKA_PASIEN: '2-1300',
  EKUITAS: '3-1000',
  PDP_KONSULTASI: '4-1100',
  PDP_TINDAKAN: '4-1200',
  PDP_LAB: '4-1300',
  PDP_RADIOLOGI: '4-1400',
  PDP_FARMASI: '4-1500',
  PDP_AKOMODASI: '4-1600',
  PDP_ADMINISTRASI: '4-1700',
  SELISIH_KLAIM: '4-1900',
  HPP_FARMASI: '5-1100',
  BEBAN_GAJI: '5-2100',
  BEBAN_PERSEDIAAN: '5-3100',
} as const;

type AccType = 'ASSET' | 'LIABILITY' | 'EQUITY' | 'REVENUE' | 'EXPENSE';
export const DEFAULT_COA: { code: string; name: string; type: AccType; parentCode?: string; isPostable?: boolean }[] = [
  { code: '1-0000', name: 'ASET', type: 'ASSET', isPostable: false },
  { code: '1-1110', name: 'Kas Kasir', type: 'ASSET', parentCode: '1-0000' },
  { code: '1-1200', name: 'Bank', type: 'ASSET', parentCode: '1-0000' },
  { code: '1-1300', name: 'Piutang Pasien Umum', type: 'ASSET', parentCode: '1-0000' },
  { code: '1-1310', name: 'Piutang BPJS Kesehatan', type: 'ASSET', parentCode: '1-0000' },
  { code: '1-1320', name: 'Piutang Asuransi & Perusahaan', type: 'ASSET', parentCode: '1-0000' },
  { code: '1-1400', name: 'Persediaan Obat & BMHP', type: 'ASSET', parentCode: '1-0000' },
  { code: '1-1500', name: 'PPN Masukan', type: 'ASSET', parentCode: '1-0000' },
  { code: '1-2100', name: 'Aset Tetap — Alat Kesehatan', type: 'ASSET', parentCode: '1-0000' },
  { code: '2-0000', name: 'LIABILITAS', type: 'LIABILITY', isPostable: false },
  { code: '2-1100', name: 'Utang Usaha', type: 'LIABILITY', parentCode: '2-0000' },
  { code: '2-1110', name: 'Utang Barang Diterima Belum Ditagih', type: 'LIABILITY', parentCode: '2-0000' },
  { code: '2-1200', name: 'Utang Pajak', type: 'LIABILITY', parentCode: '2-0000' },
  { code: '2-1300', name: 'Uang Muka / Deposit Pasien', type: 'LIABILITY', parentCode: '2-0000' },
  { code: '3-0000', name: 'EKUITAS', type: 'EQUITY', isPostable: false },
  { code: '3-1000', name: 'Ekuitas / Modal', type: 'EQUITY', parentCode: '3-0000' },
  { code: '4-0000', name: 'PENDAPATAN', type: 'REVENUE', isPostable: false },
  { code: '4-1100', name: 'Pendapatan Jasa Konsultasi & Visite', type: 'REVENUE', parentCode: '4-0000' },
  { code: '4-1200', name: 'Pendapatan Tindakan Medis', type: 'REVENUE', parentCode: '4-0000' },
  { code: '4-1300', name: 'Pendapatan Laboratorium', type: 'REVENUE', parentCode: '4-0000' },
  { code: '4-1400', name: 'Pendapatan Radiologi', type: 'REVENUE', parentCode: '4-0000' },
  { code: '4-1500', name: 'Pendapatan Farmasi', type: 'REVENUE', parentCode: '4-0000' },
  { code: '4-1600', name: 'Pendapatan Akomodasi Rawat Inap', type: 'REVENUE', parentCode: '4-0000' },
  { code: '4-1700', name: 'Pendapatan Administrasi', type: 'REVENUE', parentCode: '4-0000' },
  { code: '4-1900', name: 'Selisih Tarif Klaim (INA-CBG vs Tarif RS)', type: 'REVENUE', parentCode: '4-0000' },
  { code: '5-0000', name: 'BEBAN', type: 'EXPENSE', isPostable: false },
  { code: '5-1100', name: 'Harga Pokok Obat & BMHP', type: 'EXPENSE', parentCode: '5-0000' },
  { code: '5-2100', name: 'Beban Gaji & Jasa Pelayanan', type: 'EXPENSE', parentCode: '5-0000' },
  { code: '5-3100', name: 'Beban Selisih / Kedaluwarsa Persediaan', type: 'EXPENSE', parentCode: '5-0000' },
];

export const receivableAccountFor = (payerType: string) =>
  payerType === 'BPJS' ? ACC.PIUTANG_BPJS : payerType === 'UMUM' ? ACC.PIUTANG_PASIEN : ACC.PIUTANG_ASURANSI;
