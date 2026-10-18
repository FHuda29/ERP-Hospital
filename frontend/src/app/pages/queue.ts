import { Component, computed, inject, OnDestroy, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Api, AuthService } from '../core/api';
import { PIPES, Toasts } from '../core/ui';
import { SHARED } from '../shared/components';

@Component({
  selector: 'app-queue',
  imports: [FormsModule, RouterLink, ...SHARED, ...PIPES],
  template: `
    <app-page-header title="Antrean Poli" subtitle="Panggil pasien sesuai urutan; tampilan display dapat dibuka di layar ruang tunggu.">
      <select class="input w-56" [(ngModel)]="unitId" (ngModelChange)="load()">
        @for (u of units(); track u.id) { <option [value]="u.id">{{ u.name }}</option> }
      </select>
      <input class="input w-36" [(ngModel)]="counter" placeholder="Loket/Ruang" />
      <button class="btn btn-primary" (click)="callNext()">📢 Panggil berikutnya</button>
      <button class="btn" (click)="display.set(!display())">{{ display() ? 'Tutup display' : 'Mode display' }}</button>
    </app-page-header>

    @if (display()) {
      <div class="card bg-ink text-white p-8 mb-4 text-center">
        <div class="text-white/60 uppercase tracking-widest text-sm">{{ unitName() }}</div>
        @if (current(); as c) {
          <div class="text-[96px] font-bold leading-none my-4 tabular-nums">{{ c.label }}</div>
          <div class="text-xl">Silakan menuju {{ c.counter ?? 'ruang periksa' }}</div>
        } @else { <div class="text-3xl my-10">Belum ada panggilan</div> }
        <div class="mt-4 text-white/60">Menunggu: {{ waiting().length }}</div>
      </div>
    }

    <div class="grid sm:grid-cols-4 gap-3 mb-4">
      <div class="card card-pad"><div class="muted">Menunggu</div><div class="text-2xl font-semibold">{{ waiting().length }}</div></div>
      <div class="card card-pad"><div class="muted">Dipanggil / dilayani</div><div class="text-2xl font-semibold">{{ active().length }}</div></div>
      <div class="card card-pad"><div class="muted">Selesai</div><div class="text-2xl font-semibold">{{ done().length }}</div></div>
      <div class="card card-pad"><div class="muted">Total hari ini</div><div class="text-2xl font-semibold">{{ rows().length }}</div></div>
    </div>

    <div class="card overflow-x-auto">
      <table class="tbl">
        <thead><tr><th>No.</th><th>Pasien</th><th>Ambil</th><th>Dipanggil</th><th>Status</th><th></th></tr></thead>
        <tbody>
          @for (t of rows(); track t.id) {
            <tr [class.bg-warning-soft]="t.status === 'CALLED'">
              <td class="text-lg font-semibold tabular-nums">{{ t.label }}</td>
              <td>@if (t.patientName) { <b>{{ t.patientName }}</b><div class="muted">RM {{ t.mrn | mrn }}</div> } @else { <span class="muted">Walk-in (belum registrasi)</span> }</td>
              <td>{{ t.createdAt | dt }}</td><td>{{ t.calledAt | dt }}</td>
              <td><app-status [value]="t.status" /></td>
              <td class="whitespace-nowrap">
                @if (t.status === 'WAITING' || t.status === 'SKIPPED') { <button class="btn btn-sm" (click)="setStatus(t, 'CALLED')">Panggil</button> }
                @if (t.status === 'CALLED') { <button class="btn btn-sm" (click)="setStatus(t, 'SKIPPED')">Lewati</button> }
                @if (t.encounterId && auth.can('clinical.read')) { <a class="btn btn-sm btn-primary ml-1" [routerLink]="['/encounters', t.encounterId]">Periksa</a> }
              </td>
            </tr>
          } @empty { <tr><td colspan="6"><app-empty text="Belum ada antrean hari ini" /></td></tr> }
        </tbody>
      </table>
    </div>
  `,
})
export class QueuePage implements OnInit, OnDestroy {
  readonly auth = inject(AuthService);
  private readonly api = inject(Api);
  private readonly toasts = inject(Toasts);
  readonly units = signal<any[]>([]);
  readonly rows = signal<any[]>([]);
  readonly display = signal(false);
  unitId = '';
  counter = 'Ruang 1';
  private timer?: ReturnType<typeof setInterval>;

  readonly waiting = computed(() => this.rows().filter((r) => r.status === 'WAITING'));
  readonly active = computed(() => this.rows().filter((r) => r.status === 'CALLED' || r.status === 'SERVING'));
  readonly done = computed(() => this.rows().filter((r) => r.status === 'DONE'));
  readonly current = computed(() => [...this.rows()].filter((r) => r.calledAt).sort((a, b) => b.calledAt.localeCompare(a.calledAt))[0]);
  readonly unitName = computed(() => this.units().find((u) => u.id === this.unitSig())?.name ?? '');
  private readonly unitSig = signal('');

  async ngOnInit() {
    const units = (await this.api.get<any[]>('/master/units')).filter((u) => u.type === 'POLI' || u.type === 'IGD');
    this.units.set(units);
    const mine = units.find((u) => u.id === this.auth.user()?.unitId);
    this.unitId = mine?.id ?? units[0]?.id ?? '';
    await this.load();
    this.timer = setInterval(() => void this.load(), 15_000);
  }

  ngOnDestroy() {
    clearInterval(this.timer);
  }

  async load() {
    this.unitSig.set(this.unitId);
    if (this.unitId) this.rows.set(await this.api.get('/queue', { unitId: this.unitId }));
  }

  async callNext() {
    try {
      const t = await this.api.post('/queue/call-next', { unitId: this.unitId, counter: this.counter });
      this.toasts.success(`Memanggil ${t.label} ke ${t.counter}`);
      this.announce(t.label, t.counter);
      await this.load();
    } catch (e) {
      this.toasts.error(e);
    }
  }

  async setStatus(t: any, status: string) {
    try {
      await this.api.post(`/queue/${t.id}/status`, { status });
      if (status === 'CALLED') this.announce(t.label, this.counter);
      await this.load();
    } catch (e) {
      this.toasts.error(e);
    }
  }

  /** Pengumuman suara (Web Speech API) bila tersedia. */
  private announce(label: string, counter: string) {
    try {
      const u = new SpeechSynthesisUtterance(`Nomor antrean ${label.replace('-', ' ')}, silakan menuju ${counter}`);
      u.lang = 'id-ID';
      speechSynthesis.speak(u);
    } catch {
      /* perangkat tanpa TTS */
    }
  }
}
