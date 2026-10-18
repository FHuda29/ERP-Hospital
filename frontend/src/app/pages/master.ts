import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Api } from '../core/api';
import { PIPES, Toasts } from '../core/ui';
import { SHARED } from '../shared/components';

interface FieldDef {
  key: string;
  label: string;
  type?: 'text' | 'number' | 'date' | 'bool' | 'select';
  options?: string[] | (() => { value: string; label: string }[]);
}

/**
 * Configurator master data generik (Blueprint §10): unit, ruang, bed, tenaga kesehatan,
 * jadwal, penjamin, layanan & tarif, formularium, vendor, gudang.
 */
@Component({
  selector: 'app-master',
  imports: [FormsModule, ...SHARED, ...PIPES],
  template: `
    <app-page-header title="Master Data" subtitle="Konfigurasi per fasilitas. Perubahan tercatat di jejak audit.">
      <button class="btn btn-primary" (click)="startNew()">+ Tambah</button>
    </app-page-header>
    <div class="tabs mb-4">
      @for (e of entityKeys; track e) { <button class="tab" [class.tab-active]="entity() === e" (click)="select(e)">{{ defs[e].label }}</button> }
      <button class="tab" [class.tab-active]="entity() === 'facility'" (click)="selectFacility()">Profil fasilitas</button>
    </div>

    @if (entity() === 'facility') {
      @if (facility) {
        <div class="card card-pad grid sm:grid-cols-2 gap-3 max-w-3xl">
          @for (f of facilityFields; track f.key) {
            <div class="field"><label class="label">{{ f.label }}</label>
              @if (f.type === 'select') { <select class="input" [(ngModel)]="facility[f.key]">@for (o of asOptions(f); track o.value) {<option [value]="o.value">{{ o.label }}</option>}</select> }
              @else { <input class="input" [(ngModel)]="facility[f.key]" /> }
            </div>
          }
          <div class="sm:col-span-2 flex justify-end"><button class="btn btn-primary" (click)="saveFacility()">Simpan</button></div>
        </div>
      }
    } @else {
      <input class="input max-w-sm mb-3" [(ngModel)]="q" (keydown.enter)="load()" placeholder="Cari…" />
      <div class="card overflow-x-auto">
        <table class="tbl">
          <thead><tr>@for (f of cols(); track f.key) { <th>{{ f.label }}</th> }<th></th></tr></thead>
          <tbody>
            @for (r of rows(); track r.id) {
              <tr>
                @for (f of cols(); track f.key) { <td>{{ display(f, r[f.key]) }}</td> }
                <td><button class="btn btn-sm" (click)="startEdit(r)">Ubah</button></td>
              </tr>
            } @empty { <tr><td [attr.colspan]="cols().length + 1"><app-empty /></td></tr> }
          </tbody>
        </table>
      </div>
    }

    @if (editing) {
      <app-modal [title]="(editing.id ? 'Ubah ' : 'Tambah ') + defs[entity()].label" [width]="640" (closed)="editing = null">
        <div class="grid sm:grid-cols-2 gap-3">
          @for (f of defs[entity()].fields; track f.key) {
            <div class="field">
              @if (f.type === 'bool') {
                <label class="text-sm flex items-center gap-2 mt-5"><input type="checkbox" [(ngModel)]="editing[f.key]" /> {{ f.label }}</label>
              } @else {
                <label class="label">{{ f.label }}</label>
                @if (f.type === 'select') {
                  <select class="input" [(ngModel)]="editing[f.key]"><option value="">—</option>@for (o of asOptions(f); track o.value) {<option [value]="o.value">{{ o.label }}</option>}</select>
                } @else {
                  <input class="input" [type]="f.type ?? 'text'" [(ngModel)]="editing[f.key]" />
                }
              }
            </div>
          }
        </div>
        <div class="flex justify-end mt-3"><button class="btn btn-primary" (click)="save()">Simpan</button></div>
      </app-modal>
    }
  `,
})
export class MasterPage implements OnInit {
  private readonly api = inject(Api);
  private readonly toasts = inject(Toasts);
  readonly entity = signal('units');
  readonly rows = signal<any[]>([]);
  readonly refs = signal<Record<string, any[]>>({});
  q = '';
  editing: any = null;
  facility: any = null;

  private ref = (name: string, label = 'name') => () => (this.refs()[name] ?? []).map((x) => ({ value: x.id, label: x[label] ?? x.code }));
  private readonly accounts = () => (this.refs()['accounts'] ?? []).filter((a) => a.isPostable).map((a) => ({ value: a.code, label: `${a.code} ${a.name}` }));

  readonly defs: Record<string, { label: string; fields: FieldDef[] }> = {
    units: { label: 'Unit', fields: [
      { key: 'code', label: 'Kode' }, { key: 'name', label: 'Nama' },
      { key: 'type', label: 'Jenis', type: 'select', options: ['POLI', 'IGD', 'RAWAT_INAP', 'ICU', 'OK', 'LAB', 'RADIOLOGI', 'FARMASI', 'KASIR', 'GUDANG', 'ADMIN', 'REKAM_MEDIS'] },
      { key: 'bpjsPoliCode', label: 'Kode poli BPJS' }, { key: 'satusehatLocationId', label: 'Location ID SATUSEHAT' }, { key: 'queuePrefix', label: 'Prefix antrean' }, { key: 'active', label: 'Aktif', type: 'bool' },
    ] },
    rooms: { label: 'Ruang', fields: [
      { key: 'unitId', label: 'Unit', type: 'select', options: this.ref('units') }, { key: 'code', label: 'Kode' }, { key: 'name', label: 'Nama' },
      { key: 'careClass', label: 'Kelas', type: 'select', options: ['KRIS', 'VVIP', 'VIP', 'KELAS_1', 'KELAS_2', 'KELAS_3', 'ICU', 'ISOLASI'] },
    ] },
    beds: { label: 'Bed', fields: [{ key: 'roomId', label: 'Ruang', type: 'select', options: this.ref('rooms') }, { key: 'code', label: 'Kode bed' }] },
    practitioners: { label: 'Tenaga kesehatan', fields: [
      { key: 'name', label: 'Nama & gelar' },
      { key: 'profession', label: 'Profesi', type: 'select', options: ['DOKTER', 'DOKTER_SPESIALIS', 'DOKTER_GIGI', 'PERAWAT', 'BIDAN', 'APOTEKER', 'TTK', 'ANALIS', 'RADIOGRAFER', 'NUTRISIONIS'] },
      { key: 'specialty', label: 'Spesialisasi' }, { key: 'nik', label: 'NIK (terenkripsi)' },
      { key: 'strNumber', label: 'No. STR' }, { key: 'strExpiry', label: 'STR berlaku s.d.', type: 'date' },
      { key: 'sipNumber', label: 'No. SIP' }, { key: 'sipExpiry', label: 'SIP berlaku s.d.', type: 'date' },
      { key: 'satusehatId', label: 'IHS SATUSEHAT' }, { key: 'bpjsDpjpCode', label: 'Kode DPJP BPJS' }, { key: 'active', label: 'Aktif', type: 'bool' },
    ] },
    schedules: { label: 'Jadwal praktik', fields: [
      { key: 'practitionerId', label: 'Dokter', type: 'select', options: this.ref('practitioners') }, { key: 'unitId', label: 'Poli', type: 'select', options: this.ref('units') },
      { key: 'dayOfWeek', label: 'Hari (1=Senin..7=Minggu)', type: 'number' }, { key: 'startTime', label: 'Mulai (HH:MM)' }, { key: 'endTime', label: 'Selesai (HH:MM)' }, { key: 'quota', label: 'Kuota', type: 'number' },
    ] },
    payers: { label: 'Penjamin', fields: [
      { key: 'code', label: 'Kode' }, { key: 'name', label: 'Nama' }, { key: 'type', label: 'Jenis', type: 'select', options: ['UMUM', 'BPJS', 'ASURANSI', 'PERUSAHAAN', 'JAMKESDA'] },
      { key: 'receivableAccount', label: 'Akun piutang', type: 'select', options: this.accounts }, { key: 'active', label: 'Aktif', type: 'bool' },
    ] },
    services: { label: 'Layanan', fields: [
      { key: 'code', label: 'Kode' }, { key: 'name', label: 'Nama' },
      { key: 'category', label: 'Kategori', type: 'select', options: ['KONSULTASI', 'TINDAKAN', 'LAB', 'RADIOLOGI', 'AKOMODASI', 'ADMINISTRASI', 'VISITE', 'OPERASI'] },
      { key: 'icd9cmCode', label: 'ICD-9-CM' }, { key: 'loincCode', label: 'LOINC' }, { key: 'revenueAccount', label: 'Akun pendapatan', type: 'select', options: this.accounts }, { key: 'active', label: 'Aktif', type: 'bool' },
    ] },
    tariffs: { label: 'Tarif', fields: [
      { key: 'serviceId', label: 'Layanan', type: 'select', options: this.ref('services') },
      { key: 'payerType', label: 'Jenis penjamin (kosong = semua)', type: 'select', options: ['UMUM', 'BPJS', 'ASURANSI', 'PERUSAHAAN', 'JAMKESDA'] },
      { key: 'careClass', label: 'Kelas (kosong = semua)', type: 'select', options: ['KRIS', 'VVIP', 'VIP', 'KELAS_1', 'KELAS_2', 'KELAS_3', 'ICU', 'ISOLASI'] },
      { key: 'price', label: 'Tarif (Rp)', type: 'number' }, { key: 'effectiveFrom', label: 'Berlaku mulai', type: 'date' }, { key: 'effectiveTo', label: 'Berlaku s.d.', type: 'date' },
    ] },
    items: { label: 'Obat & BMHP', fields: [
      { key: 'code', label: 'Kode' }, { key: 'name', label: 'Nama dagang/generik' }, { key: 'genericName', label: 'Nama generik (huruf kecil)' }, { key: 'kfaCode', label: 'Kode KFA' },
      { key: 'category', label: 'Kategori', type: 'select', options: ['OBAT', 'ALKES', 'BMHP'] }, { key: 'dosageForm', label: 'Sediaan' }, { key: 'strength', label: 'Kekuatan' }, { key: 'uom', label: 'Satuan' },
      { key: 'salePrice', label: 'Harga jual', type: 'number' }, { key: 'minStock', label: 'Stok minimum', type: 'number' },
      { key: 'isHighAlert', label: 'High-alert', type: 'bool' }, { key: 'isNarcotic', label: 'Narkotika/psikotropika', type: 'bool' }, { key: 'isFormulary', label: 'Formularium', type: 'bool' }, { key: 'active', label: 'Aktif', type: 'bool' },
    ] },
    vendors: { label: 'Vendor', fields: [
      { key: 'code', label: 'Kode' }, { key: 'name', label: 'Nama' }, { key: 'npwp', label: 'NPWP' }, { key: 'licenseNo', label: 'Izin PBF' }, { key: 'address', label: 'Alamat' }, { key: 'phone', label: 'Telepon' },
      { key: 'paymentTermDays', label: 'Termin (hari)', type: 'number' }, { key: 'active', label: 'Aktif', type: 'bool' },
    ] },
    warehouses: { label: 'Gudang', fields: [
      { key: 'code', label: 'Kode' }, { key: 'name', label: 'Nama' }, { key: 'type', label: 'Jenis', type: 'select', options: ['GUDANG_UTAMA', 'DEPO_FARMASI', 'DEPO_UNIT'] }, { key: 'unitId', label: 'Unit', type: 'select', options: this.ref('units') },
    ] },
  };
  readonly entityKeys = Object.keys(this.defs);
  readonly cols = computed(() => this.defs[this.entity()]?.fields.filter((f) => f.key !== 'nik').slice(0, 7) ?? []);

  readonly facilityFields: FieldDef[] = [
    { key: 'name', label: 'Nama fasilitas' }, { key: 'hospitalClass', label: 'Kelas RS', type: 'select', options: ['A', 'B', 'C', 'D'] },
    { key: 'kemkesCode', label: 'Kode faskes Kemenkes' }, { key: 'bpjsPpkCode', label: 'Kode PPK BPJS' }, { key: 'satusehatOrgId', label: 'Organization ID SATUSEHAT' },
    { key: 'address', label: 'Alamat' }, { key: 'city', label: 'Kota' }, { key: 'province', label: 'Provinsi' }, { key: 'phone', label: 'Telepon' },
    { key: 'timezone', label: 'Zona waktu', type: 'select', options: ['Asia/Jakarta', 'Asia/Makassar', 'Asia/Jayapura'] },
  ];

  async ngOnInit() {
    const [units, rooms, practitioners, services, accounts] = await Promise.all([
      this.api.get('/master/units'), this.api.get('/master/rooms'), this.api.get('/master/practitioners'), this.api.get('/master/services'), this.api.get('/finance/accounts').catch(() => []),
    ]);
    this.refs.set({ units, rooms, practitioners, services, accounts });
    await this.load();
  }

  asOptions(f: FieldDef) {
    const o = typeof f.options === 'function' ? f.options() : (f.options ?? []).map((v) => ({ value: v, label: v }));
    return o;
  }

  display(f: FieldDef, v: any) {
    if (f.type === 'bool') return v ? 'Ya' : 'Tidak';
    if (f.type === 'select' && typeof f.options === 'function') return f.options().find((o) => o.value === v)?.label ?? v ?? '—';
    if (f.type === 'number' && f.key === 'price') return new Intl.NumberFormat('id-ID').format(v);
    return v ?? '—';
  }

  async select(e: string) {
    this.entity.set(e);
    this.q = '';
    await this.load();
  }

  async selectFacility() {
    this.entity.set('facility');
    this.facility = await this.api.get('/master/facility');
  }

  async load() {
    try {
      this.rows.set(await this.api.get(`/master/${this.entity()}`, { q: this.q }));
    } catch (e) {
      this.toasts.error(e);
    }
  }

  startNew() {
    if (this.entity() === 'facility') return;
    this.editing = Object.fromEntries(this.defs[this.entity()].fields.map((f) => [f.key, f.type === 'bool' ? f.key === 'active' || f.key === 'isFormulary' : '']));
  }

  startEdit(r: any) {
    this.editing = { ...r };
  }

  async save() {
    const fields = this.defs[this.entity()].fields;
    const body: any = {};
    for (const f of fields) {
      const v = this.editing[f.key];
      if (v === '' || v === undefined) continue;
      body[f.key] = f.type === 'number' ? Number(v) : v;
    }
    try {
      if (this.editing.id) await this.api.patch(`/master/${this.entity()}/${this.editing.id}`, body);
      else await this.api.post(`/master/${this.entity()}`, body);
      this.toasts.success('Tersimpan');
      this.editing = null;
      await this.load();
    } catch (e: any) {
      this.toasts.error(e.details ? `${e.message}: ${e.details.map((d: any) => `${d.path} ${d.message}`).join('; ')}` : e);
    }
  }

  async saveFacility() {
    const body = Object.fromEntries(this.facilityFields.map((f) => [f.key, this.facility[f.key] || null]).filter(([k, v]) => v !== null || k !== 'name'));
    try {
      await this.api.patch('/master/facility', body);
      this.toasts.success('Profil fasilitas tersimpan');
    } catch (e) {
      this.toasts.error(e);
    }
  }
}
