import { Component, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Api, AuthService } from '../core/api';
import { ENCOUNTER_TYPE, PIPES, Toasts } from '../core/ui';
import { SHARED } from '../shared/components';

@Component({
  selector: 'app-claims',
  imports: [FormsModule, ...SHARED, ...PIPES],
  template: `
    <app-page-header title="Klaim Penjamin" subtitle="BPJS (INA-CBG via E-Klaim) & asuransi: coding → pengajuan → verifikasi → pembayaran & rekonsiliasi piutang." />
    @if (stats(); as st) {
      <div class="flex flex-wrap gap-2 mb-4">
        @for (b of st.byStatus; track b.status) { <span class="badge badge-neutral"><app-status [value]="b.status" /> {{ b.count }} · {{ b.claimed | rp }}</span> }
        <span class="badge" [class]="st.rejectionRate > 5 ? 'badge-critical' : 'badge-success'">Rasio penolakan {{ st.rejectionRate | num }}%</span>
      </div>
    }
    <div class="tabs mb-4">
      <button class="tab" [class.tab-active]="tab() === 'ready'" (click)="select('ready')">Siap diklaim</button>
      <button class="tab" [class.tab-active]="tab() === 'list'" (click)="select('list')">Daftar klaim</button>
    </div>

    @if (tab() === 'ready') {
      <div class="card overflow-x-auto">
        <table class="tbl">
          <thead><tr><th>Kunjungan</th><th>Pasien</th><th>Penjamin</th><th>SEP</th><th>Pulang</th><th class="num">Tarif RS</th><th></th></tr></thead>
          <tbody>
            @for (r of ready(); track r.encounterId) {
              <tr><td>{{ r.encounterNo }}<div class="muted">{{ types[r.type] }}</div></td><td><b>{{ r.patientName }}</b><div class="muted">RM {{ r.mrn | mrn }}</div></td>
                <td>{{ r.payerName }}</td><td>{{ r.sepNumber ?? '—' }}</td><td>{{ r.endAt | dt }}</td><td class="num">{{ r.invoiceTotal | rp }}</td>
                <td>@if (auth.can('claim.write')) { <button class="btn btn-sm btn-primary" (click)="create(r.encounterId)">Buat klaim</button> }</td></tr>
            } @empty { <tr><td colspan="7"><app-empty text="Tidak ada kunjungan yang siap diklaim" /></td></tr> }
          </tbody>
        </table>
      </div>
    } @else {
      <div class="flex gap-2 mb-3"><select class="input w-48" [(ngModel)]="status" (ngModelChange)="load()"><option value="">Semua</option>@for (s of statuses; track s) {<option [value]="s">{{ s }}</option>}</select></div>
      <div class="card overflow-x-auto">
        <table class="tbl">
          <thead><tr><th>No. klaim</th><th>Pasien</th><th>Penjamin</th><th>INA-CBG</th><th class="num">Tarif RS</th><th class="num">Diklaim</th><th class="num">Disetujui</th><th>Status</th><th></th></tr></thead>
          <tbody>
            @for (c of rows(); track c.claim.id) {
              <tr><td>{{ c.claim.claimNo }}<div class="muted">v{{ c.claim.version }} · {{ c.encounterNo }}</div></td><td><b>{{ c.patientName }}</b><div class="muted">RM {{ c.mrn | mrn }}</div></td>
                <td>{{ c.payerName }}</td><td>{{ c.claim.inacbgCode ?? '—' }}</td><td class="num">{{ c.claim.hospitalTariff | rp }}</td><td class="num">{{ c.claim.claimedAmount | rp }}</td><td class="num">{{ c.claim.approvedAmount | rp }}</td>
                <td><app-status [value]="c.claim.status" /></td><td><button class="btn btn-sm" (click)="open(c)">Proses</button></td></tr>
            } @empty { <tr><td colspan="9"><app-empty /></td></tr> }
          </tbody>
        </table>
      </div>
    }

    @if (detail(); as d) {
      <app-modal [title]="'Klaim ' + d.claimNo" [width]="820" (closed)="detail.set(null)">
        <div class="grid md:grid-cols-2 gap-4 mb-4 text-sm">
          <div>
            <div class="muted">Diagnosis</div>
            @for (x of d.diagnoses; track x.id) { <div><span class="badge badge-info">{{ x.rank }}</span> {{ x.icd10Code }} {{ x.display }}</div> } @empty { <div class="text-critical">Belum ada diagnosis</div> }
            <div class="muted mt-2">Tindakan</div>
            @for (x of d.procedures; track x.id) { <div>{{ x.icd9cmCode }} {{ x.display }}</div> } @empty { — }
          </div>
          <div>
            <div class="muted">Riwayat status</div>
            @for (ev of d.events; track ev.id) { <div>{{ ev.createdAt | dt }} — <b>{{ ev.toStatus }}</b> {{ ev.note }}</div> }
          </div>
        </div>
        <div class="flex flex-wrap gap-3 items-end">
          @if (d.status === 'DRAFT' || d.status === 'CODED') {
            <div class="field"><label class="label">Kode INA-CBG</label><input class="input w-36" [(ngModel)]="code.inacbgCode" /></div>
            <div class="field"><label class="label">Tarif INA-CBG</label><input class="input w-40" type="number" [(ngModel)]="code.inacbgTariff" /></div>
            <button class="btn" (click)="act('code', code)">Simpan coding</button>
          }
          @if (d.status === 'CODED') { <button class="btn btn-primary" (click)="act('submit')">Ajukan ke penjamin</button> }
          @if (d.status === 'SUBMITTED') {
            <div class="field"><label class="label">Jumlah disetujui</label><input class="input w-40" type="number" [(ngModel)]="decision.approvedAmount" /></div>
            <div class="field"><label class="label">Catatan verifikator</label><input class="input w-60" [(ngModel)]="decision.note" /></div>
            <button class="btn btn-success" (click)="act('decision', { ...decision, status: 'APPROVED' })">Disetujui</button>
            <button class="btn" (click)="act('decision', { ...decision, status: 'PENDING' })">Pending</button>
            <button class="btn btn-danger" (click)="act('decision', { ...decision, status: 'REJECTED' })">Ditolak</button>
          }
          @if (d.status === 'PENDING' || d.status === 'REJECTED') {
            <div class="field"><label class="label">Catatan revisi / banding</label><input class="input w-80" [(ngModel)]="reviseNote" /></div>
            <button class="btn btn-primary" (click)="act('revise', { note: reviseNote })">Revisi klaim</button>
          }
          @if (d.status === 'APPROVED' && auth.can('finance.write')) {
            <div class="field"><label class="label">Dana diterima</label><input class="input w-40" type="number" [(ngModel)]="payment.amount" /></div>
            <div class="field"><label class="label">Referensi transfer</label><input class="input w-48" [(ngModel)]="payment.reference" /></div>
            <button class="btn btn-success" (click)="act('payment', payment)">Catat pembayaran</button>
          }
        </div>
      </app-modal>
    }
  `,
})
export class ClaimsPage implements OnInit {
  readonly auth = inject(AuthService);
  private readonly api = inject(Api);
  private readonly toasts = inject(Toasts);
  readonly types = ENCOUNTER_TYPE;
  readonly statuses = ['DRAFT', 'CODED', 'SUBMITTED', 'PENDING', 'APPROVED', 'REJECTED', 'PAID'];
  readonly tab = signal('ready');
  readonly ready = signal<any[]>([]);
  readonly rows = signal<any[]>([]);
  readonly stats = signal<any>(null);
  readonly detail = signal<any>(null);
  status = '';
  code: any = {};
  decision: any = { note: '' };
  payment: any = {};
  reviseNote = '';

  async ngOnInit() {
    await this.select('ready');
  }

  async select(t: string) {
    this.tab.set(t);
    this.stats.set(await this.api.get('/claims/stats'));
    if (t === 'ready') this.ready.set(await this.api.get('/claims/ready'));
    else await this.load();
  }

  async load() {
    this.rows.set(await this.api.get('/claims', { status: this.status }));
  }

  async create(encounterId: string) {
    try {
      const c = await this.api.post('/claims', { encounterId });
      this.toasts.success(`Klaim ${c.claimNo} dibuat`);
      await this.select('list');
      await this.open({ claim: c });
    } catch (e) {
      this.toasts.error(e);
    }
  }

  async open(c: any) {
    const d = await this.api.get(`/claims/${c.claim.id}`);
    this.code = { inacbgCode: d.inacbgCode ?? '', inacbgTariff: d.inacbgTariff ?? undefined };
    this.decision = { approvedAmount: d.claimedAmount, note: '' };
    this.payment = { amount: d.approvedAmount ?? d.claimedAmount, reference: '' };
    this.detail.set(d);
  }

  async act(action: string, body: any = {}) {
    try {
      const clean = Object.fromEntries(Object.entries(body).filter(([, v]) => v !== '' && v !== undefined && v !== null).map(([k, v]) => [k, ['inacbgTariff', 'approvedAmount', 'amount'].includes(k) ? Number(v) : v]));
      const r = await this.api.post(`/claims/${this.detail().id}/${action}`, clean);
      if (action === 'payment') this.toasts.success(`Klaim lunas; selisih tarif ${r.variance}`);
      else this.toasts.success('Klaim diperbarui');
      await this.open({ claim: { id: this.detail().id } });
      await this.select(this.tab());
    } catch (e) {
      this.toasts.error(e);
    }
  }
}
