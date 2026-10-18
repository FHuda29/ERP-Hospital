import { Component, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Api, AuthService } from '../core/api';
import { PIPES, Toasts, todayIso } from '../core/ui';
import { SHARED } from '../shared/components';

@Component({
  selector: 'app-procurement',
  imports: [FormsModule, ...SHARED, ...PIPES],
  template: `
    <app-page-header title="Pengadaan (Procure-to-Pay)" subtitle="Permintaan → persetujuan → PO → penerimaan & inspeksi → faktur (three-way match) → pembayaran → evaluasi vendor. Pemohon/pembuat tidak dapat menyetujui sendiri." />
    <div class="tabs mb-4">
      @for (t of tabs; track t.key) { <button class="tab" [class.tab-active]="tab() === t.key" (click)="select(t.key)">{{ t.label }}</button> }
    </div>

    @switch (tab()) {
      @case ('pr') {
        @if (auth.can('procurement.write', 'inventory.write')) {
          <div class="card card-pad mb-4">
            <h3 class="h2 mb-2">Permintaan pembelian baru</h3>
            <div class="grid sm:grid-cols-4 gap-2 items-end">
              <div class="field"><label class="label">Unit peminta</label><select class="input" [(ngModel)]="pr.unitId">@for (u of units(); track u.id) {<option [value]="u.id">{{ u.name }}</option>}</select></div>
              <div class="field"><label class="label">Item</label><select class="input" [(ngModel)]="prLine.itemId">@for (i of items(); track i.id) {<option [value]="i.id">{{ i.name }} {{ i.strength }}</option>}</select></div>
              <div class="field"><label class="label">Jumlah</label><input class="input" type="number" [(ngModel)]="prLine.quantity" /></div>
              <button class="btn" (click)="addPrLine()">+ Tambah item</button>
            </div>
            @for (l of pr.items; track $index) { <div class="text-sm mt-1">• {{ itemName(l.itemId) }} × {{ l.quantity }}</div> }
            <div class="flex justify-end mt-2"><button class="btn btn-primary" [disabled]="!pr.items.length" (click)="createPr()">Ajukan</button></div>
          </div>
        }
        @for (p of prs(); track p.pr.id) {
          <div class="card card-pad mb-2">
            <div class="flex justify-between"><b>{{ p.pr.prNo }} · {{ p.unitName }}</b><app-status [value]="p.pr.status === 'ORDERED' ? 'ORDERED_PR' : p.pr.status" /></div>
            @for (l of p.items; track l.line.id) { <div class="text-sm">• {{ l.itemName }} × {{ l.line.quantity | num }} {{ l.uom }} <span class="muted">(stok saat ini {{ l.onHand | num }})</span></div> }
            <div class="flex gap-2 mt-2">
              @if (p.pr.status === 'SUBMITTED' && auth.can('procurement.approve')) {
                <button class="btn btn-sm btn-success" (click)="act('/procurement/requests/' + p.pr.id + '/approve')">Setujui</button>
                <button class="btn btn-sm btn-danger" (click)="act('/procurement/requests/' + p.pr.id + '/reject', { reason: 'Tidak sesuai kebutuhan' })">Tolak</button>
              }
              @if (p.pr.status === 'APPROVED' && auth.can('procurement.write')) { <button class="btn btn-sm btn-primary" (click)="startPo(p)">Buat PO</button> }
            </div>
          </div>
        } @empty { <div class="card"><app-empty /></div> }
      }
      @case ('po') {
        @if (poDraft) {
          <div class="card card-pad mb-4">
            <h3 class="h2 mb-2">PO baru</h3>
            <div class="grid sm:grid-cols-3 gap-2 mb-2">
              <div class="field"><label class="label">Vendor</label><select class="input" [(ngModel)]="poDraft.vendorId">@for (v of vendors(); track v.id) {<option [value]="v.id">{{ v.name }}</option>}</select></div>
              <div class="field"><label class="label">Perkiraan datang</label><input class="input" type="date" [(ngModel)]="poDraft.expectedDate" /></div>
              <div class="field"><label class="label">PPN (%)</label><input class="input" type="number" [(ngModel)]="poDraft.taxRate" /></div>
            </div>
            <table class="tbl"><thead><tr><th>Item</th><th class="num">Qty</th><th>Harga satuan</th></tr></thead>
              <tbody>@for (l of poDraft.items; track $index) { <tr><td>{{ itemName(l.itemId) }}</td><td class="num">{{ l.quantity }}</td><td><input class="input w-36" type="number" [(ngModel)]="l.unitPrice" /></td></tr> }</tbody></table>
            <div class="flex justify-end gap-2 mt-2"><button class="btn" (click)="poDraft = null">Batal</button><button class="btn btn-primary" (click)="createPo()">Simpan PO</button></div>
          </div>
        }
        @for (p of pos(); track p.po.id) {
          <div class="card card-pad mb-2">
            <div class="flex justify-between"><div><b>{{ p.po.poNo }}</b> · {{ p.vendorName }} <span class="muted">{{ p.po.orderDate | d }}</span></div><app-status [value]="p.po.status" /></div>
            @for (l of p.items; track l.line.id) { <div class="text-sm">• {{ l.itemName }} × {{ l.line.quantity | num }} @ {{ l.line.unitPrice | rp }} <span class="muted">diterima {{ l.line.receivedQty | num }}</span></div> }
            <div class="text-sm mt-1">Subtotal {{ p.po.subtotal | rp }} · PPN {{ p.po.tax | rp }} · <b>Total {{ p.po.total | rp }}</b></div>
            <div class="flex gap-2 mt-2">
              @if (p.po.status === 'DRAFT' && auth.can('procurement.approve')) { <button class="btn btn-sm btn-success" (click)="act('/procurement/orders/' + p.po.id + '/approve')">Setujui PO</button> }
              @if ((p.po.status === 'APPROVED' || p.po.status === 'PARTIAL') && auth.can('procurement.receive')) { <button class="btn btn-sm btn-primary" (click)="startGr(p)">Terima barang</button> }
              @if ((p.po.status === 'RECEIVED' || p.po.status === 'PARTIAL') && auth.can('ap.write')) { <button class="btn btn-sm" (click)="startAp(p)">Catat faktur</button> }
            </div>
          </div>
        } @empty { <div class="card"><app-empty /></div> }
      }
      @case ('ap') {
        <div class="card overflow-x-auto">
          <table class="tbl">
            <thead><tr><th>Faktur</th><th>Vendor</th><th>PO</th><th>Jatuh tempo</th><th class="num">Total</th><th class="num">Dibayar</th><th>Match</th><th>Status</th><th></th></tr></thead>
            <tbody>
              @for (a of aps(); track a.invoice.id) {
                <tr><td>{{ a.invoice.invoiceNo }}<div class="muted">{{ a.invoice.invoiceDate | d }}</div></td><td>{{ a.vendorName }}</td><td>{{ a.poNo }}</td><td>{{ a.invoice.dueDate | d }}</td>
                  <td class="num">{{ a.invoice.total | rp }}</td><td class="num">{{ a.invoice.paidAmount | rp }}</td><td><span class="badge badge-success">{{ a.invoice.matchStatus }}</span></td><td><app-status [value]="a.invoice.status" /></td>
                  <td>@if (a.invoice.status !== 'PAID' && auth.can('ap.write')) { <button class="btn btn-sm btn-primary" (click)="payAp(a)">Bayar</button> }</td></tr>
              } @empty { <tr><td colspan="9"><app-empty /></td></tr> }
            </tbody>
          </table>
        </div>
      }
      @case ('vendor') {
        <div class="card overflow-x-auto">
          <table class="tbl">
            <thead><tr><th>Vendor</th><th class="num">PO</th><th class="num">Penerimaan</th><th class="num">Tepat waktu</th><th class="num">Tolak inspeksi</th></tr></thead>
            <tbody>@for (v of perf(); track v.vendorId) {
              <tr><td>{{ v.vendorName }}</td><td class="num">{{ v.poCount }}</td><td class="num">{{ v.receipts }}</td><td class="num">{{ v.onTimeRate === null ? '—' : (v.onTimeRate | num) + '%' }}</td><td class="num">{{ v.rejectRate === null ? '—' : (v.rejectRate | num) + '%' }}</td></tr>
            }</tbody>
          </table>
        </div>
      }
    }

    @if (gr) {
      <app-modal [title]="'Penerimaan ' + gr.poNo" [width]="820" (closed)="gr = null">
        <div class="grid sm:grid-cols-2 gap-2 mb-3">
          <div class="field"><label class="label">Gudang</label><select class="input" [(ngModel)]="gr.warehouseId">@for (w of warehouses(); track w.id) {<option [value]="w.id">{{ w.name }}</option>}</select></div>
          <div class="field"><label class="label">No. surat jalan</label><input class="input" [(ngModel)]="gr.vendorDeliveryNo" /></div>
        </div>
        <table class="tbl">
          <thead><tr><th>Item</th><th>Batch</th><th>ED</th><th>Qty</th><th>Lolos inspeksi</th></tr></thead>
          <tbody>@for (l of gr.items; track l.poItemId) {
            <tr><td>{{ l.name }}</td><td><input class="input w-32" [(ngModel)]="l.batchNo" /></td><td><input class="input" type="date" [(ngModel)]="l.expiryDate" /></td>
              <td><input class="input w-24" type="number" [(ngModel)]="l.quantity" /></td><td><input type="checkbox" [(ngModel)]="l.inspectionPassed" /></td></tr>
          }</tbody>
        </table>
        <div class="flex justify-end mt-3"><button class="btn btn-primary" (click)="submitGr()">Simpan penerimaan</button></div>
      </app-modal>
    }
    @if (ap) {
      <app-modal [title]="'Faktur pemasok — ' + ap.poNo" [width]="520" (closed)="ap = null">
        <div class="grid gap-2">
          <div class="field"><label class="label">No. faktur</label><input class="input" [(ngModel)]="ap.invoiceNo" /></div>
          <div class="field"><label class="label">Tanggal faktur</label><input class="input" type="date" [(ngModel)]="ap.invoiceDate" /></div>
          <div class="field"><label class="label">DPP (subtotal)</label><input class="input" type="number" [(ngModel)]="ap.subtotal" /></div>
          <div class="field"><label class="label">PPN</label><input class="input" type="number" [(ngModel)]="ap.tax" /></div>
          <button class="btn btn-primary justify-self-end" (click)="submitAp()">Cocokkan & simpan</button>
        </div>
      </app-modal>
    }
  `,
})
export class ProcurementPage implements OnInit {
  readonly auth = inject(AuthService);
  private readonly api = inject(Api);
  private readonly toasts = inject(Toasts);
  readonly tab = signal('pr');
  readonly tabs = [
    { key: 'pr', label: 'Permintaan (PR)' },
    { key: 'po', label: 'Purchase Order' },
    { key: 'ap', label: 'Hutang usaha' },
    { key: 'vendor', label: 'Evaluasi vendor' },
  ];
  readonly prs = signal<any[]>([]);
  readonly pos = signal<any[]>([]);
  readonly aps = signal<any[]>([]);
  readonly perf = signal<any[]>([]);
  readonly units = signal<any[]>([]);
  readonly items = signal<any[]>([]);
  readonly vendors = signal<any[]>([]);
  readonly warehouses = signal<any[]>([]);
  pr: any = { unitId: '', items: [] };
  prLine: any = { itemId: '', quantity: 100 };
  poDraft: any = null;
  gr: any = null;
  ap: any = null;

  async ngOnInit() {
    const [u, i, v, w] = await Promise.all([this.api.get('/master/units'), this.api.get('/master/items'), this.api.get('/master/vendors'), this.api.get('/master/warehouses')]);
    this.units.set(u);
    this.items.set(i);
    this.vendors.set(v);
    this.warehouses.set(w);
    this.pr.unitId = u.find((x: any) => x.type === 'FARMASI')?.id ?? u[0]?.id;
    this.prLine.itemId = i[0]?.id;
    await this.select('pr');
  }

  itemName(id: string) {
    return this.items().find((i) => i.id === id)?.name ?? id;
  }

  async select(t: string) {
    this.tab.set(t);
    try {
      if (t === 'pr') this.prs.set(await this.api.get('/procurement/requests'));
      if (t === 'po') this.pos.set(await this.api.get('/procurement/orders'));
      if (t === 'ap') this.aps.set(await this.api.get('/procurement/ap-invoices'));
      if (t === 'vendor') this.perf.set(await this.api.get('/procurement/vendor-performance'));
    } catch (e) {
      this.toasts.error(e);
    }
  }

  async act(path: string, body: any = {}) {
    try {
      await this.api.post(path, body);
      this.toasts.success('Berhasil');
      await this.select(this.tab());
    } catch (e) {
      this.toasts.error(e);
    }
  }

  addPrLine() {
    this.pr.items.push({ itemId: this.prLine.itemId, quantity: Number(this.prLine.quantity) });
  }

  async createPr() {
    await this.act('/procurement/requests', this.pr);
    this.pr.items = [];
  }

  startPo(p: any) {
    this.poDraft = {
      vendorId: this.vendors()[0]?.id,
      prId: p.pr.id,
      taxRate: 11,
      expectedDate: '',
      items: p.items.map((l: any) => ({ itemId: l.line.itemId, quantity: l.line.quantity, unitPrice: 0 })),
    };
    this.tab.set('po');
    void this.select('po');
  }

  async createPo() {
    const body = { ...this.poDraft, expectedDate: this.poDraft.expectedDate || undefined, taxRate: Number(this.poDraft.taxRate), items: this.poDraft.items.map((i: any) => ({ ...i, unitPrice: Number(i.unitPrice) })) };
    await this.act('/procurement/orders', body);
    this.poDraft = null;
  }

  startGr(p: any) {
    this.gr = {
      poId: p.po.id,
      poNo: p.po.poNo,
      warehouseId: this.warehouses().find((w) => w.type === 'GUDANG_UTAMA')?.id,
      vendorDeliveryNo: '',
      items: p.items
        .filter((l: any) => l.line.receivedQty < l.line.quantity)
        .map((l: any) => ({ poItemId: l.line.id, name: l.itemName, batchNo: '', expiryDate: '', quantity: l.line.quantity - l.line.receivedQty, inspectionPassed: true })),
    };
  }

  async submitGr() {
    const { poNo: _p, ...body } = this.gr;
    body.items = body.items.map(({ name: _n, ...l }: any) => ({ ...l, quantity: Number(l.quantity) }));
    await this.act('/procurement/receipts', body);
    this.gr = null;
  }

  startAp(p: any) {
    const received = p.items.reduce((s: number, l: any) => s + l.line.receivedQty * l.line.unitPrice, 0);
    this.ap = { poId: p.po.id, poNo: p.po.poNo, invoiceNo: '', invoiceDate: todayIso(), subtotal: received, tax: Math.round((received * p.po.taxRate) / 100) };
  }

  async submitAp() {
    const { poNo: _p, ...body } = this.ap;
    await this.act('/procurement/ap-invoices', { ...body, subtotal: Number(body.subtotal), tax: Number(body.tax) });
    this.ap = null;
    await this.select('ap');
  }

  async payAp(a: any) {
    await this.act(`/procurement/ap-invoices/${a.invoice.id}/payments`, { amount: a.invoice.total - a.invoice.paidAmount, method: 'TRANSFER' });
  }
}
