import { Component, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Api, AuthService } from '../core/api';
import { ENCOUNTER_TYPE, PIPES, Toasts } from '../core/ui';
import { SHARED } from '../shared/components';

@Component({
  selector: 'app-encounters',
  imports: [FormsModule, RouterLink, ...SHARED, ...PIPES],
  template: `
    <app-page-header title="Daftar Kunjungan" subtitle="Worklist pasien — IGD diurutkan berdasarkan prioritas triase." />
    <form class="card card-pad mb-4 grid sm:grid-cols-6 gap-2 items-end" (ngSubmit)="load()">
      <div class="field sm:col-span-2"><label class="label">Cari</label><input class="input" name="q" [(ngModel)]="f.q" placeholder="Nama / No. RM / No. kunjungan" /></div>
      <div class="field"><label class="label">Jenis</label><select class="input" name="t" [(ngModel)]="f.type"><option value="">Semua</option>@for (t of typeKeys; track t) {<option [value]="t">{{ types[t] }}</option>}</select></div>
      <div class="field"><label class="label">Unit</label><select class="input" name="u" [(ngModel)]="f.unitId"><option value="">Semua</option>@for (u of units(); track u.id) {<option [value]="u.id">{{ u.name }}</option>}</select></div>
      <div class="field"><label class="label">Status</label><select class="input" name="s" [(ngModel)]="f.active"><option value="true">Aktif</option><option value="">Semua</option></select></div>
      <div class="flex gap-2">
        @if (auth.hasRole('DOKTER')) { <label class="text-sm flex items-center gap-1"><input type="checkbox" name="m" [(ngModel)]="f.mine" /> Pasien saya</label> }
        <button class="btn btn-primary">Tampilkan</button>
      </div>
    </form>
    <div class="card overflow-x-auto">
      <table class="tbl">
        <thead><tr><th>Triase</th><th>Pasien</th><th>Kunjungan</th><th>Unit / DPJP</th><th>Penjamin</th><th>Mulai</th><th>Status</th><th></th></tr></thead>
        <tbody>
          @for (e of rows(); track e.id) {
            <tr>
              <td>@if (e.triageLevel) { <app-triage [level]="e.triageLevel" /> } @else if (e.queueLabel) { <span class="badge badge-neutral">{{ e.queueLabel }}</span> }</td>
              <td><b>{{ e.patientName }}</b><div class="muted">RM {{ e.mrn | mrn }} · {{ e.gender }} · {{ e.birthDate | age }}</div></td>
              <td>{{ e.encounterNo }}<div class="muted">{{ types[e.type] }}</div></td>
              <td>{{ e.unitName }}<div class="muted">{{ e.practitionerName ?? '—' }}</div></td>
              <td>{{ e.payerName }} @if (e.sepNumber) { <div class="muted">SEP {{ e.sepNumber }}</div> }</td>
              <td>{{ e.startAt | dt }}</td>
              <td><app-status [value]="e.status" /></td>
              <td><a class="btn btn-sm btn-primary" [routerLink]="['/encounters', e.id]">Buka</a></td>
            </tr>
          } @empty { <tr><td colspan="8"><app-empty /></td></tr> }
        </tbody>
      </table>
    </div>
  `,
})
export class EncountersPage implements OnInit {
  readonly auth = inject(AuthService);
  private readonly api = inject(Api);
  private readonly toasts = inject(Toasts);
  readonly types = ENCOUNTER_TYPE;
  readonly typeKeys = Object.keys(ENCOUNTER_TYPE);
  readonly rows = signal<any[]>([]);
  readonly units = signal<any[]>([]);
  f: any = { q: '', type: '', unitId: '', active: 'true', mine: false };

  async ngOnInit() {
    this.units.set((await this.api.get<any[]>('/master/units')).filter((u) => ['POLI', 'IGD', 'RAWAT_INAP', 'ICU'].includes(u.type)));
    if (this.auth.hasRole('DOKTER')) this.f.mine = true;
    else if (this.auth.hasRole('PERAWAT', 'BIDAN') && this.auth.user()?.unitId) this.f.unitId = this.auth.user()!.unitId;
    await this.load();
  }

  async load() {
    try {
      this.rows.set(await this.api.get('/encounters', { ...this.f, mine: this.f.mine ? 'true' : '' }));
    } catch (e) {
      this.toasts.error(e);
    }
  }
}
