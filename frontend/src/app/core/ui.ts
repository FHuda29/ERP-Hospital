import { Injectable, Pipe, PipeTransform, signal } from '@angular/core';
import { ApiError } from './api';

export interface Toast {
  id: number;
  kind: 'success' | 'error' | 'info' | 'warning';
  text: string;
}

@Injectable({ providedIn: 'root' })
export class Toasts {
  readonly items = signal<Toast[]>([]);
  private seq = 0;

  show(kind: Toast['kind'], text: string, ms = 4500) {
    const id = ++this.seq;
    this.items.update((x) => [...x, { id, kind, text }]);
    setTimeout(() => this.dismiss(id), ms);
  }
  success(text: string) {
    this.show('success', text);
  }
  error(e: unknown) {
    this.show('error', e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e), 7000);
  }
  dismiss(id: number) {
    this.items.update((x) => x.filter((t) => t.id !== id));
  }
}

const rupiah = new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 });
const number = new Intl.NumberFormat('id-ID', { maximumFractionDigits: 2 });

export const fmtRp = (n: number | string | null | undefined) => (n === null || n === undefined ? '—' : rupiah.format(Number(n)));
export const fmtNum = (n: number | string | null | undefined) => (n === null || n === undefined ? '—' : number.format(Number(n)));

const TZ_LABEL: Record<string, string> = { 'Asia/Jakarta': 'WIB', 'Asia/Makassar': 'WITA', 'Asia/Jayapura': 'WIT' };
let facilityTz = 'Asia/Jakarta';
export const setFacilityTimezone = (tz: string) => (facilityTz = tz);
export const tzLabel = () => TZ_LABEL[facilityTz] ?? facilityTz;

/** Tanggal-waktu dengan zona waktu fasilitas yang eksplisit (WIB/WITA/WIT). */
export function fmtDateTime(v: string | Date | null | undefined, withTime = true): string {
  if (!v) return '—';
  const d = typeof v === 'string' ? new Date(v) : v;
  const s = new Intl.DateTimeFormat('id-ID', {
    timeZone: facilityTz,
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}),
  }).format(d);
  return withTime ? `${s} ${tzLabel()}` : s;
}

export function fmtDate(v: string | null | undefined): string {
  if (!v) return '—';
  const [y, m, d] = v.slice(0, 10).split('-').map(Number);
  return new Intl.DateTimeFormat('id-ID', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, d)));
}

export function todayIso(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: facilityTz }).format(new Date());
}

export function age(birthDate: string): string {
  const b = new Date(birthDate);
  const n = new Date();
  let y = n.getFullYear() - b.getFullYear();
  let m = n.getMonth() - b.getMonth();
  if (n.getDate() < b.getDate()) m--;
  if (m < 0) {
    y--;
    m += 12;
  }
  return y > 0 ? `${y} th` : `${m} bln`;
}

export const fmtMrn = (mrn: string) => (mrn ? mrn.replace(/^(\d{2})(\d{2})(\d{2})(\d{2})$/, '$1-$2-$3-$4') : '');

@Pipe({ name: 'rp' })
export class RpPipe implements PipeTransform {
  transform = fmtRp;
}
@Pipe({ name: 'num' })
export class NumPipe implements PipeTransform {
  transform = fmtNum;
}
@Pipe({ name: 'dt' })
export class DtPipe implements PipeTransform {
  transform(v: string | Date | null | undefined, withTime = true) {
    return fmtDateTime(v, withTime);
  }
}
@Pipe({ name: 'd' })
export class DPipe implements PipeTransform {
  transform = fmtDate;
}
@Pipe({ name: 'mrn' })
export class MrnPipe implements PipeTransform {
  transform = fmtMrn;
}
@Pipe({ name: 'age' })
export class AgePipe implements PipeTransform {
  transform = age;
}

export const PIPES = [RpPipe, NumPipe, DtPipe, DPipe, MrnPipe, AgePipe];

/** Label & warna status yang konsisten. Warna tidak pernah satu-satunya penanda (selalu ada teks). */
export const STATUS: Record<string, { label: string; tone: string }> = {
  REGISTERED: { label: 'Terdaftar', tone: 'neutral' },
  TRIAGED: { label: 'Sudah triase', tone: 'info' },
  IN_PROGRESS: { label: 'Dilayani', tone: 'info' },
  FINISHED: { label: 'Selesai', tone: 'success' },
  CANCELLED: { label: 'Batal', tone: 'neutral' },
  WAITING: { label: 'Menunggu', tone: 'neutral' },
  CALLED: { label: 'Dipanggil', tone: 'warning' },
  SERVING: { label: 'Dilayani', tone: 'info' },
  DONE: { label: 'Selesai', tone: 'success' },
  SKIPPED: { label: 'Dilewati', tone: 'neutral' },
  ORDERED: { label: 'Diorder', tone: 'neutral' },
  RESULTED: { label: 'Hasil keluar', tone: 'warning' },
  VERIFIED: { label: 'Tervalidasi', tone: 'success' },
  SUBMITTED: { label: 'Diajukan', tone: 'info' },
  DISPENSED: { label: 'Diserahkan', tone: 'success' },
  REJECTED: { label: 'Ditolak', tone: 'critical' },
  DRAFT: { label: 'Draf', tone: 'neutral' },
  SIGNED: { label: 'Ditandatangani', tone: 'success' },
  ISSUED: { label: 'Belum bayar', tone: 'warning' },
  PARTIAL: { label: 'Sebagian', tone: 'warning' },
  PAID: { label: 'Lunas', tone: 'success' },
  VOID: { label: 'Void', tone: 'neutral' },
  CODED: { label: 'Dikoding', tone: 'info' },
  PENDING: { label: 'Pending', tone: 'warning' },
  APPROVED: { label: 'Disetujui', tone: 'success' },
  RECEIVED: { label: 'Diterima', tone: 'success' },
  ORDERED_PR: { label: 'Dipesan', tone: 'info' },
  OPEN: { label: 'Terbuka', tone: 'warning' },
  SENT: { label: 'Terkirim', tone: 'success' },
  FAILED: { label: 'Gagal (retry)', tone: 'warning' },
  DEAD: { label: 'Dead-letter', tone: 'critical' },
  AVAILABLE: { label: 'Tersedia', tone: 'success' },
  OCCUPIED: { label: 'Terisi', tone: 'info' },
  CLEANING: { label: 'Dibersihkan', tone: 'warning' },
  MAINTENANCE: { label: 'Perbaikan', tone: 'neutral' },
  REPORTED: { label: 'Dilaporkan', tone: 'warning' },
  INVESTIGATING: { label: 'Investigasi', tone: 'info' },
  CLOSED: { label: 'Ditutup', tone: 'success' },
  ACTIVE: { label: 'Aktif', tone: 'success' },
  MERGED: { label: 'Digabung', tone: 'neutral' },
  DECEASED: { label: 'Meninggal', tone: 'neutral' },
};

export const TRIAGE: Record<number, { label: string; tone: string }> = {
  1: { label: 'P1 Merah — Resusitasi', tone: 'critical' },
  2: { label: 'P2 Merah — Emergensi', tone: 'critical' },
  3: { label: 'P3 Kuning — Urgen', tone: 'warning' },
  4: { label: 'P4 Hijau — Kurang urgen', tone: 'success' },
  5: { label: 'P5 Hijau — Tidak urgen', tone: 'success' },
};

export const ENCOUNTER_TYPE: Record<string, string> = { RAWAT_JALAN: 'Rawat Jalan', IGD: 'IGD', RAWAT_INAP: 'Rawat Inap' };
