import { Component, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Api, AuthService } from '../core/api';
import { ENCOUNTER_TYPE, PIPES, Toasts, todayIso } from '../core/ui';
import { SHARED } from '../shared/components';

@Component({
  selector: 'app-billing',
  imports: [FormsModule, RouterLink, ...SHARED, ...PIPES],
  template: `
    <app-page-header title="Kasir & Billing" subtitle="Tagihan pasien dipisah dari tagihan penjamin. Setiap transaksi otomatis terjurnal." />
    <div class="tabs mb-4">
      @for (t of tabs; track t.key) { <button class="tab" [class.tab-active]="tab() === t.key" (click)="select(t.key)">{{ t.label }}</button> }
    </div>

    @switch (tab()) {
      @case ('pending') {
        <div class="card overflow-x-auto">
          <table class="tbl">
            <thead><tr><th>Kunjungan</th><th>Pasien</th><th>Penjamin</th><th>Status layanan</th><th class="num">Belum ditagih</th><th></th></tr></thead>
            <tbody>
              @for (r of pending(); track r.encounterId) {
                <tr>
                  <td>{{ r.encounterNo }}<div class="muted">{{ types[r.type] }}</div></td>
                  <td><b>{{ r.patientName }}</b><div class="muted">RM {{ r.mrn | mrn }}</div></td>
                  <td>{{ r.payerName }}</td><td><app-status [value]="r.status" /></td>
                  <td class="num font-medium">{{ r.amount | rp }}</td>
                  <td><a class="btn btn-sm btn-primary" [routerLink]="['/billing/encounters', r.encounterId]">Proses</a></td>
                </tr>
              } @empty { <tr><td colspan="6"><app-empty text="Tidak ada tagihan tertunda" /></td></tr> }
            </tbody>
          </table>
        </div>
      }
      @case ('invoices') {
        <div class="flex gap-2 mb-3">
          <select class="input w-44" [(ngModel)]="invStatus" (ngModelChange)="loadInvoices()"><option value="">Semua status</option><option value="ISSUED">Belum bayar</option><option value="PARTIAL">Sebagian</option><option value="PAID">Lunas</option><option value="VOID">Void</option></select>
          <select class="input w-44" [(ngModel)]="invBillTo" (ngModelChange)="loadInvoices()"><option value="">Pasien & penjamin</option><option value="PASIEN">Tagihan pasien</option><option value="PENJAMIN">Tagihan penjamin</option></select>
        </div>
        <div class="card overflow-x-auto">
          <table class="tbl">
            <thead><tr><th>No. invoice</th><th>Pasien</th><th>Ditagihkan ke</th><th class="num">Total</th><th class="num">Dibayar</th><th>Status</th><th></th></tr></thead>
            <tbody>
              @for (i of invoices(); track i.id) {
                <tr>
                  <td>{{ i.invoiceNo }}<div class="muted">{{ i.createdAt | dt }}</div></td>
                  <td><b>{{ i.patientName }}</b><div class="muted">{{ i.encounterNo }}</div></td>
                  <td>{{ i.billTo === 'PASIEN' ? 'Pasien' : i.payerName }}</td>
                  <td class="num">{{ i.total | rp }}</td><td class="num">{{ i.paidAmount | rp }}</td>
                  <td><app-status [value]="i.status" /></td>
                  <td><a class="btn btn-sm" [routerLink]="['/billing/invoices', i.id]">Detail</a></td>
                </tr>
              } @empty { <tr><td colspan="7"><app-empty /></td></tr> }
            </tbody>
          </table>
        </div>
      }
      @case ('recap') {
        <div class="flex gap-2 mb-3"><input class="input w-44" type="date" [(ngModel)]="recapDate" (ngModelChange)="loadRecap()" /><button class="btn" (click)="print()">Cetak</button></div>
        @if (recap(); as r) {
          <div class="card">
            <table class="tbl">
              <thead><tr><th>Kasir</th><th>Metode</th><th class="num">Transaksi</th><th class="num">Jumlah</th></tr></thead>
              <tbody>
                @for (x of r.rows; track $index) { <tr><td>{{ x.cashier }}</td><td>{{ x.method }}</td><td class="num">{{ x.count }}</td><td class="num">{{ x.total | rp }}</td></tr> }
                @empty { <tr><td colspan="4"><app-empty text="Belum ada penerimaan" /></td></tr> }
              </tbody>
              <tfoot><tr><td colspan="3" class="font-semibold px-3 py-2">Total penerimaan {{ r.date | d }}</td><td class="num font-semibold px-3 py-2">{{ r.grandTotal | rp }}</td></tr></tfoot>
            </table>
          </div>
        }
      }
      @case ('aging') {
        <div class="card overflow-x-auto">
          <table class="tbl">
            <thead><tr><th>Penjamin</th><th class="num">0–30 hari</th><th class="num">31–60</th><th class="num">61–90</th><th class="num">&gt; 90</th><th class="num">Total</th></tr></thead>
            <tbody>
              @for (a of aging(); track a.payer) {
                <tr><td>{{ a.payer }} <span class="muted">{{ a.type }}</span></td><td class="num">{{ a.d0_30 | rp }}</td><td class="num">{{ a.d31_60 | rp }}</td><td class="num">{{ a.d61_90 | rp }}</td><td class="num" [class.text-critical]="a.d90p > 0">{{ a.d90p | rp }}</td><td class="num font-semibold">{{ a.total | rp }}</td></tr>
              } @empty { <tr><td colspan="6"><app-empty text="Tidak ada piutang terbuka" /></td></tr> }
            </tbody>
          </table>
        </div>
      }
    }
  `,
})
export class BillingPage implements OnInit {
  readonly auth = inject(AuthService);
  private readonly api = inject(Api);
  private readonly toasts = inject(Toasts);
  readonly types = ENCOUNTER_TYPE;
  readonly tab = signal('pending');
  readonly tabs = [
    { key: 'pending', label: 'Antrean tagihan' },
    { key: 'invoices', label: 'Invoice' },
    { key: 'recap', label: 'Rekap kasir harian' },
    { key: 'aging', label: 'Umur piutang' },
  ];
  readonly pending = signal<any[]>([]);
  readonly invoices = signal<any[]>([]);
  readonly recap = signal<any>(null);
  readonly aging = signal<any[]>([]);
  invStatus = '';
  invBillTo = '';
  recapDate = todayIso();

  async ngOnInit() {
    await this.select('pending');
  }

  async select(key: string) {
    this.tab.set(key);
    try {
      if (key === 'pending') this.pending.set(await this.api.get('/billing/pending'));
      if (key === 'invoices') await this.loadInvoices();
      if (key === 'recap') await this.loadRecap();
      if (key === 'aging') this.aging.set(await this.api.get('/billing/ar-aging'));
    } catch (e) {
      this.toasts.error(e);
    }
  }

  async loadInvoices() {
    this.invoices.set(await this.api.get('/billing/invoices', { status: this.invStatus, billTo: this.invBillTo }));
  }

  async loadRecap() {
    this.recap.set(await this.api.get('/billing/cashier-recap', { date: this.recapDate }));
  }

  print() {
    window.print();
  }
}
