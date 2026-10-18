import { Component, computed, inject, input, OnInit, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Api, AuthService } from '../core/api';
import { ENCOUNTER_TYPE, PIPES, Toasts, fmtRp } from '../core/ui';
import { SHARED } from '../shared/components';

interface TrendPoint {
  date: string;
  amount: number;
}

/** Grafik batang satu seri (pendapatan harian) — SVG, hover tooltip, tabel alternatif. */
@Component({
  selector: 'app-revenue-chart',
  template: `
    <div class="flex items-center justify-between mb-2">
      <h3 class="h2">Pendapatan harian (30 hari)</h3>
      <button class="btn btn-sm btn-ghost" (click)="asTable.set(!asTable())">{{ asTable() ? 'Lihat grafik' : 'Lihat tabel' }}</button>
    </div>
    @if (asTable()) {
      <div class="max-h-64 overflow-y-auto">
        <table class="tbl">
          <thead><tr><th>Tanggal</th><th class="num">Pendapatan</th></tr></thead>
          <tbody>
            @for (p of points(); track p.date) {
              <tr><td>{{ p.date }}</td><td class="num">{{ rp(p.amount) }}</td></tr>
            }
          </tbody>
        </table>
      </div>
    } @else if (!points().length) {
      <div class="text-ink-3 text-sm py-12 text-center">Belum ada pendapatan tercatat</div>
    } @else {
      <div class="relative">
        <svg [attr.viewBox]="'0 0 ' + W + ' ' + H" class="w-full h-56" role="img" aria-label="Grafik pendapatan harian">
          @for (g of grid(); track g.y) {
            <line [attr.x1]="padL" [attr.x2]="W" [attr.y1]="g.y" [attr.y2]="g.y" stroke="#e4e7ec" stroke-width="1" />
            <text [attr.x]="padL - 6" [attr.y]="g.y + 4" text-anchor="end" font-size="10" fill="#667085">{{ g.label }}</text>
          }
          @for (b of bars(); track b.date) {
            <path [attr.d]="b.path" fill="#175CD3" [attr.opacity]="hover()?.date === b.date ? 1 : 0.85" />
            <rect [attr.x]="b.x - 2" [attr.y]="0" [attr.width]="b.w + 4" [attr.height]="H - padB" fill="transparent" (mouseenter)="hover.set(b)" (mouseleave)="hover.set(null)" />
          }
          <line [attr.x1]="padL" [attr.x2]="W" [attr.y1]="H - padB" [attr.y2]="H - padB" stroke="#98a2b3" stroke-width="1" />
          @for (b of bars(); track b.date; let i = $index) {
            @if (i % 5 === 0 || $last) {
              <text [attr.x]="b.x + b.w / 2" [attr.y]="H - 6" text-anchor="middle" font-size="10" fill="#667085">{{ b.date.slice(5) }}</text>
            }
          }
        </svg>
        @if (hover(); as h) {
          <div class="absolute pointer-events-none card px-2 py-1 text-xs shadow-md" [style.left.%]="(h.x / W) * 100" style="top: 0; transform: translateX(-40%)">
            <div class="text-ink-3">{{ h.date }}</div>
            <div class="font-semibold tabular-nums">{{ rp(h.amount) }}</div>
          </div>
        }
      </div>
    }
  `,
})
export class RevenueChart {
  readonly points = input<TrendPoint[]>([]);
  readonly asTable = signal(false);
  readonly hover = signal<(TrendPoint & { x: number; w: number }) | null>(null);
  readonly W = 640;
  readonly H = 220;
  readonly padL = 56;
  readonly padB = 22;
  readonly rp = fmtRp;

  private readonly max = computed(() => Math.max(1, ...this.points().map((p) => p.amount)));
  readonly grid = computed(() => {
    const max = this.max();
    return [0, 0.5, 1].map((f) => ({ y: this.H - this.padB - f * (this.H - this.padB - 10), label: f === 0 ? '0' : `${Math.round((max * f) / 1000)}rb` }));
  });
  readonly bars = computed(() => {
    const pts = this.points();
    const plotW = this.W - this.padL;
    const step = plotW / Math.max(pts.length, 1);
    const w = Math.max(4, Math.min(24, step - 2));
    const base = this.H - this.padB;
    return pts.map((p, i) => {
      const h = Math.max(0, (p.amount / this.max()) * (base - 10));
      const x = this.padL + i * step + (step - w) / 2;
      const r = Math.min(4, w / 2, h);
      const top = base - h;
      // Batang dengan ujung data membulat 4px, menempel ke baseline
      const path = h <= 0 ? '' : `M${x},${base} V${top + r} Q${x},${top} ${x + r},${top} H${x + w - r} Q${x + w},${top} ${x + w},${top + r} V${base} Z`;
      return { ...p, x, w, path };
    });
  });
}

@Component({
  selector: 'app-home',
  imports: [RouterLink, RevenueChart, ...SHARED, ...PIPES],
  template: `
    <app-page-header [title]="'Selamat datang, ' + (auth.user()?.name ?? '')" [subtitle]="auth.user()?.facility?.name" />

    @if (critical().length) {
      <div class="alert alert-critical mb-4" role="alert">
        <div class="font-semibold mb-1">⚠ {{ critical().length }} hasil kritis menunggu konfirmasi Anda</div>
        @for (c of critical(); track c.orderId) {
          <div class="flex items-center gap-2 text-sm">
            <a class="underline" [routerLink]="['/encounters', c.encounterId]">{{ c.patientName }} ({{ c.mrn | mrn }})</a> — {{ c.serviceName }}:
            @for (o of c.observations; track o.name) { @if (o.flag === 'HH' || o.flag === 'LL') { <b>{{ o.name }} {{ o.value }} {{ o.unit }}</b> } }
          </div>
        }
      </div>
    }

    @if (overview(); as o) {
      <div class="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
        <div class="card card-pad"><div class="muted">Kunjungan hari ini</div><div class="text-2xl font-semibold tabular-nums">{{ totalVisits() }}</div>
          <div class="text-xs text-ink-2">@for (v of o.visits; track v.type) { {{ types[v.type] }} {{ v.count }} · }</div></div>
        <div class="card card-pad"><div class="muted">Antrean menunggu</div><div class="text-2xl font-semibold tabular-nums">{{ o.queue?.waiting ?? 0 }}</div>
          <div class="text-xs text-ink-2">Rata-rata tunggu {{ (o.queue?.avgWaitMin ?? 0) | num }} menit</div></div>
        <div class="card card-pad"><div class="muted">BOR bulan ini</div><div class="text-2xl font-semibold tabular-nums">{{ o.inpatient.bor | num }}%</div>
          <div class="text-xs text-ink-2">ALOS {{ o.inpatient.alos | num }} hr · TOI {{ o.inpatient.toi | num }} hr · BTO {{ o.inpatient.bto | num }}×</div></div>
        <div class="card card-pad"><div class="muted">Pendapatan bulan ini</div><div class="text-2xl font-semibold tabular-nums">{{ o.revenue.month | rp }}</div>
          <div class="text-xs text-ink-2">Hari ini {{ o.revenue.today | rp }}</div></div>
      </div>
      <div class="grid lg:grid-cols-3 gap-4 mb-4">
        <div class="card card-pad lg:col-span-2"><app-revenue-chart [points]="o.revenueTrend" /></div>
        <div class="card card-pad">
          <h3 class="h2 mb-2">Status tempat tidur</h3>
          <table class="tbl">
            <tbody>
              @for (b of o.bedStatus; track b.status) {
                <tr><td><app-status [value]="b.status" /></td><td class="num font-semibold">{{ b.count }}</td></tr>
              }
            </tbody>
          </table>
          <div class="text-xs text-ink-3 mt-3">Pasien keluar bulan ini: {{ o.inpatient.discharges }} · Meninggal: {{ o.inpatient.deaths }} (GDR {{ o.inpatient.gdr | num }}‰)</div>
          <h3 class="h2 mt-4 mb-2">10 besar diagnosis</h3>
          <ol class="text-sm space-y-1">
            @for (d of topDx(); track d.code) {
              <li class="flex justify-between gap-2"><span class="truncate"><b>{{ d.code }}</b> {{ d.display }}</span><span class="tabular-nums">{{ d.count }}</span></li>
            } @empty { <li class="text-ink-3">Belum ada data</li> }
          </ol>
        </div>
      </div>
    }

    @if (myPatients().length || auth.hasRole('DOKTER', 'PERAWAT', 'BIDAN')) {
      <div class="card mb-4">
        <div class="px-4 py-3 border-b border-line flex justify-between items-center">
          <h3 class="h2">{{ auth.hasRole('PERAWAT', 'BIDAN') ? 'Pasien di unit saya' : 'Pasien saya (DPJP)' }}</h3>
          <a class="btn btn-sm" routerLink="/encounters">Semua kunjungan</a>
        </div>
        <table class="tbl">
          <thead><tr><th>Pasien</th><th>Kunjungan</th><th>Unit</th><th>Status</th><th></th></tr></thead>
          <tbody>
            @for (e of myPatients(); track e.id) {
              <tr>
                <td><b>{{ e.patientName }}</b><div class="muted">RM {{ e.mrn | mrn }} · {{ e.birthDate | age }}</div></td>
                <td>{{ e.encounterNo }}<div class="muted">{{ types[e.type] }} · {{ e.payerName }}</div></td>
                <td>{{ e.unitName }}</td>
                <td><app-status [value]="e.status" /> <app-triage [level]="e.triageLevel" /></td>
                <td><a class="btn btn-sm btn-primary" [routerLink]="['/encounters', e.id]">Buka</a></td>
              </tr>
            } @empty { <tr><td colspan="5"><app-empty text="Tidak ada pasien aktif" /></td></tr> }
          </tbody>
        </table>
      </div>
    }

    <div class="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
      @for (q of quick(); track q.path) {
        <a class="card card-pad hover:border-primary" [routerLink]="q.path">
          <div class="font-medium">{{ q.label }}</div>
          <div class="muted">{{ q.hint }}</div>
        </a>
      }
    </div>
  `,
})
export class HomePage implements OnInit {
  readonly auth = inject(AuthService);
  private readonly api = inject(Api);
  private readonly toasts = inject(Toasts);
  readonly types = ENCOUNTER_TYPE;
  readonly overview = signal<any>(null);
  readonly topDx = signal<any[]>([]);
  readonly critical = signal<any[]>([]);
  readonly myPatients = signal<any[]>([]);
  readonly totalVisits = computed(() => (this.overview()?.visits ?? []).reduce((s: number, v: any) => s + v.count, 0));

  readonly quick = computed(() =>
    [
      { label: 'Daftarkan pasien', hint: 'Rawat jalan, IGD, rawat inap', path: '/registration', perm: 'encounter.write' },
      { label: 'Antrean poli', hint: 'Panggil pasien berikutnya', path: '/queue', perm: 'queue.manage' },
      { label: 'Resep masuk', hint: 'Telaah & penyerahan obat', path: '/pharmacy', perm: 'rx.verify' },
      { label: 'Worklist lab', hint: 'Sampel, hasil, validasi', path: '/ancillary/LAB', perm: 'order.process' },
      { label: 'Kasir', hint: 'Tagihan & pembayaran', path: '/billing', perm: 'billing.write' },
      { label: 'Klaim', hint: 'Coding & pengajuan', path: '/claims', perm: 'claim.write' },
      { label: 'Stok kritis', hint: 'Minimum & kedaluwarsa', path: '/inventory', perm: 'inventory.read' },
      { label: 'Laporan keuangan', hint: 'Neraca saldo, laba rugi', path: '/finance', perm: 'finance.read' },
    ].filter((q) => this.auth.can(q.perm)),
  );

  async ngOnInit() {
    try {
      if (this.auth.can('dashboard.read')) {
        const [o, top] = await Promise.all([this.api.get('/dashboard/overview'), this.api.get('/dashboard/top-diagnoses')]);
        this.overview.set(o);
        this.topDx.set(top);
      }
      if (this.auth.can('clinical.read') && this.auth.user()?.practitionerId) {
        this.critical.set(await this.api.get('/orders/critical'));
      }
      if (this.auth.hasRole('DOKTER')) {
        this.myPatients.set(await this.api.get('/encounters', { active: 'true', mine: 'true' }));
      } else if (this.auth.hasRole('PERAWAT', 'BIDAN') && this.auth.user()?.unitId) {
        this.myPatients.set(await this.api.get('/encounters', { active: 'true', unitId: this.auth.user()!.unitId! }));
      }
    } catch (e) {
      this.toasts.error(e);
    }
  }
}
