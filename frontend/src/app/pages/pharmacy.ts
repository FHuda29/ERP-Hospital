import { Component, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Api, AuthService } from '../core/api';
import { ENCOUNTER_TYPE, PIPES, Toasts } from '../core/ui';
import { SHARED } from '../shared/components';

@Component({
  selector: 'app-pharmacy',
  imports: [FormsModule, ...SHARED, ...PIPES],
  template: `
    <app-page-header title="Instalasi Farmasi" subtitle="Telaah resep (administratif, farmasetik, klinis) → penyerahan FEFO dari depo farmasi.">
      <select class="input w-48" [(ngModel)]="status" (ngModelChange)="load()">
        <option value="">Perlu diproses</option><option value="DISPENSED">Sudah diserahkan</option><option value="REJECTED">Ditolak</option>
      </select>
    </app-page-header>

    @for (r of rows(); track r.rx.id) {
      <div class="card card-pad mb-3" [class.border-l-4]="r.rx.alerts.length" [class.border-l-warning]="r.rx.alerts.length">
        <div class="flex flex-wrap justify-between gap-2 mb-2">
          <div>
            <b>{{ r.rx.rxNo }}</b> · {{ r.patientName }} <span class="muted">RM {{ r.mrn | mrn }} · {{ r.birthDate | age }} · {{ types[r.encounterType] }} {{ r.unitName }}</span>
            <div class="muted">{{ r.rx.prescriberName }} · {{ r.rx.createdAt | dt }} · Penjamin {{ r.payerName }}</div>
          </div>
          <app-status [value]="r.rx.status" />
        </div>
        <table class="tbl">
          <thead><tr><th>Obat</th><th class="num">Jumlah</th><th>Aturan</th><th>Rute</th></tr></thead>
          <tbody>
            @for (i of r.items; track i.id) {
              <tr><td>{{ i.itemName }}</td><td class="num">{{ i.quantity | num }}</td><td>{{ i.dose }} · {{ i.frequency }} @if (i.durationDays) { · {{ i.durationDays }} hari } @if (i.instructions) { — {{ i.instructions }} }</td><td>{{ i.route }}</td></tr>
            }
          </tbody>
        </table>
        @for (a of r.rx.alerts; track a.message) {
          <div class="alert mt-2 text-xs" [class.alert-critical]="a.severity === 'BLOCK'" [class.alert-warning]="a.severity === 'WARNING'" [class.alert-info]="a.severity === 'INFO'"><b>{{ a.type }}</b> {{ a.message }}</div>
        }
        @if (r.rx.overrideReason) { <div class="text-xs mt-1"><b>Alasan override dokter:</b> {{ r.rx.overrideReason }}</div> }
        @if (r.rx.reviewNotes) { <div class="text-xs mt-1 muted">Telaah: {{ r.rx.reviewNotes }}</div> }
        <div class="flex flex-wrap gap-2 mt-3 items-center">
          @if (r.rx.status === 'SUBMITTED' && auth.can('rx.verify')) {
            <input class="input max-w-md" [(ngModel)]="notes[r.rx.id]" placeholder="Catatan telaah (opsional)" />
            <button class="btn btn-primary" (click)="verify(r)">Telaah OK</button>
            <button class="btn btn-danger" (click)="reject(r)">Tolak</button>
          }
          @if (r.rx.status === 'VERIFIED' && auth.can('rx.dispense')) {
            <button class="btn btn-success" (click)="dispense(r)">Serahkan obat (FEFO)</button>
          }
        </div>
      </div>
    } @empty { <div class="card"><app-empty text="Tidak ada resep" /></div> }
  `,
})
export class PharmacyPage implements OnInit {
  readonly auth = inject(AuthService);
  private readonly api = inject(Api);
  private readonly toasts = inject(Toasts);
  readonly types = ENCOUNTER_TYPE;
  readonly rows = signal<any[]>([]);
  status = '';
  notes: Record<string, string> = {};

  async ngOnInit() {
    await this.load();
  }

  async load() {
    this.rows.set(await this.api.get('/pharmacy/prescriptions', { status: this.status }));
  }

  private async run(fn: () => Promise<any>, ok: string) {
    try {
      const r = await fn();
      this.toasts.success(ok);
      await this.load();
      return r;
    } catch (e) {
      this.toasts.error(e);
    }
  }

  verify(r: any) {
    return this.run(() => this.api.post(`/pharmacy/prescriptions/${r.rx.id}/verify`, { reviewNotes: this.notes[r.rx.id] || undefined }), 'Resep ditelaah');
  }

  reject(r: any) {
    const reason = this.notes[r.rx.id];
    if (!reason || reason.length < 5) return this.toasts.show('warning', 'Isi alasan penolakan di kolom catatan telaah');
    return this.run(() => this.api.post(`/pharmacy/prescriptions/${r.rx.id}/reject`, { reason }), 'Resep ditolak — dokter perlu menulis ulang');
  }

  async dispense(r: any) {
    const res = await this.run(() => this.api.post(`/pharmacy/prescriptions/${r.rx.id}/dispense`, {}), 'Obat diserahkan');
    if (res) {
      const batches = res.dispensed.flatMap((d: any) => d.batches.map((b: any) => `${d.itemName}: ${b.batchNo} (ED ${b.expiryDate}) × ${b.quantity}`));
      this.toasts.show('info', 'Batch: ' + batches.join('; '), 9000);
    }
  }
}
