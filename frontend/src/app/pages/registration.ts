import { AfterViewInit, Component, computed, inject, input, OnInit, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Api, AuthService } from '../core/api';
import { ENCOUNTER_TYPE, PIPES, Toasts } from '../core/ui';
import { SHARED } from '../shared/components';
import { cleanPayload } from './patients';

/** Pilih pasien dengan pencarian (dipakai di beberapa halaman). */
@Component({
  selector: 'app-patient-picker',
  imports: [FormsModule, ...PIPES],
  template: `
    @if (selected(); as s) {
      <div class="flex items-center justify-between card px-3 py-2">
        <div><b>{{ s.name }}</b> <span class="muted">RM {{ s.mrn | mrn }} · {{ s.birthDate | d }} · {{ s.gender }} @if (s.bpjsNumber) { · JKN {{ s.bpjsNumber }} }</span></div>
        <button class="btn btn-sm" (click)="clear()">Ganti</button>
      </div>
    } @else {
      <div class="flex gap-2">
        <input class="input" [(ngModel)]="q" (keydown.enter)="search()" placeholder="Cari nama / No. RM / NIK / No. JKN" />
        <button class="btn" type="button" (click)="search()">Cari</button>
      </div>
      @if (results().length) {
        <div class="card mt-1 max-h-60 overflow-y-auto">
          @for (r of results(); track r.id) {
            <button type="button" class="block w-full text-left px-3 py-2 hover:bg-primary-soft border-b border-line text-sm" (click)="pick(r)">
              <b>{{ r.name }}</b> <span class="muted">RM {{ r.mrn | mrn }} · {{ r.birthDate | d }} · NIK {{ r.nikMasked ?? '—' }}</span>
            </button>
          }
        </div>
      }
    }
  `,
})
export class PatientPicker {
  private readonly api = inject(Api);
  readonly selected = signal<any>(null);
  readonly results = signal<any[]>([]);
  onPick: (p: any) => void = () => {};
  q = '';

  async search() {
    this.results.set(await this.api.get('/patients', { q: this.q }));
  }
  pick(p: any) {
    this.selected.set(p);
    this.results.set([]);
    this.onPick(p);
  }
  clear() {
    this.selected.set(null);
    this.onPick(null);
  }
  async preload(id: string) {
    const p = await this.api.get(`/patients/${id}`);
    this.pick(p);
  }
}

@Component({
  selector: 'app-registration',
  imports: [FormsModule, RouterLink, PatientPicker, ...SHARED, ...PIPES],
  template: `
    <app-page-header title="Pendaftaran Kunjungan" subtitle="Rawat jalan, IGD, dan admisi rawat inap. Penjamin JKN: eligibilitas dicek & SEP diterbitkan otomatis." />

    @if (result(); as r) {
      <div class="card card-pad mb-4 border-l-4 border-l-success">
        <div class="h2 text-success mb-1">✓ Pendaftaran berhasil — {{ r.encounterNo }}</div>
        <div class="text-sm space-y-0.5">
          @if (r.queue) { <div>Nomor antrean: <b class="text-lg">{{ r.queue.label }}</b></div> }
          @if (r.sepNumber) { <div>No. SEP: <b>{{ r.sepNumber }}</b></div> }
          @for (w of r.warnings; track w) { <div class="alert alert-warning mt-1">{{ w }}</div> }
        </div>
        <div class="flex gap-2 mt-3">
          <a class="btn btn-primary" [routerLink]="['/encounters', r.id]">Buka kunjungan</a>
          <button class="btn" (click)="reset()">Pendaftaran baru</button>
        </div>
      </div>
    }

    <div class="grid lg:grid-cols-3 gap-4">
      <div class="card card-pad lg:col-span-2 space-y-4">
        <div>
          <div class="label">Pasien *</div>
          <app-patient-picker #picker />
          <div class="muted mt-1">Pasien belum terdaftar? <a class="text-primary underline" routerLink="/patients">Registrasi pasien baru</a></div>
        </div>

        <div>
          <div class="label">Jenis kunjungan *</div>
          <div class="flex gap-2">
            @for (t of typeKeys; track t) {
              <button type="button" class="btn" [class.btn-primary]="form.type === t" (click)="setType(t)">{{ types[t] }}</button>
            }
          </div>
        </div>

        <div class="grid sm:grid-cols-2 gap-3">
          <div class="field"><label class="label">Unit / Poli *</label>
            <select class="input" [(ngModel)]="form.unitId" (ngModelChange)="onUnit()">
              <option value="">— pilih —</option>
              @for (u of unitOptions(); track u.id) { <option [value]="u.id">{{ u.name }}</option> }
            </select></div>
          <div class="field"><label class="label">DPJP {{ form.type === 'IGD' ? '(opsional)' : '*' }}</label>
            <select class="input" [(ngModel)]="form.practitionerId">
              <option value="">— pilih —</option>
              @for (d of doctors(); track d.id) { <option [value]="d.id">{{ d.name }}</option> }
            </select></div>
          <div class="field"><label class="label">Penjamin *</label>
            <select class="input" [(ngModel)]="form.payerId" (ngModelChange)="peserta.set(null)">
              @for (p of payers(); track p.id) { <option [value]="p.id">{{ p.name }}</option> }
            </select></div>
          <div class="field"><label class="label">Keluhan utama</label><input class="input" [(ngModel)]="form.chiefComplaint" /></div>
        </div>

        @if (isBpjs()) {
          <div class="card card-pad bg-canvas grid sm:grid-cols-3 gap-3 items-end">
            <div class="field"><label class="label">No. kartu JKN</label><input class="input" [(ngModel)]="form.payerMemberNo" [placeholder]="picker.selected()?.bpjsNumber ?? '13 digit'" /></div>
            <div class="field"><label class="label">No. rujukan</label><input class="input" [(ngModel)]="form.referralNo" /></div>
            <div class="field"><label class="label">Diagnosis awal (ICD-10)</label><input class="input uppercase" [(ngModel)]="form.initialDiagnosis" placeholder="mis. I10" /></div>
            <button type="button" class="btn sm:col-span-3 justify-self-start" (click)="checkPeserta()">Cek eligibilitas peserta</button>
            @if (peserta(); as ps) {
              <div class="sm:col-span-3 alert" [class.alert-success]="ps.aktif" [class.alert-critical]="!ps.aktif">
                {{ ps.nama }} — <b>{{ ps.statusPeserta }}</b> · Hak kelas {{ ps.hakKelas }} · {{ ps.jenisPeserta }}
              </div>
            }
          </div>
        }

        @if (form.type === 'RAWAT_INAP') {
          <div>
            <div class="label">Tempat tidur *</div>
            <div class="grid grid-cols-2 sm:grid-cols-4 gap-2">
              @for (b of availableBeds(); track b.bedId) {
                <button type="button" class="card px-3 py-2 text-left text-sm hover:border-primary" [class.!border-primary]="form.bedId === b.bedId" [class.bg-primary-soft]="form.bedId === b.bedId" (click)="form.bedId = b.bedId">
                  <b>{{ b.bedCode }}</b><div class="muted">{{ b.roomName }} · {{ b.careClass }}</div>
                </button>
              } @empty { <div class="text-ink-3 text-sm">Tidak ada bed tersedia di unit ini</div> }
            </div>
          </div>
        }

        <div class="flex justify-end">
          <button class="btn btn-primary" (click)="submit()" [disabled]="busy() || !picker.selected()">{{ busy() ? 'Memproses…' : 'Daftarkan' }}</button>
        </div>
      </div>

      <div class="card card-pad text-sm space-y-2 h-fit">
        <div class="h2">Panduan</div>
        <p>1. Cari pasien terlebih dahulu (NIK/No. RM) — hindari rekam medis ganda.</p>
        <p>2. Penjamin <b>BPJS</b>: sistem memeriksa status kepesertaan dan menerbitkan SEP. Jika layanan BPJS tidak tersedia, pelayanan tetap berjalan dan SEP dapat diterbitkan ulang dari halaman kunjungan.</p>
        <p>3. <b>Rawat inap</b>: pilih bed tersedia. Bed berubah menjadi "Terisi" otomatis; biaya akomodasi dihitung per hari rawat saat pulang.</p>
        <p>4. Biaya administrasi & jasa pemeriksaan tercatat otomatis (charge capture).</p>
      </div>
    </div>
  `,
})
export class RegistrationPage implements OnInit, AfterViewInit {
  readonly picker = viewChild.required(PatientPicker);
  private readonly api = inject(Api);
  private readonly toasts = inject(Toasts);
  readonly auth = inject(AuthService);
  readonly patientId = input<string>();
  readonly parentEncounterId = input<string>();
  readonly types = ENCOUNTER_TYPE;
  readonly typeKeys = ['RAWAT_JALAN', 'IGD', 'RAWAT_INAP'];
  readonly units = signal<any[]>([]);
  readonly practitioners = signal<any[]>([]);
  readonly payers = signal<any[]>([]);
  readonly beds = signal<any[]>([]);
  readonly peserta = signal<any>(null);
  readonly result = signal<any>(null);
  readonly busy = signal(false);
  readonly typeSig = signal('RAWAT_JALAN');
  readonly unitSig = signal('');
  readonly payerSig = signal('');

  form: any = this.blank();

  private blank() {
    return { type: 'RAWAT_JALAN', unitId: '', practitionerId: '', payerId: '', chiefComplaint: '', payerMemberNo: '', referralNo: '', initialDiagnosis: '', bedId: '' };
  }

  readonly unitOptions = computed(() => {
    const allowed: Record<string, string[]> = { RAWAT_JALAN: ['POLI'], IGD: ['IGD'], RAWAT_INAP: ['RAWAT_INAP', 'ICU'] };
    return this.units().filter((u) => allowed[this.typeSig()].includes(u.type));
  });
  readonly doctors = computed(() => this.practitioners().filter((p) => p.profession.startsWith('DOKTER') && p.active));
  readonly availableBeds = computed(() => this.beds().filter((b) => b.status === 'AVAILABLE' && b.unitId === this.unitSig()));
  isBpjs() {
    return this.payers().find((p) => p.id === this.form.payerId)?.type === 'BPJS';
  }

  async ngOnInit() {
    const [u, pr, py, b] = await Promise.all([this.api.get('/master/units'), this.api.get('/master/practitioners'), this.api.get('/master/payers'), this.api.get('/master/bed-board')]);
    this.units.set(u);
    this.practitioners.set(pr);
    this.payers.set(py.filter((p: any) => p.active));
    this.beds.set(b);
    this.form.payerId = py.find((p: any) => p.type === 'UMUM')?.id ?? py[0]?.id;
  }

  setType(t: string) {
    this.form.type = t;
    this.form.unitId = '';
    this.form.bedId = '';
    this.typeSig.set(t);
    this.unitSig.set('');
  }

  onUnit() {
    this.unitSig.set(this.form.unitId);
    this.form.bedId = '';
  }

  async checkPeserta() {
    try {
      const no = this.form.payerMemberNo || this.picker().selected()?.bpjsNumber;
      this.peserta.set(await this.api.post('/integration/bpjs/peserta', { noKartu: no }));
    } catch (e) {
      this.toasts.error(e);
    }
  }

  async ngAfterViewInit() {
    if (this.patientId()) await this.picker().preload(this.patientId()!);
  }

  async submit() {
    const patient = this.picker().selected();
    if (!patient) return;
    this.busy.set(true);
    try {
      const body = cleanPayload({ ...this.form, patientId: patient.id, parentEncounterId: this.parentEncounterId() ?? '' });
      this.result.set(await this.api.post('/encounters', body));
      this.toasts.success('Kunjungan terdaftar');
      this.beds.set(await this.api.get('/master/bed-board'));
    } catch (e) {
      this.toasts.error(e);
    } finally {
      this.busy.set(false);
    }
  }

  reset() {
    this.result.set(null);
    const payer = this.form.payerId;
    this.form = { ...this.blank(), payerId: payer };
    this.typeSig.set('RAWAT_JALAN');
    this.picker().clear();
  }
}
