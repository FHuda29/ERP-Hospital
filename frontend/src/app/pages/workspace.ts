import { Component, computed, inject, input, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { Api, ApiError, AuthService } from '../core/api';
import { ENCOUNTER_TYPE, PIPES, Toasts, TRIAGE } from '../core/ui';
import { SHARED } from '../shared/components';
import { cleanPayload } from './patients';

const NOTE_LABEL: Record<string, string> = {
  SOAP: 'SOAP',
  CPPT: 'CPPT',
  ASESMEN_AWAL_MEDIS: 'Asesmen awal medis',
  ASESMEN_KEPERAWATAN: 'Asesmen keperawatan',
  RESUME_MEDIS: 'Resume medis',
  AMENDMENT: 'Amandemen',
};

@Component({
  selector: 'app-workspace',
  imports: [FormsModule, RouterLink, ...SHARED, ...PIPES],
  template: `
    @if (accessDenied()) {
      <div class="card card-pad max-w-xl">
        <h1 class="h1 mb-2">Akses rekam medis dibatasi</h1>
        <div class="alert alert-warning mb-3">{{ accessDenied() }}</div>
        <p class="text-sm mb-2">Akses darurat (break-glass) hanya untuk kondisi yang mengancam keselamatan pasien. Alasan, waktu, dan seluruh aktivitas Anda akan dicatat dan ditinjau komite.</p>
        <textarea class="input mb-2" [(ngModel)]="bgReason" placeholder="Alasan klinis (min. 15 karakter)"></textarea>
        <button class="btn btn-danger" [disabled]="bgReason.length < 15" (click)="breakGlass()">Aktifkan akses darurat</button>
      </div>
    }

    @if (enc(); as e) {
      <app-patient-banner [patient]="e.patient" [encounter]="e" [allergies]="e.allergies" [accessBasis]="e.accessBasis" />

      <div class="flex flex-wrap gap-2 mb-4 no-print">
        @if (active()) {
          @if ((e.status === 'REGISTERED' || e.status === 'TRIAGED') && auth.can('clinical.write')) { <button class="btn btn-primary" (click)="act('start')">Mulai pemeriksaan</button> }
          @if (e.type === 'IGD' && auth.can('triage.write')) { <button class="btn" (click)="modal.set('triage')">Triase</button> }
          @if (e.type === 'RAWAT_INAP' && auth.can('bed.manage')) { <button class="btn" (click)="openTransfer()">Pindah bed</button> }
          @if (e.payer?.type === 'BPJS' && !e.sepNumber && auth.can('encounter.write')) { <button class="btn" (click)="act('sep')">Terbitkan SEP</button> }
          @if (auth.can('clinical.sign')) { <button class="btn btn-success" (click)="modal.set('discharge')">{{ e.type === 'RAWAT_INAP' ? 'Pulangkan pasien' : 'Selesaikan pelayanan' }}</button> }
          @if (e.type !== 'RAWAT_INAP' && auth.can('encounter.write')) {
            <a class="btn" routerLink="/registration" [queryParams]="{ patientId: e.patient.id, parentEncounterId: e.id }">Admisi rawat inap</a>
          }
          @if ((e.status === 'REGISTERED' || e.status === 'TRIAGED') && auth.can('encounter.write')) { <button class="btn btn-ghost" (click)="modal.set('cancel')">Batalkan kunjungan</button> }
        } @else {
          <span class="badge badge-neutral">Kunjungan selesai {{ e.endAt | dt }} — catatan baru hanya melalui amandemen</span>
        }
        @if (auth.can('billing.read')) { <a class="btn btn-ghost ml-auto" [routerLink]="['/billing/encounters', e.id]">Billing →</a> }
      </div>

      <div class="tabs mb-4 no-print">
        @for (t of visibleTabs(); track t.key) {
          <button class="tab" [class.tab-active]="tab() === t.key" (click)="tab.set(t.key)">{{ t.label }}</button>
        }
      </div>

      @if (rec(); as r) {
        @switch (tab()) {
          @case ('ringkasan') {
            <div class="grid lg:grid-cols-3 gap-4">
              <div class="card card-pad">
                <h3 class="h2 mb-2">Tanda vital terakhir</h3>
                @if (r.vitals[0]; as v) {
                  <dl class="grid grid-cols-2 gap-y-1 text-sm">
                    <dt class="text-ink-3">TD</dt><dd>{{ v.systolic ?? '—' }}/{{ v.diastolic ?? '—' }} mmHg</dd>
                    <dt class="text-ink-3">Nadi</dt><dd>{{ v.heartRate ?? '—' }} x/mnt</dd>
                    <dt class="text-ink-3">RR</dt><dd>{{ v.respRate ?? '—' }} x/mnt</dd>
                    <dt class="text-ink-3">Suhu</dt><dd>{{ v.temperature ?? '—' }} °C</dd>
                    <dt class="text-ink-3">SpO₂</dt><dd>{{ v.spo2 ?? '—' }} %</dd>
                    <dt class="text-ink-3">EWS</dt><dd><span class="badge" [class]="ewsTone(v.ews)">{{ v.ews ?? '—' }}</span></dd>
                  </dl>
                  <div class="muted mt-2">{{ v.createdAt | dt }}</div>
                } @else { <app-empty text="Belum diukur" /> }
              </div>
              <div class="card card-pad">
                <h3 class="h2 mb-2">Diagnosis</h3>
                @for (d of r.diagnoses; track d.id) { <div class="text-sm py-1"><span class="badge" [class]="d.rank === 'PRIMER' ? 'badge-info' : 'badge-neutral'">{{ d.rank }}</span> <b>{{ d.icd10Code }}</b> {{ d.display }}</div> }
                @empty { <app-empty text="Belum ada diagnosis" /> }
                <h3 class="h2 mt-4 mb-2">Keluhan utama</h3>
                <p class="text-sm">{{ e.chiefComplaint ?? '—' }}</p>
              </div>
              <div class="card card-pad">
                <h3 class="h2 mb-2">Order & resep</h3>
                @for (o of r.orders; track o.id) { <div class="text-sm py-0.5 flex justify-between gap-2"><span>{{ o.serviceName }} @if (o.priority === 'CITO') { <span class="badge badge-critical">CITO</span> }</span><app-status [value]="o.status" /></div> }
                @for (p of r.prescriptions; track p.id) { <div class="text-sm py-0.5 flex justify-between gap-2"><span>Resep {{ p.rxNo }} ({{ p.items.length }} item)</span><app-status [value]="p.status" /></div> }
                @if (!r.orders.length && !r.prescriptions.length) { <app-empty text="Belum ada order" /> }
              </div>
            </div>
          }

          @case ('catatan') {
            @if (active() && auth.can('clinical.write')) {
              <div class="card card-pad mb-4">
                <div class="flex flex-wrap gap-2 items-end mb-3">
                  <div class="field w-60"><label class="label">Jenis catatan</label>
                    <select class="input" [(ngModel)]="note.type">
                      @for (t of noteTypes(); track t) { <option [value]="t">{{ noteLabel[t] }}</option> }
                    </select></div>
                  <span class="muted">Catatan yang ditandatangani dikunci (hash SHA-256) — koreksi melalui amandemen.</span>
                </div>
                <div class="grid md:grid-cols-2 gap-3">
                  <div class="field"><label class="label">S — Subjektif</label><textarea class="input" rows="3" [(ngModel)]="note.subjective"></textarea></div>
                  <div class="field"><label class="label">O — Objektif</label><textarea class="input" rows="3" [(ngModel)]="note.objective"></textarea></div>
                  <div class="field"><label class="label">A — Asesmen</label><textarea class="input" rows="3" [(ngModel)]="note.assessment"></textarea></div>
                  <div class="field"><label class="label">P — Rencana</label><textarea class="input" rows="3" [(ngModel)]="note.plan"></textarea></div>
                  <div class="field md:col-span-2"><label class="label">Instruksi (PPA / edukasi)</label><textarea class="input" rows="2" [(ngModel)]="note.instruction"></textarea></div>
                </div>
                <div class="flex justify-end gap-2 mt-3">
                  <button class="btn" (click)="saveNote(false)">Simpan draf</button>
                  <button class="btn btn-primary" (click)="saveNote(true)">Simpan & tandatangani</button>
                </div>
              </div>
            }
            @for (n of r.notes; track n.id) {
              <div class="card card-pad mb-3" [class.border-l-4]="n.type === 'AMENDMENT'" [class.border-l-warning]="n.type === 'AMENDMENT'">
                <div class="flex flex-wrap justify-between gap-2 mb-2">
                  <div><b>{{ noteLabel[n.type] ?? n.type }}</b> · {{ n.authorName }} <span class="muted">({{ n.authorRole }})</span></div>
                  <div class="flex items-center gap-2"><span class="muted">{{ n.createdAt | dt }}</span><app-status [value]="n.status" /></div>
                </div>
                <div class="grid md:grid-cols-2 gap-x-6 gap-y-1 text-sm whitespace-pre-line">
                  @if (n.subjective) { <div><b>S:</b> {{ n.subjective }}</div> }
                  @if (n.objective) { <div><b>O:</b> {{ n.objective }}</div> }
                  @if (n.assessment) { <div><b>A:</b> {{ n.assessment }}</div> }
                  @if (n.plan) { <div><b>P:</b> {{ n.plan }}</div> }
                  @if (n.instruction) { <div class="md:col-span-2"><b>I:</b> {{ n.instruction }}</div> }
                </div>
                <div class="flex gap-2 mt-2">
                  @if (n.status === 'DRAFT' && n.authorId === auth.user()?.id) { <button class="btn btn-sm btn-primary" (click)="sign(n.id)">Tandatangani</button> }
                  @if (n.status === 'SIGNED' && n.type !== 'AMENDMENT' && auth.can('clinical.sign')) { <button class="btn btn-sm" (click)="startAmend(n)">Amandemen</button> }
                  @if (n.signatureHash) { <span class="muted self-center" title="Hash isi catatan">🔒 {{ n.signatureHash.slice(0, 12) }}…</span> }
                </div>
              </div>
            } @empty { <app-empty text="Belum ada catatan klinis" /> }
          }

          @case ('vital') {
            @if (active() && auth.can('clinical.write', 'triage.write')) {
              <form class="card card-pad mb-4 grid grid-cols-2 sm:grid-cols-5 gap-3 items-end" (ngSubmit)="saveVitals()">
                @for (f of vitalFields; track f.key) {
                  <div class="field"><label class="label">{{ f.label }}</label><input class="input" type="number" [name]="f.key" [(ngModel)]="vital[f.key]" [step]="f.step ?? 1" /></div>
                }
                <button class="btn btn-primary sm:col-span-5 justify-self-end">Simpan tanda vital</button>
              </form>
            }
            <div class="card overflow-x-auto">
              <table class="tbl">
                <thead><tr><th>Waktu</th><th class="num">TD</th><th class="num">Nadi</th><th class="num">RR</th><th class="num">Suhu</th><th class="num">SpO₂</th><th class="num">BB/TB</th><th class="num">Nyeri</th><th class="num">GCS</th><th>EWS</th></tr></thead>
                <tbody>
                  @for (v of r.vitals; track v.id) {
                    <tr><td>{{ v.createdAt | dt }}</td><td class="num">{{ v.systolic }}/{{ v.diastolic }}</td><td class="num">{{ v.heartRate }}</td><td class="num">{{ v.respRate }}</td><td class="num">{{ v.temperature }}</td><td class="num">{{ v.spo2 }}</td>
                      <td class="num">{{ v.weight }}/{{ v.height }}</td><td class="num">{{ v.painScore }}</td><td class="num">{{ v.gcs }}</td><td><span class="badge" [class]="ewsTone(v.ews)">{{ v.ews ?? '—' }}</span></td></tr>
                  } @empty { <tr><td colspan="10"><app-empty /></td></tr> }
                </tbody>
              </table>
            </div>
          }

          @case ('diagnosis') {
            <div class="grid lg:grid-cols-2 gap-4">
              <div class="card card-pad">
                <h3 class="h2 mb-2">Diagnosis (ICD-10)</h3>
                @for (d of r.diagnoses; track d.id) {
                  <div class="flex justify-between items-center py-1.5 border-b border-line text-sm">
                    <span><span class="badge" [class]="d.rank === 'PRIMER' ? 'badge-info' : 'badge-neutral'">{{ d.rank }}</span> <b>{{ d.icd10Code }}</b> {{ d.display }}</span>
                    @if (active() && auth.can('clinical.write')) { <button class="btn btn-sm btn-ghost" (click)="removeDx(d.id)">Hapus</button> }
                  </div>
                }
                @if (active() && auth.can('clinical.write')) {
                  <div class="mt-3 flex gap-2">
                    <input class="input" [(ngModel)]="dxQuery" (ngModelChange)="searchIcd10()" placeholder="Cari kode / nama penyakit…" />
                    <select class="input w-36" [(ngModel)]="dxRank"><option>PRIMER</option><option>SEKUNDER</option><option>KOMPLIKASI</option></select>
                  </div>
                  @for (c of icdResults(); track c.code) {
                    <button class="block w-full text-left text-sm px-2 py-1.5 hover:bg-primary-soft rounded" (click)="addDx(c.code)"><b>{{ c.code }}</b> {{ c.displayId ?? c.display }}</button>
                  }
                }
              </div>
              <div class="card card-pad">
                <h3 class="h2 mb-2">Tindakan (ICD-9-CM)</h3>
                @for (p of r.procedures; track p.id) { <div class="text-sm py-1.5 border-b border-line"><b>{{ p.icd9cmCode ?? '—' }}</b> {{ p.display }} <span class="muted">{{ p.performedAt | dt }}</span></div> }
                @if (active() && auth.can('clinical.write')) {
                  <div class="grid gap-2 mt-3">
                    <select class="input" [(ngModel)]="proc.serviceId" (ngModelChange)="onProcService()">
                      <option value="">— tindakan dari master tarif —</option>
                      @for (s of procedureServices(); track s.id) { <option [value]="s.id">{{ s.name }} @if (s.icd9cmCode) { ({{ s.icd9cmCode }}) }</option> }
                    </select>
                    <div class="flex gap-2"><input class="input w-32" [(ngModel)]="proc.icd9cmCode" placeholder="ICD-9-CM" /><input class="input" [(ngModel)]="proc.display" placeholder="Nama tindakan" /></div>
                    <input class="input" [(ngModel)]="proc.notes" placeholder="Catatan tindakan" />
                    <button class="btn btn-primary justify-self-end" (click)="addProcedure()">Catat tindakan</button>
                  </div>
                }
              </div>
            </div>
          }

          @case ('order') {
            @if (active() && auth.can('order.write')) {
              <div class="card card-pad mb-4">
                <h3 class="h2 mb-2">Order penunjang (CPOE)</h3>
                <div class="grid md:grid-cols-3 gap-3">
                  @for (cat of ['LAB', 'RADIOLOGI']; track cat) {
                    <div><div class="label">{{ cat === 'LAB' ? 'Laboratorium' : 'Radiologi' }}</div>
                      @for (s of servicesBy(cat); track s.id) {
                        <label class="flex items-center gap-2 text-sm py-0.5"><input type="checkbox" [checked]="cart().has(s.id)" (change)="toggleCart(s.id)" /> {{ s.name }}</label>
                      }
                    </div>
                  }
                  <div class="space-y-2">
                    <div class="field"><label class="label">Prioritas</label><select class="input" [(ngModel)]="orderPriority"><option>RUTIN</option><option>CITO</option></select></div>
                    <div class="field"><label class="label">Informasi klinis</label><textarea class="input" [(ngModel)]="orderInfo"></textarea></div>
                    <button class="btn btn-primary w-full" [disabled]="!cart().size" (click)="submitOrders()">Kirim {{ cart().size }} order</button>
                  </div>
                </div>
              </div>
            }
            <div class="card overflow-x-auto">
              <table class="tbl">
                <thead><tr><th>No. order</th><th>Pemeriksaan</th><th>Prioritas</th><th>Status</th><th>Hasil</th><th></th></tr></thead>
                <tbody>
                  @for (o of r.orders; track o.id) {
                    <tr>
                      <td>{{ o.orderNo }}<div class="muted">{{ o.createdAt | dt }}</div></td>
                      <td>{{ o.serviceName }}<div class="muted">{{ o.orderedByName }}</div></td>
                      <td>@if (o.priority === 'CITO') { <span class="badge badge-critical">CITO</span> } @else { Rutin }</td>
                      <td><app-status [value]="o.status" /></td>
                      <td class="text-sm">
                        @if (o.result; as res) {
                          @for (x of res.observations; track x.name) {
                            <div [class.text-critical]="x.flag === 'HH' || x.flag === 'LL'" [class.font-semibold]="x.flag && x.flag !== 'N'">{{ x.name }}: {{ x.value }} {{ x.unit }} @if (x.flag && x.flag !== 'N') { [{{ x.flag }}] } <span class="muted">{{ x.referenceRange }}</span></div>
                          }
                          @if (res.conclusion) { <div class="whitespace-pre-line">{{ res.conclusion }}</div> }
                          @if (res.isCritical && !res.criticalAckAt) { <div class="badge badge-critical mt-1">⚠ Nilai kritis — belum dikonfirmasi</div> }
                        } @else { — }
                      </td>
                      <td class="whitespace-nowrap">
                        @if (o.result?.isCritical && !o.result?.criticalAckAt) { <button class="btn btn-sm btn-danger" (click)="ackCritical(o.id)">Konfirmasi kritis</button> }
                        @if (o.status === 'ORDERED' && auth.can('order.write')) { <button class="btn btn-sm" (click)="cancelOrder(o.id)">Batal</button> }
                      </td>
                    </tr>
                  } @empty { <tr><td colspan="6"><app-empty text="Belum ada order" /></td></tr> }
                </tbody>
              </table>
            </div>
          }

          @case ('resep') {
            @if (active() && auth.can('rx.write')) {
              <div class="card card-pad mb-4">
                <h3 class="h2 mb-2">Resep elektronik</h3>
                <div class="flex gap-2 mb-2"><input class="input" [(ngModel)]="drugQuery" (ngModelChange)="searchDrug()" placeholder="Cari obat/BMHP (formularium)…" /></div>
                @for (d of drugResults(); track d.itemId) {
                  <button class="block w-full text-left text-sm px-2 py-1.5 hover:bg-primary-soft rounded" (click)="addRxItem(d)">
                    <b>{{ d.name }}</b> {{ d.genericName }} · stok {{ d.onHand | num }} {{ d.uom }}
                    @if (d.isHighAlert) { <span class="badge badge-critical">High-alert</span> } @if (d.isNarcotic) { <span class="badge badge-warning">Narkotika</span> } @if (!d.isFormulary) { <span class="badge badge-neutral">Non-Fornas</span> }
                  </button>
                }
                @if (rxItems().length) {
                  <table class="tbl mt-3">
                    <thead><tr><th>Obat</th><th>Jumlah</th><th>Dosis</th><th>Frekuensi</th><th>Rute</th><th>Hari</th><th>Aturan pakai</th><th></th></tr></thead>
                    <tbody>
                      @for (it of rxItems(); track it.itemId; let i = $index) {
                        <tr>
                          <td class="font-medium">{{ it.name }}</td>
                          <td><input class="input w-20" type="number" [(ngModel)]="it.quantity" /></td>
                          <td><input class="input w-24" [(ngModel)]="it.dose" /></td>
                          <td><input class="input w-28" [(ngModel)]="it.frequency" /></td>
                          <td><select class="input w-28" [(ngModel)]="it.route">@for (r of routes; track r) {<option>{{ r }}</option>}</select></td>
                          <td><input class="input w-16" type="number" [(ngModel)]="it.durationDays" /></td>
                          <td><input class="input" [(ngModel)]="it.instructions" /></td>
                          <td><button class="btn btn-sm btn-ghost" (click)="removeRxItem(i)">✕</button></td>
                        </tr>
                      }
                    </tbody>
                  </table>
                  @for (a of rxAlerts(); track a.message) {
                    <div class="alert mt-2" [class.alert-critical]="a.severity === 'BLOCK'" [class.alert-warning]="a.severity === 'WARNING'" [class.alert-info]="a.severity === 'INFO'">
                      <b>{{ a.type }}</b> — {{ a.message }}
                    </div>
                  }
                  @if (hasBlock()) {
                    <div class="field mt-2"><label class="label">Alasan klinis override (wajib, tercatat)</label><input class="input" [(ngModel)]="overrideReason" /></div>
                  }
                  <div class="flex justify-end gap-2 mt-3">
                    <button class="btn" (click)="checkRx()">Cek keamanan</button>
                    <button class="btn btn-primary" (click)="submitRx()">Kirim ke farmasi</button>
                  </div>
                }
              </div>
            }
            @for (p of r.prescriptions; track p.id) {
              <div class="card card-pad mb-3">
                <div class="flex justify-between mb-2"><b>{{ p.rxNo }} · {{ p.prescriberName }}</b><div class="flex gap-2 items-center"><span class="muted">{{ p.createdAt | dt }}</span><app-status [value]="p.status" /></div></div>
                @for (i of p.items; track i.id) { <div class="text-sm">• {{ i.itemName }} — {{ i.quantity | num }} · {{ i.dose }} {{ i.frequency }} {{ i.route }} @if (i.instructions) { ({{ i.instructions }}) }</div> }
                @if (p.overrideReason) { <div class="alert alert-warning mt-2 text-xs">Override: {{ p.overrideReason }}</div> }
                @if (p.reviewNotes) { <div class="muted mt-1">Telaah farmasi: {{ p.reviewNotes }}</div> }
              </div>
            } @empty { <app-empty text="Belum ada resep" /> }
          }

          @case ('emar') {
            <div class="card overflow-x-auto mb-4">
              <table class="tbl">
                <thead><tr><th>Obat</th><th>Aturan</th><th>Riwayat pemberian</th><th></th></tr></thead>
                <tbody>
                  @for (m of mar(); track m.line.id) {
                    <tr>
                      <td><b>{{ m.line.itemName }}</b> @if (m.isHighAlert) { <span class="badge badge-critical">High-alert</span> }<div class="muted">{{ m.rxNo }}</div></td>
                      <td>{{ m.line.dose }} · {{ m.line.frequency }} · {{ m.line.route }}</td>
                      <td class="text-xs">@for (a of m.administrations; track a.admin.id) { <div>{{ a.admin.administeredAt | dt }} — <b>{{ a.admin.status }}</b> {{ a.admin.doseGiven }} ({{ a.nurse }})</div> } @empty { — }</td>
                      <td>@if (active() && auth.can('emar.write')) { <button class="btn btn-sm btn-primary" (click)="openMar(m)">Catat pemberian</button> }</td>
                    </tr>
                  } @empty { <tr><td colspan="4"><app-empty text="Belum ada obat yang diserahkan farmasi" /></td></tr> }
                </tbody>
              </table>
            </div>
          }
        }
      }
    }

    @if (modal() === 'discharge') {
      <app-modal title="Pemulangan / selesai pelayanan" [width]="520" (closed)="modal.set('')">
        <p class="text-sm mb-3">Syarat: diagnosis utama terisi{{ enc()?.type === 'RAWAT_INAP' ? ' dan resume medis ditandatangani DPJP' : '' }}. Biaya akomodasi dihitung otomatis.</p>
        <div class="field mb-2"><label class="label">Cara pulang</label>
          <select class="input" [(ngModel)]="disposition"><option value="PULANG">Pulang (sembuh/membaik)</option><option value="KONTROL">Kontrol ulang</option><option value="RUJUK">Dirujuk</option><option value="APS">Atas permintaan sendiri</option><option value="MENINGGAL">Meninggal</option></select></div>
        @if (pendingOrders().length) {
          <div class="alert alert-warning mb-2">Order belum selesai: @for (o of pendingOrders(); track o.orderNo) { {{ o.serviceName }}@if (!$last) {, } }</div>
          <label class="text-sm flex gap-2"><input type="checkbox" [(ngModel)]="ackPending" /> Saya mengetahui order tersebut belum selesai</label>
        }
        <div class="flex justify-end mt-3"><button class="btn btn-success" (click)="discharge()">Konfirmasi</button></div>
      </app-modal>
    }
    @if (modal() === 'triage') {
      <app-modal title="Triase IGD" [width]="520" (closed)="modal.set('')">
        <div class="grid gap-2 mb-3">
          @for (l of [1, 2, 3, 4, 5]; track l) {
            <label class="flex items-center gap-2 text-sm card px-3 py-2 cursor-pointer" [class.border-primary]="triage.level === l"><input type="radio" name="lvl" [value]="l" [(ngModel)]="triage.level" /> {{ triageLabel[l].label }}</label>
          }
        </div>
        <div class="field mb-2"><label class="label">Keluhan</label><input class="input" [(ngModel)]="triage.complaint" /></div>
        <div class="field"><label class="label">Catatan</label><textarea class="input" [(ngModel)]="triage.notes"></textarea></div>
        <div class="flex justify-end mt-3"><button class="btn btn-primary" (click)="saveTriage()">Simpan triase</button></div>
      </app-modal>
    }
    @if (modal() === 'transfer') {
      <app-modal title="Pindah tempat tidur" [width]="640" (closed)="modal.set('')">
        <div class="grid grid-cols-2 sm:grid-cols-3 gap-2">
          @for (b of freeBeds(); track b.bedId) {
            <button class="card px-3 py-2 text-left text-sm hover:border-primary" (click)="transfer(b.bedId)"><b>{{ b.bedCode }}</b><div class="muted">{{ b.unitName }} · {{ b.roomName }} · {{ b.careClass }}</div></button>
          } @empty { <app-empty text="Tidak ada bed tersedia" /> }
        </div>
      </app-modal>
    }
    @if (modal() === 'cancel') {
      <app-modal title="Batalkan kunjungan" [width]="480" (closed)="modal.set('')">
        <div class="field"><label class="label">Alasan pembatalan</label><textarea class="input" [(ngModel)]="cancelReason"></textarea></div>
        <div class="flex justify-end mt-3"><button class="btn btn-danger" [disabled]="cancelReason.length < 5" (click)="cancelEncounter()">Batalkan</button></div>
      </app-modal>
    }
    @if (modal() === 'amend') {
      <app-modal title="Amandemen catatan" [width]="720" (closed)="modal.set('')">
        <p class="muted mb-2">Catatan asli tetap tersimpan. Amandemen ditandatangani dan merujuk catatan asli.</p>
        <div class="grid md:grid-cols-2 gap-3">
          <div class="field"><label class="label">S</label><textarea class="input" [(ngModel)]="amend.subjective"></textarea></div>
          <div class="field"><label class="label">O</label><textarea class="input" [(ngModel)]="amend.objective"></textarea></div>
          <div class="field"><label class="label">A</label><textarea class="input" [(ngModel)]="amend.assessment"></textarea></div>
          <div class="field"><label class="label">P</label><textarea class="input" [(ngModel)]="amend.plan"></textarea></div>
          <div class="field md:col-span-2"><label class="label">Alasan amandemen (wajib)</label><input class="input" [(ngModel)]="amend.reason" /></div>
        </div>
        <div class="flex justify-end mt-3"><button class="btn btn-primary" [disabled]="amend.reason.length < 10" (click)="saveAmend()">Tandatangani amandemen</button></div>
      </app-modal>
    }
    @if (modal() === 'mar' && marTarget(); as m) {
      <app-modal title="Pemberian obat — {{ m.line.itemName }}" [width]="520" (closed)="modal.set('')">
        <div class="alert alert-info mb-3 text-sm">Prinsip 6 benar: pasien, obat, dosis, rute, waktu, dokumentasi. Verifikasi identitas: <b>{{ enc()?.patient?.name }}</b>, RM <b>{{ enc()?.patient?.mrn }}</b>, lahir {{ enc()?.patient?.birthDate | d }}.</div>
        <label class="flex gap-2 text-sm mb-3"><input type="checkbox" [(ngModel)]="marForm.twoIdentifiersVerified" /> Dua identitas pasien sudah diverifikasi (gelang identitas)</label>
        <div class="grid grid-cols-2 gap-3">
          <div class="field"><label class="label">Status</label><select class="input" [(ngModel)]="marForm.status"><option value="GIVEN">Diberikan</option><option value="HELD">Ditunda</option><option value="REFUSED">Ditolak pasien</option></select></div>
          <div class="field"><label class="label">Dosis diberikan</label><input class="input" [(ngModel)]="marForm.doseGiven" /></div>
          @if (m.isHighAlert) {
            <div class="field col-span-2"><label class="label">Double check oleh (wajib untuk high-alert)</label>
              <select class="input" [(ngModel)]="marForm.doubleCheckedBy"><option value="">— pilih petugas —</option>@for (s of staff(); track s.id) { @if (s.id !== auth.user()?.id) { <option [value]="s.id">{{ s.fullName }}</option> } }</select></div>
          }
          <div class="field col-span-2"><label class="label">Catatan</label><input class="input" [(ngModel)]="marForm.notes" /></div>
        </div>
        <div class="flex justify-end mt-3"><button class="btn btn-primary" [disabled]="!marForm.twoIdentifiersVerified" (click)="saveMar()">Simpan</button></div>
      </app-modal>
    }
  `,
})
export class WorkspacePage implements OnInit {
  readonly auth = inject(AuthService);
  private readonly api = inject(Api);
  private readonly toasts = inject(Toasts);
  private readonly router = inject(Router);
  readonly id = input.required<string>();
  readonly types = ENCOUNTER_TYPE;
  readonly noteLabel = NOTE_LABEL;
  readonly triageLabel = TRIAGE;
  readonly routes = ['ORAL', 'IV', 'IM', 'SC', 'TOPIKAL', 'INHALASI', 'SUBLINGUAL', 'REKTAL', 'TETES_MATA', 'TETES_TELINGA', 'LAINNYA'];

  readonly enc = signal<any>(null);
  readonly rec = signal<any>(null);
  readonly accessDenied = signal('');
  readonly tab = signal('ringkasan');
  readonly modal = signal('');
  readonly services = signal<any[]>([]);
  readonly icdResults = signal<any[]>([]);
  readonly drugResults = signal<any[]>([]);
  readonly rxItems = signal<any[]>([]);
  readonly rxAlerts = signal<any[]>([]);
  readonly cart = signal(new Set<string>());
  readonly mar = signal<any[]>([]);
  readonly marTarget = signal<any>(null);
  readonly staff = signal<any[]>([]);
  readonly freeBeds = signal<any[]>([]);
  readonly pendingOrders = computed(() => (this.rec()?.orders ?? []).filter((o: any) => o.status === 'ORDERED' || o.status === 'IN_PROGRESS'));
  readonly active = computed(() => ['REGISTERED', 'TRIAGED', 'IN_PROGRESS'].includes(this.enc()?.status));
  readonly hasBlock = computed(() => this.rxAlerts().some((a) => a.severity === 'BLOCK'));
  readonly visibleTabs = computed(() =>
    [
      { key: 'ringkasan', label: 'Ringkasan' },
      { key: 'catatan', label: 'CPPT / SOAP' },
      { key: 'vital', label: 'Tanda vital' },
      { key: 'diagnosis', label: 'Diagnosis & tindakan' },
      { key: 'order', label: 'Order penunjang' },
      { key: 'resep', label: 'Resep' },
      ...(this.enc()?.type !== 'RAWAT_JALAN' ? [{ key: 'emar', label: 'eMAR' }] : []),
    ],
  );
  readonly noteTypes = computed(() =>
    this.auth.hasRole('DOKTER', 'ADMIN') ? ['SOAP', 'CPPT', 'ASESMEN_AWAL_MEDIS', 'RESUME_MEDIS'] : ['CPPT', 'ASESMEN_KEPERAWATAN', 'SOAP'],
  );
  readonly procedureServices = computed(() => this.services().filter((s) => s.category === 'TINDAKAN' || s.category === 'OPERASI'));

  note: any = {};
  amend: any = { reason: '' };
  amendTarget = '';
  vital: any = {};
  readonly vitalFields: { key: string; label: string; step?: number }[] = [
    { key: 'systolic', label: 'Sistolik (mmHg)' },
    { key: 'diastolic', label: 'Diastolik (mmHg)' },
    { key: 'heartRate', label: 'Nadi (x/mnt)' },
    { key: 'respRate', label: 'RR (x/mnt)' },
    { key: 'temperature', label: 'Suhu (°C)', step: 0.1 },
    { key: 'spo2', label: 'SpO₂ (%)' },
    { key: 'weight', label: 'BB (kg)', step: 0.1 },
    { key: 'height', label: 'TB (cm)', step: 0.1 },
    { key: 'painScore', label: 'Skala nyeri 0–10' },
    { key: 'gcs', label: 'GCS (3–15)' },
  ];
  dxQuery = '';
  dxRank = 'PRIMER';
  proc: any = { serviceId: '', icd9cmCode: '', display: '', notes: '' };
  orderPriority = 'RUTIN';
  orderInfo = '';
  drugQuery = '';
  overrideReason = '';
  disposition = 'PULANG';
  ackPending = false;
  triage: any = { level: 3, complaint: '', notes: '' };
  cancelReason = '';
  bgReason = '';
  private deniedPatientId = '';
  marForm: any = {};

  async ngOnInit() {
    this.resetNote();
    await this.load();
    this.services.set(await this.api.get('/master/services').catch(() => []));
  }

  private resetNote() {
    this.note = { type: this.noteTypes()[0], subjective: '', objective: '', assessment: '', plan: '', instruction: '' };
  }

  async load() {
    try {
      const e = await this.api.get(`/encounters/${this.id()}`);
      this.enc.set(e);
      this.accessDenied.set('');
      if (this.auth.can('clinical.read')) this.rec.set(await this.api.get(`/clinical/encounters/${this.id()}/record`));
      else this.rec.set({ notes: [], vitals: [], diagnoses: [], procedures: [], orders: [], prescriptions: [] });
      if (e.type !== 'RAWAT_JALAN' && this.auth.can('emar.write', 'clinical.read')) this.mar.set(await this.api.get(`/pharmacy/encounters/${this.id()}/mar`));
    } catch (err) {
      if (err instanceof ApiError && err.code === 'CARE_RELATIONSHIP_REQUIRED') {
        this.accessDenied.set(err.message);
        this.deniedPatientId = err.details?.patientId;
      }
      else this.toasts.error(err);
    }
  }

  private async run(fn: () => Promise<unknown>, ok?: string) {
    try {
      await fn();
      if (ok) this.toasts.success(ok);
      await this.load();
      return true;
    } catch (e) {
      this.toasts.error(e);
      return false;
    }
  }

  ewsTone(v: number | null) {
    return v === null || v === undefined ? 'badge-neutral' : v >= 7 ? 'badge-critical' : v >= 5 ? 'badge-warning' : 'badge-success';
  }

  async breakGlass() {
    try {
      await this.api.post('/auth/break-glass', { patientId: this.deniedPatientId, reason: this.bgReason });
      this.toasts.show('warning', 'Akses darurat aktif dan tercatat');
      await this.load();
    } catch (e) {
      this.toasts.error(e);
    }
  }

  act(kind: 'start' | 'sep') {
    return this.run(() => this.api.post(`/encounters/${this.id()}/${kind}`), kind === 'sep' ? 'SEP diterbitkan' : 'Pemeriksaan dimulai');
  }

  async saveNote(signNow: boolean) {
    const ok = await this.run(() => this.api.post(`/clinical/encounters/${this.id()}/notes`, { ...cleanPayload(this.note), signNow }), signNow ? 'Catatan ditandatangani' : 'Draf tersimpan');
    if (ok) this.resetNote();
  }

  sign(noteId: string) {
    return this.run(() => this.api.post(`/clinical/notes/${noteId}/sign`), 'Catatan ditandatangani');
  }

  startAmend(n: any) {
    this.amendTarget = n.id;
    this.amend = { subjective: n.subjective ?? '', objective: n.objective ?? '', assessment: n.assessment ?? '', plan: n.plan ?? '', reason: '' };
    this.modal.set('amend');
  }

  async saveAmend() {
    if (await this.run(() => this.api.post(`/clinical/notes/${this.amendTarget}/amend`, cleanPayload(this.amend)), 'Amandemen tersimpan')) this.modal.set('');
  }

  async saveVitals() {
    const body = Object.fromEntries(Object.entries(this.vital).filter(([, v]) => v !== null && v !== '' && v !== undefined));
    try {
      const v = await this.api.post(`/clinical/encounters/${this.id()}/vitals`, body);
      if (v.alert) this.toasts.show(v.alert.level === 'MERAH' ? 'error' : 'warning', v.alert.message, 10000);
      else this.toasts.success('Tanda vital tersimpan');
      this.vital = {};
      await this.load();
    } catch (e) {
      this.toasts.error(e);
    }
  }

  async searchIcd10() {
    if (this.dxQuery.length < 2) return this.icdResults.set([]);
    this.icdResults.set(await this.api.get('/master/icd10', { q: this.dxQuery }));
  }

  async addDx(code: string) {
    if (await this.run(() => this.api.post(`/clinical/encounters/${this.id()}/diagnoses`, { icd10Code: code, rank: this.dxRank }), 'Diagnosis ditambahkan')) {
      this.dxQuery = '';
      this.icdResults.set([]);
      if (this.dxRank === 'PRIMER') this.dxRank = 'SEKUNDER';
    }
  }

  removeDx(id: string) {
    return this.run(() => this.api.post(`/clinical/encounters/${this.id()}/diagnoses/${id}/remove`));
  }

  onProcService() {
    const s = this.services().find((x) => x.id === this.proc.serviceId);
    if (s) {
      this.proc.icd9cmCode = s.icd9cmCode ?? '';
      this.proc.display = s.name;
    }
  }

  async addProcedure() {
    if (await this.run(() => this.api.post(`/clinical/encounters/${this.id()}/procedures`, cleanPayload(this.proc)), 'Tindakan tercatat')) {
      this.proc = { serviceId: '', icd9cmCode: '', display: '', notes: '' };
    }
  }

  servicesBy(cat: string) {
    return this.services().filter((s) => s.category === cat && s.active);
  }

  toggleCart(id: string) {
    const s = new Set(this.cart());
    if (s.has(id)) s.delete(id);
    else s.add(id);
    this.cart.set(s);
  }

  async submitOrders() {
    const items = [...this.cart()].map((serviceId) => ({ serviceId, priority: this.orderPriority, clinicalInfo: this.orderInfo || undefined }));
    if (await this.run(() => this.api.post('/orders', { encounterId: this.id(), items }), `${items.length} order terkirim`)) {
      this.cart.set(new Set());
      this.orderInfo = '';
    }
  }

  ackCritical(orderId: string) {
    return this.run(() => this.api.post(`/orders/${orderId}/acknowledge-critical`), 'Nilai kritis dikonfirmasi');
  }

  async cancelOrder(orderId: string) {
    const reason = prompt('Alasan pembatalan order:');
    if (reason && reason.length >= 5) await this.run(() => this.api.post(`/orders/${orderId}/cancel`, { reason }), 'Order dibatalkan');
  }

  async searchDrug() {
    if (this.drugQuery.length < 2) return this.drugResults.set([]);
    this.drugResults.set(await this.api.get('/inventory/stock', { q: this.drugQuery }));
  }

  addRxItem(d: any) {
    if (this.rxItems().some((x) => x.itemId === d.itemId)) return;
    this.rxItems.update((xs) => [...xs, { itemId: d.itemId, name: `${d.name}`, quantity: 10, dose: '', frequency: '3x sehari', route: 'ORAL', durationDays: 3, instructions: '' }]);
    this.drugQuery = '';
    this.drugResults.set([]);
    void this.checkRx();
  }

  removeRxItem(i: number) {
    this.rxItems.update((xs) => xs.filter((_, idx) => idx !== i));
    void this.checkRx();
  }

  async checkRx() {
    if (!this.rxItems().length) return this.rxAlerts.set([]);
    try {
      const r = await this.api.post('/pharmacy/prescriptions/check', { encounterId: this.id(), items: this.rxItems().map((i) => ({ itemId: i.itemId })) });
      this.rxAlerts.set(r.alerts);
    } catch (e) {
      this.toasts.error(e);
    }
  }

  async submitRx() {
    const items = this.rxItems().map(({ name: _n, ...i }) => ({ ...cleanPayload(i), quantity: Number(i.quantity), durationDays: i.durationDays ? Number(i.durationDays) : undefined }));
    if (items.some((i: any) => !i.dose)) return this.toasts.show('warning', 'Dosis wajib diisi untuk setiap obat');
    try {
      await this.api.post('/pharmacy/prescriptions', { encounterId: this.id(), items, overrideReason: this.overrideReason || undefined });
      this.toasts.success('Resep terkirim ke farmasi');
      this.rxItems.set([]);
      this.rxAlerts.set([]);
      this.overrideReason = '';
      await this.load();
    } catch (e) {
      if (e instanceof ApiError && e.details?.alerts) this.rxAlerts.set(e.details.alerts);
      this.toasts.error(e);
    }
  }

  async openMar(m: any) {
    this.marTarget.set(m);
    this.marForm = { prescriptionItemId: m.line.id, status: 'GIVEN', doseGiven: m.line.dose, notes: '', twoIdentifiersVerified: false, doubleCheckedBy: '' };
    if (m.isHighAlert && !this.staff().length) this.staff.set(await this.api.get('/pharmacy/staff'));
    this.modal.set('mar');
  }

  async saveMar() {
    if (await this.run(() => this.api.post('/pharmacy/mar', cleanPayload(this.marForm)), 'Pemberian obat tercatat')) this.modal.set('');
  }

  async discharge() {
    if (await this.run(() => this.api.post(`/encounters/${this.id()}/discharge`, { disposition: this.disposition, acknowledgePendingOrders: this.ackPending }), 'Pelayanan selesai')) this.modal.set('');
  }

  async saveTriage() {
    if (await this.run(() => this.api.post(`/encounters/${this.id()}/triage`, cleanPayload(this.triage)), 'Triase tersimpan')) this.modal.set('');
  }

  async openTransfer() {
    this.freeBeds.set((await this.api.get<any[]>('/master/bed-board')).filter((b) => b.status === 'AVAILABLE'));
    this.modal.set('transfer');
  }

  async transfer(bedId: string) {
    if (await this.run(() => this.api.post(`/encounters/${this.id()}/transfer-bed`, { bedId }), 'Pasien dipindahkan')) this.modal.set('');
  }

  async cancelEncounter() {
    if (await this.run(() => this.api.post(`/encounters/${this.id()}/cancel`, { reason: this.cancelReason }), 'Kunjungan dibatalkan')) {
      this.modal.set('');
      await this.router.navigate(['/encounters']);
    }
  }
}
