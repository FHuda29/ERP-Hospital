import { Component, effect, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Api, AuthService } from '../core/api';
import { PIPES, Toasts } from '../core/ui';
import { SHARED } from '../shared/components';

/** Template parameter hasil lab yang umum — mempercepat input. */
const LAB_TEMPLATES: Record<string, { name: string; unit: string; referenceRange: string }[]> = {
  'Darah Lengkap': [
    { name: 'Hemoglobin', unit: 'g/dL', referenceRange: '12-16' },
    { name: 'Leukosit', unit: '10³/µL', referenceRange: '4-10' },
    { name: 'Trombosit', unit: '10³/µL', referenceRange: '150-400' },
    { name: 'Hematokrit', unit: '%', referenceRange: '37-48' },
  ],
  'Gula Darah Sewaktu': [{ name: 'Glukosa sewaktu', unit: 'mg/dL', referenceRange: '<200' }],
  'Elektrolit (Na, K, Cl)': [
    { name: 'Natrium', unit: 'mmol/L', referenceRange: '135-145' },
    { name: 'Kalium', unit: 'mmol/L', referenceRange: '3.5-5.1' },
    { name: 'Klorida', unit: 'mmol/L', referenceRange: '98-107' },
  ],
  'Ureum & Kreatinin': [
    { name: 'Ureum', unit: 'mg/dL', referenceRange: '10-50' },
    { name: 'Kreatinin', unit: 'mg/dL', referenceRange: '0.6-1.2' },
  ],
  'SGOT & SGPT': [
    { name: 'SGOT', unit: 'U/L', referenceRange: '<35' },
    { name: 'SGPT', unit: 'U/L', referenceRange: '<35' },
  ],
};

@Component({
  selector: 'app-ancillary',
  imports: [FormsModule, ...SHARED, ...PIPES],
  template: `
    <app-page-header [title]="category() === 'LAB' ? 'Laboratorium' : 'Radiologi'" subtitle="Worklist order — CITO di atas. Hasil divalidasi petugas kedua; nilai kritis (HH/LL) wajib dilaporkan ke dokter.">
      <select class="input w-48" [(ngModel)]="status" (ngModelChange)="load()">
        <option value="">Aktif</option><option value="VERIFIED">Tervalidasi</option><option value="CANCELLED">Dibatalkan</option>
      </select>
    </app-page-header>
    <div class="card overflow-x-auto">
      <table class="tbl">
        <thead><tr><th>Order</th><th>Pasien</th><th>Pemeriksaan</th><th>Asal</th><th>Status</th><th>Hasil</th><th></th></tr></thead>
        <tbody>
          @for (w of rows(); track w.order.id) {
            <tr [class.bg-critical-soft]="w.order.priority === 'CITO' && w.order.status === 'ORDERED'">
              <td>{{ w.order.orderNo }} @if (w.order.priority === 'CITO') { <span class="badge badge-critical">CITO</span> }<div class="muted">{{ w.order.createdAt | dt }}</div></td>
              <td><b>{{ w.patientName }}</b><div class="muted">RM {{ w.mrn | mrn }} · {{ w.gender }} · {{ w.birthDate | age }}</div></td>
              <td>{{ w.order.serviceName }}@if (w.order.clinicalInfo) { <div class="muted">{{ w.order.clinicalInfo }}</div> }</td>
              <td>{{ w.unitName }}<div class="muted">{{ w.order.orderedByName }}</div></td>
              <td><app-status [value]="w.order.status" /></td>
              <td class="text-xs">
                @if (w.result; as r) {
                  @for (o of r.observations; track o.name) { <div [class.text-critical]="o.flag === 'HH' || o.flag === 'LL'">{{ o.name }} {{ o.value }} {{ o.unit }} @if (o.flag && o.flag !== 'N') { [{{ o.flag }}] }</div> }
                  @if (r.conclusion) { <div class="line-clamp-2">{{ r.conclusion }}</div> }
                }
              </td>
              <td class="whitespace-nowrap">
                @if (w.order.status === 'ORDERED') { <button class="btn btn-sm" (click)="start(w)">{{ category() === 'LAB' ? 'Ambil sampel' : 'Mulai' }}</button> }
                @if (w.order.status === 'ORDERED' || w.order.status === 'IN_PROGRESS') { <button class="btn btn-sm btn-primary ml-1" (click)="openResult(w)">Input hasil</button> }
                @if (w.order.status === 'RESULTED' && auth.can('result.verify')) { <button class="btn btn-sm btn-success" (click)="verify(w)">Validasi</button> }
              </td>
            </tr>
          } @empty { <tr><td colspan="7"><app-empty text="Tidak ada order" /></td></tr> }
        </tbody>
      </table>
    </div>

    @if (target(); as t) {
      <app-modal [title]="'Hasil — ' + t.order.serviceName" [width]="760" (closed)="target.set(null)">
        <div class="muted mb-3">{{ t.patientName }} · RM {{ t.mrn | mrn }} · {{ t.order.orderNo }}</div>
        @if (category() === 'LAB') {
          <table class="tbl mb-2">
            <thead><tr><th>Parameter</th><th>Nilai</th><th>Satuan</th><th>Rujukan</th><th>Flag</th><th></th></tr></thead>
            <tbody>
              @for (o of obs; track $index; let i = $index) {
                <tr>
                  <td><input class="input" [(ngModel)]="o.name" /></td><td><input class="input w-24" [(ngModel)]="o.value" /></td>
                  <td><input class="input w-24" [(ngModel)]="o.unit" /></td><td><input class="input w-28" [(ngModel)]="o.referenceRange" /></td>
                  <td><select class="input w-24" [(ngModel)]="o.flag"><option value="N">N</option><option value="H">H</option><option value="L">L</option><option value="HH">HH (kritis)</option><option value="LL">LL (kritis)</option></select></td>
                  <td><button class="btn btn-sm btn-ghost" (click)="obs.splice(i, 1)">✕</button></td>
                </tr>
              }
            </tbody>
          </table>
          <button class="btn btn-sm mb-3" (click)="obs.push({ name: '', value: '', unit: '', referenceRange: '', flag: 'N' })">+ Parameter</button>
        }
        <div class="field"><label class="label">{{ category() === 'LAB' ? 'Catatan / kesimpulan' : 'Ekspertise / kesan' }}</label><textarea class="input" rows="5" [(ngModel)]="conclusion"></textarea></div>
        @if (hasCritical()) { <div class="alert alert-critical mt-2">Terdapat nilai kritis — segera laporkan ke DPJP (lapor & catat waktu).</div> }
        <div class="flex justify-end mt-3"><button class="btn btn-primary" (click)="saveResult()">Simpan hasil</button></div>
      </app-modal>
    }
  `,
})
export class AncillaryPage {
  readonly auth = inject(AuthService);
  private readonly api = inject(Api);
  private readonly toasts = inject(Toasts);
  readonly category = input.required<string>();
  readonly rows = signal<any[]>([]);
  readonly target = signal<any>(null);
  status = '';
  obs: any[] = [];
  conclusion = '';

  constructor() {
    effect(() => {
      this.category();
      void this.load();
    });
  }

  hasCritical() {
    return this.obs.some((o) => o.flag === 'HH' || o.flag === 'LL');
  }

  async load() {
    try {
      this.rows.set(await this.api.get('/orders/worklist', { category: this.category(), status: this.status }));
    } catch (e) {
      this.toasts.error(e);
    }
  }

  async start(w: any) {
    try {
      await this.api.post(`/orders/${w.order.id}/start`);
      await this.load();
    } catch (e) {
      this.toasts.error(e);
    }
  }

  openResult(w: any) {
    this.obs = (LAB_TEMPLATES[w.order.serviceName] ?? [{ name: w.order.serviceName, unit: '', referenceRange: '' }]).map((t) => ({ ...t, value: '', flag: 'N' }));
    if (this.category() !== 'LAB') this.obs = [];
    this.conclusion = '';
    this.target.set(w);
  }

  async saveResult() {
    try {
      const observations = this.obs.filter((o) => o.name && o.value);
      const r = await this.api.post(`/orders/${this.target().order.id}/result`, { observations, conclusion: this.conclusion || undefined });
      this.toasts.show(r.isCritical ? 'warning' : 'success', r.isCritical ? 'Hasil kritis tersimpan — DPJP mendapat notifikasi' : 'Hasil tersimpan, menunggu validasi');
      this.target.set(null);
      await this.load();
    } catch (e) {
      this.toasts.error(e);
    }
  }

  async verify(w: any) {
    try {
      await this.api.post(`/orders/${w.order.id}/verify`);
      this.toasts.success('Hasil tervalidasi');
      await this.load();
    } catch (e) {
      this.toasts.error(e);
    }
  }
}
