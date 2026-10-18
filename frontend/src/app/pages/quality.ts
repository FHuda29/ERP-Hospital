import { Component, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Api, AuthService } from '../core/api';
import { PIPES, Toasts } from '../core/ui';
import { SHARED } from '../shared/components';

const TYPES: Record<string, string> = {
  KTD: 'Kejadian Tidak Diharapkan',
  KNC: 'Kejadian Nyaris Cedera',
  KTC: 'Kejadian Tidak Cedera',
  KPC: 'Kondisi Potensial Cedera',
  SENTINEL: 'Kejadian Sentinel',
};

@Component({
  selector: 'app-quality',
  imports: [FormsModule, ...SHARED, ...PIPES],
  template: `
    <app-page-header title="Mutu & Keselamatan Pasien" subtitle="Pelaporan insiden (KTD/KNC/KTC/KPC/Sentinel) dan grading risiko — budaya pelaporan tanpa menyalahkan.">
      @if (auth.can('incident.write')) { <button class="btn btn-primary" (click)="open.set(true)">+ Laporkan insiden</button> }
    </app-page-header>
    @if (auth.can('incident.read')) {
      <div class="card overflow-x-auto">
        <table class="tbl">
          <thead><tr><th>No.</th><th>Jenis</th><th>Waktu kejadian</th><th>Unit</th><th>Uraian</th><th>Grading</th><th>Status</th><th></th></tr></thead>
          <tbody>
            @for (r of rows(); track r.incident.id) {
              <tr>
                <td>{{ r.incident.incidentNo }}</td>
                <td><span class="badge" [class]="r.incident.type === 'SENTINEL' || r.incident.type === 'KTD' ? 'badge-critical' : 'badge-warning'">{{ r.incident.type }}</span><div class="muted">{{ types[r.incident.type] }}</div></td>
                <td>{{ r.incident.occurredAt | dt }}</td><td>{{ r.unitName ?? '—' }}</td>
                <td class="max-w-md">{{ r.incident.description }}@if (r.incident.immediateAction) { <div class="muted">Tindakan: {{ r.incident.immediateAction }}</div> }</td>
                <td>{{ r.incident.riskGrade ?? '—' }}</td>
                <td><app-status [value]="r.incident.status" /></td>
                <td class="whitespace-nowrap">
                  @if (r.incident.status === 'REPORTED') { <button class="btn btn-sm" (click)="setStatus(r, 'INVESTIGATING')">Investigasi</button> }
                  @if (r.incident.status !== 'CLOSED') { <button class="btn btn-sm ml-1" (click)="setStatus(r, 'CLOSED')">Tutup</button> }
                </td>
              </tr>
            } @empty { <tr><td colspan="8"><app-empty text="Belum ada laporan insiden" /></td></tr> }
          </tbody>
        </table>
      </div>
    } @else {
      <div class="card card-pad text-sm">Laporan Anda dikirim langsung ke Komite Mutu & Keselamatan Pasien. Identitas pelapor dijaga.</div>
    }

    @if (open()) {
      <app-modal title="Laporan insiden keselamatan pasien" [width]="620" (closed)="open.set(false)">
        <div class="grid sm:grid-cols-2 gap-3">
          <div class="field"><label class="label">Jenis insiden</label><select class="input" [(ngModel)]="f.type">@for (t of typeKeys; track t) {<option [value]="t">{{ t }} — {{ types[t] }}</option>}</select></div>
          <div class="field"><label class="label">Waktu kejadian</label><input class="input" type="datetime-local" [(ngModel)]="f.occurredAt" /></div>
          <div class="field"><label class="label">Unit</label><select class="input" [(ngModel)]="f.unitId"><option value="">—</option>@for (u of units(); track u.id) {<option [value]="u.id">{{ u.name }}</option>}</select></div>
          <div class="field"><label class="label">Grading risiko</label><select class="input" [(ngModel)]="f.riskGrade"><option value="">Belum dinilai</option><option>BIRU</option><option>HIJAU</option><option>KUNING</option><option>MERAH</option></select></div>
          <div class="field sm:col-span-2"><label class="label">Kronologi</label><textarea class="input" rows="4" [(ngModel)]="f.description"></textarea></div>
          <div class="field sm:col-span-2"><label class="label">Tindakan segera</label><textarea class="input" [(ngModel)]="f.immediateAction"></textarea></div>
        </div>
        <div class="flex justify-end mt-3"><button class="btn btn-primary" [disabled]="f.description.length < 10 || !f.occurredAt" (click)="submit()">Kirim laporan</button></div>
      </app-modal>
    }
  `,
})
export class QualityPage implements OnInit {
  readonly auth = inject(AuthService);
  private readonly api = inject(Api);
  private readonly toasts = inject(Toasts);
  readonly types = TYPES;
  readonly typeKeys = Object.keys(TYPES);
  readonly rows = signal<any[]>([]);
  readonly units = signal<any[]>([]);
  readonly open = signal(false);
  f: any = { type: 'KNC', occurredAt: '', unitId: '', riskGrade: '', description: '', immediateAction: '' };

  async ngOnInit() {
    this.units.set(await this.api.get('/master/units'));
    await this.load();
  }

  async load() {
    if (this.auth.can('incident.read')) this.rows.set(await this.api.get('/quality/incidents'));
  }

  async submit() {
    try {
      const body = Object.fromEntries(Object.entries(this.f).filter(([, v]) => v !== ''));
      body['occurredAt'] = new Date(this.f.occurredAt).toISOString();
      const r = await this.api.post('/quality/incidents', body);
      this.toasts.success(`Laporan ${r.incidentNo} terkirim`);
      this.open.set(false);
      this.f = { type: 'KNC', occurredAt: '', unitId: '', riskGrade: '', description: '', immediateAction: '' };
      await this.load();
    } catch (e) {
      this.toasts.error(e);
    }
  }

  async setStatus(r: any, status: string) {
    try {
      await this.api.post(`/quality/incidents/${r.incident.id}/status`, { status });
      await this.load();
    } catch (e) {
      this.toasts.error(e);
    }
  }
}
