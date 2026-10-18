/** Pembulatan Rupiah 2 desimal. */
export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** Tanggal hari ini (YYYY-MM-DD) pada zona waktu fasilitas (WIB/WITA/WIT). */
export function todayIn(timezone: string, at: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}

/** Periode YYYYMM dari tanggal YYYY-MM-DD. */
export const periodOf = (isoDate: string) => isoDate.slice(0, 7).replace('-', '');

/** Selisih hari kalender (minimal 1) — dasar hitung hari rawat. */
export function careDays(startIso: string, endIso: string): number {
  const ms = Date.parse(endIso.slice(0, 10)) - Date.parse(startIso.slice(0, 10));
  return Math.max(1, Math.round(ms / 86_400_000));
}

export function ageInYears(birthDate: string, at: Date = new Date()): number {
  const b = new Date(birthDate);
  let age = at.getFullYear() - b.getFullYear();
  const m = at.getMonth() - b.getMonth();
  if (m < 0 || (m === 0 && at.getDate() < b.getDate())) age--;
  return age;
}

export const sum = (xs: number[]) => round2(xs.reduce((a, b) => a + b, 0));
