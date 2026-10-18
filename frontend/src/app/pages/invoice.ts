import { Component, inject, input, OnInit, signal } from '@angular/core';
import { Api, AuthService } from '../core/api';
import { PIPES, Toasts } from '../core/ui';
import { SHARED } from '../shared/components';

/** Invoice / kuitansi siap cetak. */
@Component({
  selector: 'app-invoice',
  imports: [...SHARED, ...PIPES],
  template: `
    @if (inv(); as v) {
      <div class="flex gap-2 mb-4 no-print"><button class="btn btn-primary" (click)="print()">Cetak</button>
        @if (v.invoice.status === 'ISSUED' && auth.can('billing.write')) { <button class="btn btn-danger" (click)="voidInvoice()">Void invoice</button> }</div>
      <div class="card p-8 max-w-3xl mx-auto bg-white">
        <div class="flex justify-between border-b border-line pb-4 mb-4">
          <div><div class="text-lg font-semibold">{{ auth.user()?.facility?.name }}</div><div class="muted">Kode faskes {{ auth.user()?.facility?.code }}</div></div>
          <div class="text-right"><div class="text-lg font-semibold">{{ v.invoice.billTo === 'PASIEN' ? 'INVOICE / KUITANSI' : 'TAGIHAN PENJAMIN' }}</div><div>{{ v.invoice.invoiceNo }}</div><div class="muted">{{ v.invoice.createdAt | dt }}</div></div>
        </div>
        <div class="grid grid-cols-2 gap-4 text-sm mb-4">
          <div><div class="muted">Pasien</div><b>{{ v.patient.name }}</b><div>RM {{ v.patient.mrn | mrn }}</div><div>{{ v.patient.address }}</div></div>
          <div><div class="muted">Kunjungan / Penjamin</div><b>{{ v.encounterNo }}</b><div>{{ v.payer.name }}</div></div>
        </div>
        <table class="tbl mb-4">
          <thead><tr><th>Uraian</th><th class="num">Qty</th><th class="num">Tarif</th><th class="num">Jumlah</th></tr></thead>
          <tbody>@for (l of v.lines; track l.id) { <tr><td>{{ l.description }}</td><td class="num">{{ l.quantity | num }}</td><td class="num">{{ l.unitPrice | rp }}</td><td class="num">{{ l.amount | rp }}</td></tr> }</tbody>
          <tfoot>
            <tr><td colspan="3" class="px-3 py-1 text-right font-semibold">Total</td><td class="num px-3 py-1 font-semibold">{{ v.invoice.total | rp }}</td></tr>
            <tr><td colspan="3" class="px-3 py-1 text-right">Dibayar</td><td class="num px-3 py-1">{{ v.invoice.paidAmount | rp }}</td></tr>
            <tr><td colspan="3" class="px-3 py-1 text-right">Sisa</td><td class="num px-3 py-1">{{ v.invoice.total - v.invoice.paidAmount | rp }}</td></tr>
          </tfoot>
        </table>
        @if (v.payments.length) {
          <div class="text-sm"><div class="muted mb-1">Riwayat pembayaran</div>
            @for (p of v.payments; track p.payment.id) { <div>{{ p.payment.paymentNo }} · {{ p.payment.createdAt | dt }} · {{ p.payment.method }} · {{ p.payment.amount | rp }} · kasir {{ p.cashier }}</div> }</div>
        }
        <div class="mt-6 flex justify-between items-end text-sm"><app-status [value]="v.invoice.status" /><div class="text-center"><div class="muted mb-12">Petugas</div><div>( ____________________ )</div></div></div>
      </div>
    }
  `,
})
export class InvoicePage implements OnInit {
  readonly auth = inject(AuthService);
  private readonly api = inject(Api);
  private readonly toasts = inject(Toasts);
  readonly id = input.required<string>();
  readonly inv = signal<any>(null);

  async ngOnInit() {
    this.inv.set(await this.api.get(`/billing/invoices/${this.id()}`));
  }

  print() {
    window.print();
  }

  async voidInvoice() {
    const reason = prompt('Alasan void invoice:');
    if (!reason || reason.length < 5) return;
    try {
      await this.api.post(`/billing/invoices/${this.id()}/void`, { reason });
      this.toasts.success('Invoice dibatalkan; jurnal dibalik');
      await this.ngOnInit();
    } catch (e) {
      this.toasts.error(e);
    }
  }
}
