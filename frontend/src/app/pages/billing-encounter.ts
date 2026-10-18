import { Component, computed, inject, input, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Api, AuthService } from '../core/api';
import { ENCOUNTER_TYPE, PIPES, Toasts } from '../core/ui';
import { SHARED } from '../shared/components';

const SOURCE_LABEL: Record<string, string> = {
  ADMIN: 'Administrasi',
  CONSULT: 'Jasa pemeriksaan',
  VISIT: 'Visite',
  ORDER: 'Penunjang',
  PROCEDURE: 'Tindakan',
  DISPENSE: 'Obat/BMHP',
  BED: 'Akomodasi',
  MANUAL: 'Manual',
};

@Component({
  selector: 'app-billing-encounter',
  imports: [FormsModule, RouterLink, ...SHARED, ...PIPES],
  template: `
    @if (s(); as s) {
      <app-page-header [title]="'Billing ' + s.encounter.encounterNo" [subtitle]="s.patient.name + ' · RM ' + s.patient.mrn + ' · ' + types[s.encounter.type] + ' · ' + s.payer.name">
        <a class="btn" [routerLink]="['/encounters', s.encounter.id]">Kunjungan</a>
      </app-page-header>

      <div class="grid sm:grid-cols-4 gap-3 mb-4">
        <div class="card card-pad"><div class="muted">Total layanan</div><div class="text-lg font-semibold">{{ s.totals.all | rp }}</div></div>
        <div class="card card-pad"><div class="muted">Tanggungan pasien</div><div class="text-lg font-semibold">{{ s.totals.patient | rp }}</div></div>
        <div class="card card-pad"><div class="muted">Tanggungan penjamin</div><div class="text-lg font-semibold">{{ s.totals.payer | rp }}</div></div>
        <div class="card card-pad"><div class="muted">Belum ditagih</div><div class="text-lg font-semibold text-warning">{{ s.totals.uninvoiced | rp }}</div></div>
      </div>

      <div class="card mb-4 overflow-x-auto">
        <div class="px-4 py-3 border-b border-line flex flex-wrap gap-2 justify-between items-center">
          <h3 class="h2">Rincian layanan (charge)</h3>
          <div class="flex gap-2">
            @if (auth.can('billing.write')) {
              <button class="btn" (click)="addOpen.set(true)">+ Charge manual</button>
              <button class="btn btn-primary" [disabled]="!s.totals.uninvoiced" (click)="generate()">Terbitkan invoice</button>
            }
          </div>
        </div>
        @if (s.encounter.type === 'RAWAT_INAP' && s.encounter.status !== 'FINISHED') {
          <div class="alert alert-info m-3">Pasien masih dirawat — invoice rawat inap diterbitkan setelah pulang (hari rawat final).</div>
        }
        <table class="tbl">
          <thead><tr><th>Waktu</th><th>Kelompok</th><th>Uraian</th><th class="num">Qty</th><th class="num">Tarif</th><th class="num">Jumlah</th><th>Ditanggung</th><th>Status</th><th></th></tr></thead>
          <tbody>
            @for (c of s.charges; track c.id) {
              <tr [class.line-through]="c.status === 'VOID'" [class.text-ink-3]="c.status === 'VOID'">
                <td class="whitespace-nowrap">{{ c.createdAt | dt }}</td><td>{{ src[c.sourceType] ?? c.sourceType }}</td><td>{{ c.description }}</td>
                <td class="num">{{ c.quantity | num }}</td><td class="num">{{ c.unitPrice | rp }}</td><td class="num">{{ c.amount | rp }}</td>
                <td><span class="badge" [class]="c.billTo === 'PASIEN' ? 'badge-warning' : 'badge-info'">{{ c.billTo === 'PASIEN' ? 'Pasien' : 'Penjamin' }}</span></td>
                <td><app-status [value]="c.status === 'INVOICED' ? 'ISSUED' : c.status" /></td>
                <td>@if (c.status === 'ACTIVE' && auth.can('billing.write')) { <button class="btn btn-sm btn-ghost" (click)="voidCharge(c)">Void</button> }</td>
              </tr>
            }
          </tbody>
        </table>
      </div>

      <h3 class="h2 mb-2">Invoice</h3>
      @for (i of s.invoices; track i.id) {
        <div class="card card-pad mb-2 flex flex-wrap items-center gap-3">
          <div class="flex-1"><b>{{ i.invoiceNo }}</b> · {{ i.billTo === 'PASIEN' ? 'Tagihan pasien' : 'Tagihan penjamin (' + s.payer.name + ')' }}
            <div class="muted">Total {{ i.total | rp }} · dibayar {{ i.paidAmount | rp }}</div></div>
          <app-status [value]="i.status" />
          @if (i.billTo === 'PASIEN' && (i.status === 'ISSUED' || i.status === 'PARTIAL') && auth.can('payment.write')) {
            <button class="btn btn-primary" (click)="openPay(i)">Terima pembayaran</button>
          }
          @if (i.billTo === 'PENJAMIN') { <a class="btn" routerLink="/claims">Ke klaim</a> }
          <a class="btn" [routerLink]="['/billing/invoices', i.id]">Cetak</a>
        </div>
      } @empty { <div class="card"><app-empty text="Belum ada invoice" /></div> }
    }

    @if (payTarget(); as i) {
      <app-modal [title]="'Pembayaran ' + i.invoiceNo" [width]="440" (closed)="payTarget.set(null)">
        <div class="text-sm mb-3">Sisa tagihan: <b class="text-lg">{{ outstanding() | rp }}</b></div>
        <div class="field mb-2"><label class="label">Metode</label>
          <select class="input" [(ngModel)]="pay.method"><option>TUNAI</option><option>DEBIT</option><option>KREDIT</option><option>QRIS</option><option>TRANSFER</option><option>VA</option></select></div>
        <div class="field mb-2"><label class="label">Jumlah</label><input class="input" type="number" [(ngModel)]="pay.amount" /></div>
        @if (pay.method !== 'TUNAI') { <div class="field mb-2"><label class="label">No. referensi / approval</label><input class="input" [(ngModel)]="pay.reference" /></div> }
        @if (pay.method === 'TUNAI') { <div class="field mb-2"><label class="label">Uang diterima</label><input class="input" type="number" [(ngModel)]="cash" /></div>
          @if (cash > pay.amount) { <div class="text-sm">Kembalian: <b>{{ cash - pay.amount | rp }}</b></div> } }
        <div class="flex justify-end mt-3"><button class="btn btn-primary" [disabled]="busy()" (click)="submitPay()">Simpan pembayaran</button></div>
      </app-modal>
    }
    @if (addOpen()) {
      <app-modal title="Charge manual" [width]="480" (closed)="addOpen.set(false)">
        <div class="field mb-2"><label class="label">Layanan</label><select class="input" [(ngModel)]="manual.serviceId">@for (sv of services(); track sv.id) {<option [value]="sv.id">{{ sv.name }}</option>}</select></div>
        <div class="field mb-2"><label class="label">Jumlah</label><input class="input" type="number" [(ngModel)]="manual.quantity" /></div>
        <div class="flex justify-end mt-3"><button class="btn btn-primary" (click)="addCharge()">Tambah</button></div>
      </app-modal>
    }
  `,
})
export class BillingEncounterPage implements OnInit {
  readonly auth = inject(AuthService);
  private readonly api = inject(Api);
  private readonly toasts = inject(Toasts);
  readonly id = input.required<string>();
  readonly types = ENCOUNTER_TYPE;
  readonly src = SOURCE_LABEL;
  readonly s = signal<any>(null);
  readonly payTarget = signal<any>(null);
  readonly addOpen = signal(false);
  readonly busy = signal(false);
  readonly services = signal<any[]>([]);
  readonly outstanding = computed(() => (this.payTarget() ? this.payTarget().total - this.payTarget().paidAmount : 0));
  pay: any = { method: 'TUNAI', amount: 0, reference: '' };
  cash = 0;
  manual: any = { serviceId: '', quantity: 1 };

  async ngOnInit() {
    await this.load();
  }

  async load() {
    try {
      this.s.set(await this.api.get(`/billing/encounters/${this.id()}`));
    } catch (e) {
      this.toasts.error(e);
    }
  }

  async generate() {
    try {
      const r = await this.api.post(`/billing/encounters/${this.id()}/invoices`);
      this.toasts.success(`${r.invoices.length} invoice diterbitkan`);
      await this.load();
    } catch (e) {
      this.toasts.error(e);
    }
  }

  openPay(i: any) {
    this.pay = { method: 'TUNAI', amount: i.total - i.paidAmount, reference: '' };
    this.cash = 0;
    this.payTarget.set(i);
  }

  async submitPay() {
    this.busy.set(true);
    try {
      const r = await this.api.post(`/billing/invoices/${this.payTarget().id}/payments`, { ...this.pay, amount: Number(this.pay.amount), reference: this.pay.reference || undefined });
      this.toasts.success(`Pembayaran ${r.paymentNo} tersimpan — ${r.invoiceStatus === 'PAID' ? 'LUNAS' : 'sisa ' + r.outstanding}`);
      this.payTarget.set(null);
      await this.load();
    } catch (e) {
      this.toasts.error(e);
    } finally {
      this.busy.set(false);
    }
  }

  async voidCharge(c: any) {
    const reason = prompt(`Alasan void "${c.description}":`);
    if (!reason || reason.length < 5) return;
    try {
      await this.api.post(`/billing/charges/${c.id}/void`, { reason });
      await this.load();
    } catch (e) {
      this.toasts.error(e);
    }
  }

  async addCharge() {
    if (!this.services().length) this.services.set(await this.api.get('/master/services'));
    if (!this.manual.serviceId) return;
    try {
      await this.api.post('/billing/charges', { encounterId: this.id(), serviceId: this.manual.serviceId, quantity: Number(this.manual.quantity) });
      this.addOpen.set(false);
      await this.load();
    } catch (e) {
      this.toasts.error(e);
    }
  }

  constructor() {
    void this.api.get('/master/services').then((s) => this.services.set(s)).catch(() => {});
  }
}
