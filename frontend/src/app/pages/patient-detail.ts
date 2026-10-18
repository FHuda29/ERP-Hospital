import { Component, inject, input, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { Api, ApiError, AuthService } from '../core/api';
import { ENCOUNTER_TYPE, PIPES, Toasts } from '../core/ui';
import { SHARED } from '../shared/components';
import { PatientForm, cleanPayload, emptyPatient } from './patients';

@Component({
  selector: 'app-patient-detail',
  imports: [FormsModule, RouterLink, PatientForm, ...SHARED, ...PIPES],
  template: `
    @if (p(); as p) {
      <app-patient-banner [patient]="p" [allergies]="p.allergies" />
      @if (p.status === 'MERGED') {
        <div class="alert alert-warning mb-4">Rekam medis ini telah digabung. <a class="underline" [routerLink]="['/patients', p.mergedInto]">Buka rekam medis aktif</a></div>
      }
      <div class="flex flex-wrap gap-2 mb-4">
        @if (auth.can('encounter.write') && p.status === 'ACTIVE') { <a class="btn btn-primary" routerLink="/registration" [queryParams]="{ patientId: p.id }">Daftarkan kunjungan</a> }
        @if (auth.can('appointment.write')) { <a class="btn" routerLink="/appointments" [queryParams]="{ patientId: p.id }">Buat janji temu</a> }
        @if (auth.can('patient.write')) { <button class="btn" (click)="startEdit()">Ubah data</button> }
        @if (auth.can('patient.write') && p.nikMasked) { <button class="btn" (click)="revealOpen.set(true)">Tampilkan NIK</button> }
        @if (auth.can('patient.merge')) { <button class="btn" (click)="mergeOpen.set(true)">Gabung rekam medis ganda</button> }
      </div>

      <div class="tabs mb-4">
        @for (t of tabs; track t.key) {
          <button class="tab" [class.tab-active]="tab() === t.key" (click)="selectTab(t.key)">{{ t.label }}</button>
        }
      </div>

      @switch (tab()) {
        @case ('profil') {
          <div class="card card-pad grid sm:grid-cols-3 gap-x-6 gap-y-3 text-sm">
            @for (f of profileFields(p); track f[0]) {
              <div><div class="muted">{{ f[0] }}</div><div class="font-medium">{{ f[1] || '—' }}</div></div>
            }
          </div>
        }
        @case ('alergi') {
          <div class="card">
            <table class="tbl">
              <thead><tr><th>Zat</th><th>Kategori</th><th>Reaksi</th><th>Keparahan</th><th></th></tr></thead>
              <tbody>
                @for (a of p.allergies; track a.id) {
                  <tr><td class="font-medium">{{ a.substance }}</td><td>{{ a.category }}</td><td>{{ a.reaction }}</td>
                    <td><span class="badge" [class.badge-critical]="a.severity === 'BERAT'" [class.badge-warning]="a.severity !== 'BERAT'">{{ a.severity }}</span></td>
                    <td>@if (auth.can('clinical.write')) { <button class="btn btn-sm" (click)="deactivate(a.id)">Nonaktifkan</button> }</td></tr>
                } @empty { <tr><td colspan="5"><app-empty text="Tidak ada alergi tercatat" /></td></tr> }
              </tbody>
            </table>
            @if (auth.can('patient.write', 'clinical.write')) {
              <form class="p-4 border-t border-line grid sm:grid-cols-5 gap-2 items-end" (ngSubmit)="addAllergy()">
                <div class="field sm:col-span-2"><label class="label">Zat / obat</label><input class="input" name="s" [(ngModel)]="allergy.substance" required /></div>
                <div class="field"><label class="label">Kategori</label><select class="input" name="c" [(ngModel)]="allergy.category"><option>OBAT</option><option>MAKANAN</option><option>LINGKUNGAN</option></select></div>
                <div class="field"><label class="label">Keparahan</label><select class="input" name="sv" [(ngModel)]="allergy.severity"><option>RINGAN</option><option>SEDANG</option><option>BERAT</option></select></div>
                <div class="field"><label class="label">Reaksi</label><input class="input" name="r" [(ngModel)]="allergy.reaction" /></div>
                <button class="btn btn-primary sm:col-span-5 justify-self-end">Tambah alergi</button>
              </form>
            }
          </div>
        }
        @case ('kunjungan') {
          <div class="card">
            <table class="tbl">
              <thead><tr><th>No. kunjungan</th><th>Jenis</th><th>Unit</th><th>Mulai</th><th>Selesai</th><th>Status</th></tr></thead>
              <tbody>
                @for (e of encounters(); track e.id) {
                  <tr><td><a class="text-primary hover:underline" [routerLink]="['/encounters', e.id]">{{ e.encounterNo }}</a></td><td>{{ types[e.type] }}</td><td>{{ e.unitName }}</td>
                    <td>{{ e.startAt | dt }}</td><td>{{ e.endAt | dt }}</td><td><app-status [value]="e.status" /></td></tr>
                } @empty { <tr><td colspan="6"><app-empty /></td></tr> }
              </tbody>
            </table>
          </div>
        }
        @case ('rme') {
          @if (timelineError()) {
            <div class="alert alert-warning">{{ timelineError() }}</div>
          }
          @for (e of timeline(); track e.id) {
            <div class="card card-pad mb-3">
              <div class="flex justify-between"><b>{{ e.encounterNo }} · {{ types[e.type] }} · {{ e.unitName }}</b><span class="muted">{{ e.startAt | dt }}</span></div>
              <div class="text-sm mt-1">Diagnosis: @for (d of e.diagnoses; track d.id) { <span class="badge badge-info mr-1">{{ d.icd10Code }} {{ d.display }}</span> } @empty { — }</div>
              @for (n of e.notes; track n.id) {
                <div class="text-sm mt-2 border-l-2 border-line pl-3"><span class="muted">{{ n.type }} · {{ n.authorName }} · {{ n.createdAt | dt }}</span><div><b>A:</b> {{ n.assessment }} <b>P:</b> {{ n.plan }}</div></div>
              }
            </div>
          } @empty { @if (!timelineError()) { <app-empty text="Belum ada riwayat RME" /> } }
        }
        @case ('consent') {
          <div class="card">
            <table class="tbl">
              <thead><tr><th>Jenis</th><th>Keputusan</th><th>Ditandatangani oleh</th><th>Waktu</th></tr></thead>
              <tbody>
                @for (c of consents(); track c.id) {
                  <tr><td>{{ c.type }}</td><td><span class="badge" [class.badge-success]="c.granted" [class.badge-critical]="!c.granted">{{ c.granted ? 'Setuju' : 'Menolak' }}</span></td>
                    <td>{{ c.signedBy }} @if (c.relationship) { ({{ c.relationship }}) }</td><td>{{ c.createdAt | dt }}</td></tr>
                } @empty { <tr><td colspan="4"><app-empty text="Belum ada persetujuan tercatat" /></td></tr> }
              </tbody>
            </table>
            @if (auth.can('patient.write', 'clinical.write')) {
              <form class="p-4 border-t border-line grid sm:grid-cols-4 gap-2 items-end" (ngSubmit)="addConsent()">
                <div class="field"><label class="label">Jenis</label><select class="input" name="t" [(ngModel)]="consent.type">
                  <option value="GENERAL_CONSENT">Persetujuan umum</option><option value="TINDAKAN_MEDIS">Tindakan medis</option><option value="BERBAGI_DATA_SATUSEHAT">Berbagi data SATUSEHAT</option><option value="PENOLAKAN_TINDAKAN">Penolakan tindakan</option></select></div>
                <div class="field"><label class="label">Keputusan</label><select class="input" name="g" [(ngModel)]="consent.granted"><option [ngValue]="true">Setuju</option><option [ngValue]="false">Menolak</option></select></div>
                <div class="field"><label class="label">Ditandatangani oleh</label><input class="input" name="sb" [(ngModel)]="consent.signedBy" required /></div>
                <div class="field"><label class="label">Hubungan</label><input class="input" name="rel" [(ngModel)]="consent.relationship" placeholder="Pasien / suami / anak…" /></div>
                <button class="btn btn-primary sm:col-span-4 justify-self-end">Simpan persetujuan</button>
              </form>
            }
          </div>
        }
      }
    }

    @if (editOpen()) {
      <app-modal title="Ubah data pasien" [width]="760" (closed)="editOpen.set(false)">
        <app-patient-form [model]="edit" />
        <div class="flex justify-end gap-2 mt-4"><button class="btn" (click)="editOpen.set(false)">Batal</button><button class="btn btn-primary" (click)="saveEdit()">Simpan</button></div>
      </app-modal>
    }
    @if (revealOpen()) {
      <app-modal title="Tampilkan NIK lengkap" [width]="440" (closed)="closeReveal()">
        @if (nik()) {
          <div class="text-2xl font-semibold tabular-nums text-center py-4">{{ nik() }}</div>
          <p class="muted text-center">Akses ini tercatat di jejak audit.</p>
        } @else {
          <p class="text-sm mb-2">NIK adalah data pribadi spesifik. Sebutkan tujuan akses (tercatat di audit).</p>
          <input class="input mb-3" [(ngModel)]="revealReason" placeholder="mis. Verifikasi identitas untuk SEP" />
          <div class="flex justify-end"><button class="btn btn-primary" (click)="reveal()" [disabled]="revealReason.length < 5">Tampilkan</button></div>
        }
      </app-modal>
    }
    @if (mergeOpen()) {
      <app-modal title="Gabung rekam medis ganda" [width]="520" (closed)="mergeOpen.set(false)">
        <p class="text-sm mb-3">Seluruh kunjungan, data klinis, dan tagihan dari pasien <b>sumber</b> dipindah ke pasien ini (<b>target</b>). Pasien sumber ditandai "Digabung". Tindakan tidak dapat dibatalkan dan tercatat di audit.</p>
        <div class="field mb-2"><label class="label">No. RM / nama pasien sumber</label>
          <div class="flex gap-2"><input class="input" [(ngModel)]="mergeQuery" /><button class="btn" (click)="findMerge()">Cari</button></div></div>
        @for (c of mergeCandidates(); track c.id) {
          <label class="flex items-center gap-2 py-1 text-sm"><input type="radio" name="src" [value]="c.id" [(ngModel)]="mergeSource" /> RM {{ c.mrn | mrn }} — {{ c.name }} ({{ c.birthDate | d }})</label>
        }
        <div class="field mt-2"><label class="label">Alasan penggabungan</label><textarea class="input" [(ngModel)]="mergeReason"></textarea></div>
        <div class="flex justify-end mt-3"><button class="btn btn-danger" [disabled]="!mergeSource || mergeReason.length < 10" (click)="merge()">Gabungkan</button></div>
      </app-modal>
    }
  `,
})
export class PatientDetailPage implements OnInit {
  readonly auth = inject(AuthService);
  private readonly api = inject(Api);
  private readonly toasts = inject(Toasts);
  private readonly router = inject(Router);
  readonly id = input.required<string>();
  readonly types = ENCOUNTER_TYPE;
  readonly p = signal<any>(null);
  readonly tab = signal('profil');
  readonly encounters = signal<any[]>([]);
  readonly consents = signal<any[]>([]);
  readonly timeline = signal<any[]>([]);
  readonly timelineError = signal('');
  readonly editOpen = signal(false);
  readonly revealOpen = signal(false);
  readonly mergeOpen = signal(false);
  readonly nik = signal('');
  readonly mergeCandidates = signal<any[]>([]);
  readonly tabs = [
    { key: 'profil', label: 'Profil' },
    { key: 'alergi', label: 'Alergi' },
    { key: 'kunjungan', label: 'Riwayat kunjungan' },
    { key: 'rme', label: 'Timeline RME' },
    { key: 'consent', label: 'Persetujuan (consent)' },
  ];
  edit = emptyPatient();
  allergy = { substance: '', category: 'OBAT', severity: 'SEDANG', reaction: '' };
  consent = { type: 'GENERAL_CONSENT', granted: true, signedBy: '', relationship: '' };
  revealReason = '';
  mergeQuery = '';
  mergeSource = '';
  mergeReason = '';

  async ngOnInit() {
    await this.load();
  }

  async load() {
    try {
      this.p.set(await this.api.get(`/patients/${this.id()}`));
    } catch (e) {
      this.toasts.error(e);
    }
  }

  async selectTab(key: string) {
    this.tab.set(key);
    try {
      if (key === 'kunjungan') this.encounters.set(await this.api.get(`/patients/${this.id()}/encounters`));
      if (key === 'consent') this.consents.set(await this.api.get(`/patients/${this.id()}/consents`));
      if (key === 'rme') {
        this.timelineError.set('');
        this.timeline.set(await this.api.get(`/clinical/patients/${this.id()}/timeline`));
      }
    } catch (e) {
      if (key === 'rme' && e instanceof ApiError) this.timelineError.set(e.message);
      else this.toasts.error(e);
    }
  }

  profileFields(p: any): [string, string][] {
    return [
      ['NIK', p.nikMasked], ['No. JKN', p.bpjsNumber], ['IHS SATUSEHAT', p.satusehatId], ['Tempat lahir', p.birthPlace], ['Golongan darah', p.bloodType],
      ['Nama ibu', p.motherName], ['No. HP', p.phone], ['Alamat', [p.address, p.city, p.province].filter(Boolean).join(', ')], ['Agama', p.religion],
      ['Status perkawinan', p.maritalStatus], ['Pekerjaan', p.occupation], ['Kontak darurat', [p.emergencyContactName, p.emergencyContactPhone].filter(Boolean).join(' · ')],
    ];
  }

  startEdit() {
    const p = this.p();
    this.edit = { ...emptyPatient(), ...Object.fromEntries(Object.keys(emptyPatient()).map((k) => [k, p[k] ?? ''])), nik: '' };
    this.editOpen.set(true);
  }

  async saveEdit() {
    try {
      await this.api.patch(`/patients/${this.id()}`, cleanPayload(this.edit));
      this.toasts.success('Data pasien diperbarui');
      this.editOpen.set(false);
      await this.load();
    } catch (e) {
      this.toasts.error(e);
    }
  }

  async addAllergy() {
    try {
      await this.api.post(`/patients/${this.id()}/allergies`, cleanPayload(this.allergy));
      this.allergy = { substance: '', category: 'OBAT', severity: 'SEDANG', reaction: '' };
      await this.load();
    } catch (e) {
      this.toasts.error(e);
    }
  }

  async deactivate(aid: string) {
    try {
      await this.api.post(`/patients/${this.id()}/allergies/${aid}/deactivate`);
      await this.load();
    } catch (e) {
      this.toasts.error(e);
    }
  }

  async addConsent() {
    try {
      await this.api.post(`/patients/${this.id()}/consents`, cleanPayload(this.consent));
      this.consent = { type: 'GENERAL_CONSENT', granted: true, signedBy: '', relationship: '' };
      await this.selectTab('consent');
    } catch (e) {
      this.toasts.error(e);
    }
  }

  async reveal() {
    try {
      this.nik.set((await this.api.post(`/patients/${this.id()}/reveal-nik`, { reason: this.revealReason })).nik);
    } catch (e) {
      this.toasts.error(e);
    }
  }

  closeReveal() {
    this.revealOpen.set(false);
    this.nik.set('');
    this.revealReason = '';
  }

  async findMerge() {
    const rows = await this.api.get<any[]>('/patients', { q: this.mergeQuery });
    this.mergeCandidates.set(rows.filter((r) => r.id !== this.id()));
  }

  async merge() {
    try {
      const r = await this.api.post('/patients/merge', { sourceId: this.mergeSource, targetId: this.id(), reason: this.mergeReason });
      this.toasts.success(`RM ${r.mergedFrom} digabung ke ${r.into}`);
      this.mergeOpen.set(false);
      await this.load();
    } catch (e) {
      this.toasts.error(e);
    }
  }
}
