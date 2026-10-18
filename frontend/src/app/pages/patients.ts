import { Component, effect, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { Api, ApiError, AuthService } from '../core/api';
import { PIPES, Toasts } from '../core/ui';
import { SHARED } from '../shared/components';

export const emptyPatient = () => ({
  nik: '',
  name: '',
  birthDate: '',
  birthPlace: '',
  gender: 'L',
  bloodType: '',
  motherName: '',
  phone: '',
  address: '',
  city: '',
  province: '',
  religion: '',
  maritalStatus: '',
  occupation: '',
  bpjsNumber: '',
  emergencyContactName: '',
  emergencyContactPhone: '',
});

/** Formulir pasien bersama (registrasi baru & edit). Kirim hanya field terisi. */
@Component({
  selector: 'app-patient-form',
  imports: [FormsModule],
  template: `
    <div class="grid sm:grid-cols-2 gap-3">
      <div class="field sm:col-span-2"><label class="label">Nama lengkap (sesuai KTP) *</label><input class="input uppercase" [(ngModel)]="model().name" name="name" required /></div>
      <div class="field"><label class="label">NIK (16 digit)</label><input class="input" [(ngModel)]="model().nik" name="nik" inputmode="numeric" maxlength="16" placeholder="Kosongkan bila belum punya (bayi/WNA)" /></div>
      <div class="field"><label class="label">No. kartu JKN (13 digit)</label><input class="input" [(ngModel)]="model().bpjsNumber" name="bpjs" inputmode="numeric" maxlength="13" /></div>
      <div class="field"><label class="label">Tanggal lahir *</label><input class="input" type="date" [(ngModel)]="model().birthDate" name="bd" required /></div>
      <div class="field"><label class="label">Tempat lahir</label><input class="input" [(ngModel)]="model().birthPlace" name="bp" /></div>
      <div class="field"><label class="label">Jenis kelamin *</label>
        <select class="input" [(ngModel)]="model().gender" name="g"><option value="L">Laki-laki</option><option value="P">Perempuan</option></select></div>
      <div class="field"><label class="label">Golongan darah</label>
        <select class="input" [(ngModel)]="model().bloodType" name="bt"><option value="">—</option>@for (b of ['A','B','AB','O','A+','A-','B+','B-','AB+','AB-','O+','O-']; track b) {<option>{{ b }}</option>}</select></div>
      <div class="field"><label class="label">Nama ibu kandung</label><input class="input" [(ngModel)]="model().motherName" name="mn" /></div>
      <div class="field"><label class="label">No. HP</label><input class="input" [(ngModel)]="model().phone" name="ph" /></div>
      <div class="field sm:col-span-2"><label class="label">Alamat</label><input class="input" [(ngModel)]="model().address" name="ad" /></div>
      <div class="field"><label class="label">Kota/Kabupaten</label><input class="input" [(ngModel)]="model().city" name="ct" /></div>
      <div class="field"><label class="label">Provinsi</label><input class="input" [(ngModel)]="model().province" name="pv" /></div>
      <div class="field"><label class="label">Agama</label><input class="input" [(ngModel)]="model().religion" name="rl" /></div>
      <div class="field"><label class="label">Status perkawinan</label>
        <select class="input" [(ngModel)]="model().maritalStatus" name="ms"><option value="">—</option><option value="BELUM_KAWIN">Belum kawin</option><option value="KAWIN">Kawin</option><option value="CERAI_HIDUP">Cerai hidup</option><option value="CERAI_MATI">Cerai mati</option></select></div>
      <div class="field"><label class="label">Pekerjaan</label><input class="input" [(ngModel)]="model().occupation" name="oc" /></div>
      <div class="field"><label class="label">Kontak darurat</label><input class="input" [(ngModel)]="model().emergencyContactName" name="ecn" placeholder="Nama" /></div>
      <div class="field"><label class="label">HP kontak darurat</label><input class="input" [(ngModel)]="model().emergencyContactPhone" name="ecp" /></div>
    </div>
  `,
})
export class PatientForm {
  readonly model = input.required<ReturnType<typeof emptyPatient>>();
}

export function cleanPayload<T extends Record<string, any>>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== '' && v !== null && v !== undefined)) as Partial<T>;
}

@Component({
  selector: 'app-patients',
  imports: [FormsModule, RouterLink, PatientForm, ...SHARED, ...PIPES],
  template: `
    <app-page-header title="Master Pasien (MPI)" subtitle="Satu identitas pasien per institusi — cari sebelum mendaftarkan untuk mencegah rekam medis ganda.">
      @if (auth.can('patient.write')) { <button class="btn btn-primary" (click)="openNew()">+ Pasien baru</button> }
    </app-page-header>

    <form class="card card-pad mb-4 flex gap-2" (ngSubmit)="search()">
      <input class="input" name="q" [(ngModel)]="term" placeholder="Nama / No. RM / NIK 16 digit / No. JKN 13 digit / No. HP" autofocus />
      <button class="btn btn-primary">Cari</button>
    </form>

    <div class="card overflow-x-auto">
      <table class="tbl">
        <thead><tr><th>No. RM</th><th>Nama</th><th>Tgl lahir</th><th>NIK</th><th>No. JKN</th><th>Alamat</th><th></th></tr></thead>
        <tbody>
          @for (p of rows(); track p.id) {
            <tr>
              <td class="tabular-nums font-medium">{{ p.mrn | mrn }}</td>
              <td><a class="text-primary font-medium hover:underline" [routerLink]="['/patients', p.id]">{{ p.name }}</a> <span class="muted">{{ p.gender }}</span></td>
              <td>{{ p.birthDate | d }} <span class="muted">({{ p.birthDate | age }})</span></td>
              <td class="tabular-nums">{{ p.nikMasked ?? '—' }}</td>
              <td class="tabular-nums">{{ p.bpjsNumber ?? '—' }}</td>
              <td class="max-w-60 truncate">{{ p.address }}</td>
              <td class="whitespace-nowrap">
                @if (auth.can('encounter.write')) { <a class="btn btn-sm" [routerLink]="['/registration']" [queryParams]="{ patientId: p.id }">Daftarkan</a> }
              </td>
            </tr>
          } @empty {
            <tr><td colspan="7"><app-empty [text]="searched() ? 'Pasien tidak ditemukan — daftarkan sebagai pasien baru' : 'Masukkan kata kunci pencarian'" /></td></tr>
          }
        </tbody>
      </table>
    </div>

    @if (creating()) {
      <app-modal title="Registrasi pasien baru" [width]="760" (closed)="creating.set(false)">
        @if (candidates().length) {
          <div class="alert alert-warning mb-3">
            <div class="font-medium mb-1">{{ dupMessage() }}</div>
            @for (c of candidates(); track c.id) {
              <div class="flex items-center justify-between gap-2 py-1 border-t border-warning/20">
                <span>RM {{ c.mrn | mrn }} — <b>{{ c.name }}</b>, {{ c.birthDate | d }}, NIK {{ c.nikMasked ?? '—' }} <span class="badge badge-warning">{{ c.matchType }}</span></span>
                <a class="btn btn-sm" [routerLink]="['/patients', c.id]" (click)="creating.set(false)">Gunakan pasien ini</a>
              </div>
            }
          </div>
        }
        <app-patient-form [model]="form" />
        <div class="flex justify-end gap-2 mt-4">
          <button class="btn" (click)="creating.set(false)">Batal</button>
          @if (candidates().length && !nikDuplicate()) {
            <button class="btn btn-danger" (click)="save(true)" [disabled]="busy()">Bukan duplikat — simpan</button>
          }
          <button class="btn btn-primary" (click)="save(false)" [disabled]="busy()">Simpan</button>
        </div>
      </app-modal>
    }
  `,
})
export class PatientsPage {
  readonly auth = inject(AuthService);
  private readonly api = inject(Api);
  private readonly toasts = inject(Toasts);
  private readonly router = inject(Router);
  readonly q = input<string>();
  term = '';
  readonly rows = signal<any[]>([]);
  readonly searched = signal(false);
  readonly creating = signal(false);
  readonly busy = signal(false);
  readonly candidates = signal<any[]>([]);
  readonly dupMessage = signal('');
  readonly nikDuplicate = signal(false);
  form = emptyPatient();

  constructor() {
    effect(() => {
      const q = this.q();
      if (q) {
        this.term = q;
        void this.search();
      }
    });
  }

  async search() {
    try {
      this.rows.set(await this.api.get('/patients', { q: this.term }));
      this.searched.set(true);
    } catch (e) {
      this.toasts.error(e);
    }
  }

  openNew() {
    this.form = emptyPatient();
    if (/^[a-zA-Z\s.']+$/.test(this.term)) this.form.name = this.term.toUpperCase();
    this.candidates.set([]);
    this.creating.set(true);
  }

  async save(confirmNotDuplicate: boolean) {
    this.busy.set(true);
    try {
      const p = await this.api.post('/patients', { ...cleanPayload(this.form), confirmNotDuplicate });
      this.toasts.success(`Pasien terdaftar — No. RM ${p.mrn}`);
      this.creating.set(false);
      await this.router.navigate(['/patients', p.id]);
    } catch (e) {
      if (e instanceof ApiError && e.details?.candidates) {
        this.candidates.set(e.details.candidates);
        this.dupMessage.set(e.message);
        this.nikDuplicate.set(e.code === 'DUPLICATE_PATIENT_NIK');
      } else this.toasts.error(e);
    } finally {
      this.busy.set(false);
    }
  }
}
