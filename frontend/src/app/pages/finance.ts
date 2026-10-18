import { Component, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Api, AuthService } from '../core/api';
import { PIPES, Toasts, todayIso } from '../core/ui';
import { SHARED } from '../shared/components';

@Component({
  selector: 'app-finance',
  imports: [FormsModule, ...SHARED, ...PIPES],
  template: `
    <app-page-header title="Keuangan & Buku Besar" subtitle="Double-entry; seluruh transaksi operasional terposting otomatis dan tertelusur ke dokumen sumber.">
      <input class="input w-40" type="date" [(ngModel)]="from" /><input class="input w-40" type="date" [(ngModel)]="to" />
      <button class="btn" (click)="select(tab())">Terapkan</button>
      <button class="btn" (click)="print()">Cetak</button>
    </app-page-header>
    <div class="tabs mb-4 no-print">
      @for (t of tabs; track t.key) { <button class="tab" [class.tab-active]="tab() === t.key" (click)="select(t.key)">{{ t.label }}</button> }
    </div>

    @switch (tab()) {
      @case ('tb') {
        @if (tb(); as t) {
          <div class="mb-2"><span class="badge" [class]="t.balanced ? 'badge-success' : 'badge-critical'">{{ t.balanced ? '✓ Seimbang' : '✗ Tidak seimbang' }}</span></div>
          <div class="card overflow-x-auto">
            <table class="tbl">
              <thead><tr><th>Kode</th><th>Akun</th><th class="num">Debit</th><th class="num">Kredit</th><th class="num">Saldo</th></tr></thead>
              <tbody>@for (l of t.lines; track l.code) { @if (l.debit || l.credit) {
                <tr><td class="tabular-nums">{{ l.code }}</td><td>{{ l.name }}</td><td class="num">{{ l.debit | rp }}</td><td class="num">{{ l.credit | rp }}</td><td class="num font-medium">{{ l.balance | rp }}</td></tr> } }</tbody>
              <tfoot><tr class="font-semibold"><td colspan="2" class="px-3 py-2">Total</td><td class="num px-3 py-2">{{ t.totalDebit | rp }}</td><td class="num px-3 py-2">{{ t.totalCredit | rp }}</td><td></td></tr></tfoot>
            </table>
          </div>
        }
      }
      @case ('is') {
        @if (is(); as s) {
          <div class="card card-pad max-w-2xl">
            <h3 class="h2 mb-2">Laporan Laba Rugi</h3>
            <div class="muted mb-2">Pendapatan</div>
            @for (l of s.revenue; track l.code) { @if (l.balance) { <div class="flex justify-between text-sm py-0.5"><span>{{ l.code }} {{ l.name }}</span><span class="tabular-nums">{{ l.balance | rp }}</span></div> } }
            <div class="flex justify-between font-semibold border-t border-line mt-1 pt-1"><span>Total pendapatan</span><span>{{ s.totalRevenue | rp }}</span></div>
            <div class="muted mt-3 mb-2">Beban</div>
            @for (l of s.expense; track l.code) { @if (l.balance) { <div class="flex justify-between text-sm py-0.5"><span>{{ l.code }} {{ l.name }}</span><span class="tabular-nums">{{ l.balance | rp }}</span></div> } }
            <div class="flex justify-between font-semibold border-t border-line mt-1 pt-1"><span>Total beban</span><span>{{ s.totalExpense | rp }}</span></div>
            <div class="flex justify-between text-lg font-semibold border-t-2 border-ink mt-3 pt-2"><span>Surplus / (defisit)</span><span [class.text-critical]="s.netIncome < 0">{{ s.netIncome | rp }}</span></div>
          </div>
        }
      }
      @case ('bs') {
        @if (bs(); as b) {
          <div class="grid md:grid-cols-2 gap-4">
            <div class="card card-pad"><h3 class="h2 mb-2">Aset</h3>
              @for (l of b.assets; track l.code) { <div class="flex justify-between text-sm py-0.5"><span>{{ l.code }} {{ l.name }}</span><span class="tabular-nums">{{ l.balance | rp }}</span></div> }
              <div class="flex justify-between font-semibold border-t border-line mt-2 pt-1"><span>Total aset</span><span>{{ b.totalAssets | rp }}</span></div></div>
            <div class="card card-pad"><h3 class="h2 mb-2">Liabilitas & Ekuitas</h3>
              @for (l of b.liabilities; track l.code) { <div class="flex justify-between text-sm py-0.5"><span>{{ l.code }} {{ l.name }}</span><span class="tabular-nums">{{ l.balance | rp }}</span></div> }
              @for (l of b.equity; track l.code) { <div class="flex justify-between text-sm py-0.5"><span>{{ l.code }} {{ l.name }}</span><span class="tabular-nums">{{ l.balance | rp }}</span></div> }
              <div class="flex justify-between text-sm py-0.5"><span>Surplus berjalan</span><span class="tabular-nums">{{ b.currentEarnings | rp }}</span></div>
              <div class="flex justify-between font-semibold border-t border-line mt-2 pt-1"><span>Total</span><span>{{ b.totalLiabilitiesAndEquity | rp }}</span></div></div>
          </div>
        }
      }
      @case ('jr') {
        <div class="flex gap-2 mb-3 no-print">
          <select class="input w-56" [(ngModel)]="sourceType" (ngModelChange)="select('jr')"><option value="">Semua sumber</option>@for (s of sources; track s) {<option [value]="s">{{ s }}</option>}</select>
          @if (auth.can('finance.write')) { <button class="btn" (click)="manualOpen.set(true)">+ Jurnal umum</button> }
        </div>
        @for (j of journals(); track j.id) {
          <div class="card mb-2">
            <div class="px-3 py-2 flex flex-wrap gap-2 justify-between border-b border-line text-sm">
              <div><b>{{ j.journalNo }}</b> · {{ j.date | d }} · {{ j.description }}</div>
              <div class="flex gap-2 items-center"><span class="badge badge-neutral">{{ j.sourceType }}</span>@if (j.status === 'REVERSED') { <span class="badge badge-warning">Dibalik</span> }
                @if (j.status === 'POSTED' && j.sourceType === 'MANUAL' && auth.can('finance.write')) { <button class="btn btn-sm" (click)="reverse(j.id)">Balik</button> }</div>
            </div>
            <table class="tbl"><tbody>@for (l of j.lines; track l.id) {
              <tr><td class="w-24 tabular-nums">{{ l.accountCode }}</td><td>{{ accName(l.accountCode) }}</td><td class="num w-40">{{ l.debit ? (l.debit | rp) : '' }}</td><td class="num w-40">{{ l.credit ? (l.credit | rp) : '' }}</td></tr>
            }</tbody></table>
          </div>
        } @empty { <div class="card"><app-empty /></div> }
      }
      @case ('coa') {
        <div class="card overflow-x-auto">
          <table class="tbl"><thead><tr><th>Kode</th><th>Nama</th><th>Tipe</th><th>Saldo normal</th><th>Dapat diposting</th></tr></thead>
            <tbody>@for (a of accounts(); track a.id) { <tr [class.font-semibold]="!a.isPostable"><td class="tabular-nums">{{ a.code }}</td><td>{{ a.name }}</td><td>{{ a.type }}</td><td>{{ a.normalBalance === 'D' ? 'Debit' : 'Kredit' }}</td><td>{{ a.isPostable ? 'Ya' : 'Induk' }}</td></tr> }</tbody></table>
        </div>
      }
    }

    @if (manualOpen()) {
      <app-modal title="Jurnal umum" [width]="760" (closed)="manualOpen.set(false)">
        <div class="grid sm:grid-cols-3 gap-2 mb-3">
          <div class="field"><label class="label">Tanggal</label><input class="input" type="date" [(ngModel)]="mj.date" /></div>
          <div class="field sm:col-span-2"><label class="label">Keterangan</label><input class="input" [(ngModel)]="mj.description" /></div>
        </div>
        @for (l of mj.lines; track $index) {
          <div class="grid grid-cols-6 gap-2 mb-1">
            <select class="input col-span-3" [(ngModel)]="l.accountCode">@for (a of postable(); track a.code) {<option [value]="a.code">{{ a.code }} {{ a.name }}</option>}</select>
            <input class="input" type="number" placeholder="Debit" [(ngModel)]="l.debit" /><input class="input" type="number" placeholder="Kredit" [(ngModel)]="l.credit" />
            <button class="btn btn-ghost" (click)="mj.lines.splice($index, 1)">✕</button>
          </div>
        }
        <button class="btn btn-sm mt-1" (click)="mj.lines.push({ accountCode: '', debit: 0, credit: 0 })">+ Baris</button>
        <div class="flex justify-between items-center mt-3"><span class="text-sm">D {{ totalD() | rp }} · K {{ totalK() | rp }}</span><button class="btn btn-primary" (click)="saveManual()">Posting</button></div>
      </app-modal>
    }
  `,
})
export class FinancePage implements OnInit {
  readonly auth = inject(AuthService);
  private readonly api = inject(Api);
  private readonly toasts = inject(Toasts);
  readonly tabs = [
    { key: 'tb', label: 'Neraca saldo' },
    { key: 'is', label: 'Laba rugi' },
    { key: 'bs', label: 'Neraca' },
    { key: 'jr', label: 'Jurnal' },
    { key: 'coa', label: 'Bagan akun' },
  ];
  readonly sources = ['INVOICE', 'PAYMENT', 'DISPENSE', 'GOODS_RECEIPT', 'AP_INVOICE', 'AP_PAYMENT', 'CLAIM_PAYMENT', 'STOCK_ADJUSTMENT', 'MANUAL', 'REVERSAL', 'OPENING_STOCK', 'OPENING_BALANCE'];
  readonly tab = signal('tb');
  readonly tb = signal<any>(null);
  readonly is = signal<any>(null);
  readonly bs = signal<any>(null);
  readonly journals = signal<any[]>([]);
  readonly accounts = signal<any[]>([]);
  readonly manualOpen = signal(false);
  from = todayIso().slice(0, 8) + '01';
  to = todayIso();
  sourceType = '';
  mj: any = { date: todayIso(), description: '', lines: [{ accountCode: '', debit: 0, credit: 0 }, { accountCode: '', debit: 0, credit: 0 }] };

  async ngOnInit() {
    this.accounts.set(await this.api.get('/finance/accounts'));
    await this.select('tb');
  }

  postable() {
    return this.accounts().filter((a) => a.isPostable);
  }
  accName(code: string) {
    return this.accounts().find((a) => a.code === code)?.name ?? '';
  }
  totalD() {
    return this.mj.lines.reduce((s: number, l: any) => s + Number(l.debit || 0), 0);
  }
  totalK() {
    return this.mj.lines.reduce((s: number, l: any) => s + Number(l.credit || 0), 0);
  }

  async select(t: string) {
    this.tab.set(t);
    const period = { from: this.from, to: this.to };
    try {
      if (t === 'tb') this.tb.set(await this.api.get('/finance/reports/trial-balance', period));
      if (t === 'is') this.is.set(await this.api.get('/finance/reports/income-statement', period));
      if (t === 'bs') this.bs.set(await this.api.get('/finance/reports/balance-sheet', { to: this.to }));
      if (t === 'jr') this.journals.set(await this.api.get('/finance/journals', { ...period, sourceType: this.sourceType }));
    } catch (e) {
      this.toasts.error(e);
    }
  }

  async saveManual() {
    try {
      await this.api.post('/finance/journals', { ...this.mj, lines: this.mj.lines.map((l: any) => ({ accountCode: l.accountCode, debit: Number(l.debit || 0), credit: Number(l.credit || 0) })) });
      this.toasts.success('Jurnal terposting');
      this.manualOpen.set(false);
      await this.select('jr');
    } catch (e) {
      this.toasts.error(e);
    }
  }

  async reverse(id: string) {
    try {
      await this.api.post(`/finance/journals/${id}/reverse`);
      await this.select('jr');
    } catch (e) {
      this.toasts.error(e);
    }
  }

  print() {
    window.print();
  }
}
