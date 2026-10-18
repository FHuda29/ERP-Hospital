import { Component, inject, input, OnInit, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { Api, AuthService } from '../core/api';
import { PIPES, Toasts, todayIso } from '../core/ui';
import { SHARED } from '../shared/components';
import { PatientPicker } from './registration';

@Component({
  selector: 'app-appointments',
  imports: [FormsModule, PatientPicker, ...SHARED, ...PIPES],
  template: `
    <app-page-header title="Janji Temu" subtitle="Booking berbasis jadwal & kuota dokter. Check-in membuat kunjungan rawat jalan + nomor antrean.">
      <input class="input w-44" type="date" [(ngModel)]="date" (ngModelChange)="load()" />
      <button class="btn btn-primary" (click)="open.set(true)">+ Buat janji temu</button>
    </app-page-header>

    <div class="card overflow-x-auto">
      <table class="tbl">
        <thead><tr><th>Kode booking</th><th>Jam</th><th>Pasien</th><th>Poli</th><th>Dokter</th><th>Sumber</th><th>Status</th><th></th></tr></thead>
        <tbody>
          @for (a of rows(); track a.id) {
            <tr>
              <td class="tabular-nums">{{ a.bookingCode }}</td><td>{{ a.slotTime }}</td>
              <td><b>{{ a.patientName }}</b><div class="muted">RM {{ a.mrn | mrn }}</div></td>
              <td>{{ a.unitName }}</td><td>{{ a.practitionerName }}</td><td>{{ a.source }}</td>
              <td><app-status [value]="a.status === 'BOOKED' ? 'WAITING' : a.status === 'CHECKED_IN' ? 'DONE' : a.status" /></td>
              <td class="whitespace-nowrap">
                @if (a.status === 'BOOKED') {
                  <button class="btn btn-sm btn-primary" (click)="checkIn(a)">Check-in</button>
                  <button class="btn btn-sm ml-1" (click)="cancel(a)">Batal</button>
                } @else if (a.encounterId) {
                  <button class="btn btn-sm" (click)="router.navigate(['/encounters', a.encounterId])">Kunjungan</button>
                }
              </td>
            </tr>
          } @empty { <tr><td colspan="8"><app-empty text="Tidak ada janji temu pada tanggal ini" /></td></tr> }
        </tbody>
      </table>
    </div>

    @if (open()) {
      <app-modal title="Janji temu baru" (closed)="open.set(false)">
        <div class="space-y-3">
          <div><div class="label">Pasien</div><app-patient-picker /></div>
          <div class="grid sm:grid-cols-2 gap-3">
            <div class="field"><label class="label">Poli</label><select class="input" [(ngModel)]="form.unitId">@for (u of polis(); track u.id) {<option [value]="u.id">{{ u.name }}</option>}</select></div>
            <div class="field"><label class="label">Dokter</label><select class="input" [(ngModel)]="form.practitionerId">@for (d of doctors(); track d.id) {<option [value]="d.id">{{ d.name }}</option>}</select></div>
            <div class="field"><label class="label">Tanggal</label><input class="input" type="date" [(ngModel)]="form.date" /></div>
            <div class="field"><label class="label">Penjamin</label><select class="input" [(ngModel)]="form.payerId">@for (p of payers(); track p.id) {<option [value]="p.id">{{ p.name }}</option>}</select></div>
            <div class="field"><label class="label">Sumber</label><select class="input" [(ngModel)]="form.source"><option>ONSITE</option><option>ONLINE</option><option>MOBILE_JKN</option><option>TELEPON</option></select></div>
          </div>
          <div class="flex justify-end"><button class="btn btn-primary" (click)="create()">Simpan</button></div>
        </div>
      </app-modal>
    }
  `,
})
export class AppointmentsPage implements OnInit {
  private readonly api = inject(Api);
  private readonly toasts = inject(Toasts);
  readonly router = inject(Router);
  readonly auth = inject(AuthService);
  readonly patientId = input<string>();
  readonly picker = viewChild(PatientPicker);
  readonly rows = signal<any[]>([]);
  readonly polis = signal<any[]>([]);
  readonly doctors = signal<any[]>([]);
  readonly payers = signal<any[]>([]);
  readonly open = signal(false);
  date = todayIso();
  form: any = { unitId: '', practitionerId: '', date: todayIso(), payerId: '', source: 'ONSITE' };

  async ngOnInit() {
    const [u, p, py] = await Promise.all([this.api.get('/master/units'), this.api.get('/master/practitioners'), this.api.get('/master/payers')]);
    this.polis.set(u.filter((x: any) => x.type === 'POLI'));
    this.doctors.set(p.filter((x: any) => x.profession.startsWith('DOKTER')));
    this.payers.set(py);
    this.form.unitId = this.polis()[0]?.id;
    this.form.practitionerId = this.doctors()[0]?.id;
    this.form.payerId = py.find((x: any) => x.type === 'UMUM')?.id;
    if (this.patientId()) {
      this.open.set(true);
      setTimeout(() => this.picker()?.preload(this.patientId()!));
    }
    await this.load();
  }

  async load() {
    this.rows.set(await this.api.get('/appointments', { date: this.date }));
  }

  async create() {
    const p = this.picker()?.selected();
    if (!p) return this.toasts.show('warning', 'Pilih pasien terlebih dahulu');
    try {
      const a = await this.api.post('/appointments', { ...this.form, patientId: p.id });
      this.toasts.success(`Janji temu ${a.bookingCode} — perkiraan nomor ${a.estimatedNumber}`);
      this.open.set(false);
      this.date = this.form.date;
      await this.load();
    } catch (e) {
      this.toasts.error(e);
    }
  }

  async checkIn(a: any) {
    try {
      const e = await this.api.post(`/appointments/${a.id}/check-in`);
      this.toasts.success(`Check-in ${e.encounterNo}, antrean ${e.queue?.label ?? ''}`);
      await this.load();
    } catch (e) {
      this.toasts.error(e);
    }
  }

  async cancel(a: any) {
    try {
      await this.api.post(`/appointments/${a.id}/cancel`);
      await this.load();
    } catch (e) {
      this.toasts.error(e);
    }
  }
}
