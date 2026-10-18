import { Component, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Api, AuthService } from '../core/api';
import { PIPES, Toasts } from '../core/ui';
import { SHARED } from '../shared/components';

@Component({
  selector: 'app-inventory',
  imports: [FormsModule, ...SHARED, ...PIPES],
  template: `
    <app-page-header title="Inventori Farmasi & Logistik" subtitle="Stok per batch & tanggal kedaluwarsa (FEFO), mutasi antar gudang, stock opname.">
      @if (auth.can('inventory.write')) { <button class="btn" (click)="transferOpen.set(true)">Mutasi gudang</button> }
    </app-page-header>

    @if (alerts(); as a) {
      <div class="grid md:grid-cols-3 gap-3 mb-4">
        <div class="card card-pad"><div class="muted">Di bawah stok minimum</div><div class="text-2xl font-semibold" [class.text-warning]="a.lowStock.length">{{ a.lowStock.length }}</div>
          <div class="text-xs">@for (x of a.lowStock.slice(0, 4); track x.itemId) { {{ x.name }} ({{ x.onHand | num }}) · }</div></div>
        <div class="card card-pad"><div class="muted">Kedaluwarsa ≤ 90 hari</div><div class="text-2xl font-semibold" [class.text-warning]="a.expiringSoon.length">{{ a.expiringSoon.length }}</div>
          <div class="text-xs">@for (x of a.expiringSoon.slice(0, 4); track x.batch.id) { {{ x.itemName }} {{ x.batch.batchNo }} ED {{ x.batch.expiryDate | d }} · }</div></div>
        <div class="card card-pad"><div class="muted">Sudah kedaluwarsa (karantina)</div><div class="text-2xl font-semibold" [class.text-critical]="a.expired.length">{{ a.expired.length }}</div></div>
      </div>
    }

    <div class="flex gap-2 mb-3">
      <select class="input w-56" [(ngModel)]="warehouseId" (ngModelChange)="load()"><option value="">Semua gudang</option>@for (w of warehouses(); track w.id) {<option [value]="w.id">{{ w.name }}</option>}</select>
      <input class="input max-w-sm" [(ngModel)]="q" (keydown.enter)="load()" placeholder="Cari item…" />
    </div>
    <div class="card overflow-x-auto">
      <table class="tbl">
        <thead><tr><th>Kode</th><th>Item</th><th>Kategori</th><th class="num">Stok</th><th class="num">Min</th><th>ED terdekat</th><th class="num">Nilai (HPP)</th><th class="num">Harga jual</th><th></th></tr></thead>
        <tbody>
          @for (s of rows(); track s.itemId) {
            <tr>
              <td class="tabular-nums">{{ s.code }}</td>
              <td><b>{{ s.name }}</b> <span class="muted">{{ s.genericName }}</span>
                @if (s.isHighAlert) { <span class="badge badge-critical">High-alert</span> } @if (s.isNarcotic) { <span class="badge badge-warning">Narkotika</span> } @if (!s.isFormulary) { <span class="badge badge-neutral">Non-Fornas</span> }</td>
              <td>{{ s.category }}</td>
              <td class="num font-medium" [class.text-warning]="s.onHand < s.minStock">{{ s.onHand | num }} {{ s.uom }}</td>
              <td class="num">{{ s.minStock | num }}</td><td>{{ s.nearestExpiry | d }}</td><td class="num">{{ s.value | rp }}</td><td class="num">{{ s.salePrice | rp }}</td>
              <td><button class="btn btn-sm" (click)="openItem(s)">Batch & kartu stok</button></td>
            </tr>
          } @empty { <tr><td colspan="9"><app-empty /></td></tr> }
        </tbody>
      </table>
    </div>

    @if (item(); as it) {
      <app-modal [title]="it.name" [width]="900" (closed)="item.set(null)">
        <h3 class="h2 mb-2">Batch</h3>
        <table class="tbl mb-4">
          <thead><tr><th>Gudang</th><th>Batch</th><th>ED</th><th class="num">Qty</th><th class="num">HPP/unit</th><th></th></tr></thead>
          <tbody>
            @for (b of batches(); track b.batch.id) {
              <tr><td>{{ b.warehouseName }}</td><td>{{ b.batch.batchNo }}</td><td>{{ b.batch.expiryDate | d }}</td><td class="num">{{ b.batch.qtyOnHand | num }}</td><td class="num">{{ b.batch.unitCost | rp }}</td>
                <td>@if (auth.can('inventory.write')) { <button class="btn btn-sm" (click)="adj = { batchId: b.batch.id, quantityDelta: 0, reason: '' }">Opname</button> }</td></tr>
            }
          </tbody>
        </table>
        @if (adj) {
          <div class="card card-pad mb-4 flex flex-wrap gap-2 items-end bg-canvas">
            <div class="field"><label class="label">Selisih (+/-)</label><input class="input w-28" type="number" [(ngModel)]="adj.quantityDelta" /></div>
            <div class="field flex-1"><label class="label">Alasan</label><input class="input" [(ngModel)]="adj.reason" placeholder="Stock opname / rusak / kedaluwarsa" /></div>
            <button class="btn btn-primary" (click)="adjust()">Simpan penyesuaian</button>
          </div>
        }
        <h3 class="h2 mb-2">Kartu stok</h3>
        <div class="max-h-72 overflow-y-auto">
          <table class="tbl">
            <thead><tr><th>Waktu</th><th>Gudang</th><th>Batch</th><th>Jenis</th><th class="num">Qty</th><th>Ref</th></tr></thead>
            <tbody>@for (m of card(); track m.movement.id) {
              <tr><td>{{ m.movement.createdAt | dt }}</td><td>{{ m.warehouseName }}</td><td>{{ m.batchNo }}</td><td>{{ m.movement.type }}</td>
                <td class="num" [class.text-critical]="m.movement.quantity < 0" [class.text-success]="m.movement.quantity > 0">{{ m.movement.quantity | num }}</td><td class="muted">{{ m.movement.refType }} {{ m.movement.notes }}</td></tr>
            }</tbody>
          </table>
        </div>
      </app-modal>
    }

    @if (transferOpen()) {
      <app-modal title="Mutasi antar gudang" [width]="520" (closed)="transferOpen.set(false)">
        <div class="grid gap-3">
          <div class="field"><label class="label">Dari</label><select class="input" [(ngModel)]="tr.fromWarehouseId">@for (w of warehouses(); track w.id) {<option [value]="w.id">{{ w.name }}</option>}</select></div>
          <div class="field"><label class="label">Ke</label><select class="input" [(ngModel)]="tr.toWarehouseId">@for (w of warehouses(); track w.id) {<option [value]="w.id">{{ w.name }}</option>}</select></div>
          <div class="field"><label class="label">Item</label><select class="input" [(ngModel)]="tr.itemId">@for (s of allItems(); track s.itemId) {<option [value]="s.itemId">{{ s.name }}</option>}</select></div>
          <div class="field"><label class="label">Jumlah</label><input class="input" type="number" [(ngModel)]="tr.quantity" /></div>
          <button class="btn btn-primary justify-self-end" (click)="transfer()">Mutasi (FEFO)</button>
        </div>
      </app-modal>
    }
  `,
})
export class InventoryPage implements OnInit {
  readonly auth = inject(AuthService);
  private readonly api = inject(Api);
  private readonly toasts = inject(Toasts);
  readonly rows = signal<any[]>([]);
  readonly allItems = signal<any[]>([]);
  readonly warehouses = signal<any[]>([]);
  readonly alerts = signal<any>(null);
  readonly item = signal<any>(null);
  readonly batches = signal<any[]>([]);
  readonly card = signal<any[]>([]);
  readonly transferOpen = signal(false);
  warehouseId = '';
  q = '';
  adj: any = null;
  tr: any = { fromWarehouseId: '', toWarehouseId: '', itemId: '', quantity: 1 };

  async ngOnInit() {
    const [w, a] = await Promise.all([this.api.get('/master/warehouses'), this.api.get('/inventory/alerts')]);
    this.warehouses.set(w);
    this.alerts.set(a);
    this.tr.fromWarehouseId = w.find((x: any) => x.type === 'GUDANG_UTAMA')?.id;
    this.tr.toWarehouseId = w.find((x: any) => x.type === 'DEPO_FARMASI')?.id;
    await this.load();
    this.allItems.set(this.rows());
  }

  async load() {
    this.rows.set(await this.api.get('/inventory/stock', { warehouseId: this.warehouseId, q: this.q }));
  }

  async openItem(s: any) {
    this.adj = null;
    this.item.set(s);
    const [b, c] = await Promise.all([this.api.get(`/inventory/items/${s.itemId}/batches`), this.api.get(`/inventory/items/${s.itemId}/stock-card`)]);
    this.batches.set(b);
    this.card.set(c);
  }

  async adjust() {
    try {
      await this.api.post('/inventory/adjustments', { ...this.adj, quantityDelta: Number(this.adj.quantityDelta) });
      this.toasts.success('Penyesuaian stok tersimpan & terjurnal');
      await this.openItem(this.item());
      await this.load();
    } catch (e) {
      this.toasts.error(e);
    }
  }

  async transfer() {
    try {
      const r = await this.api.post('/inventory/transfers', { ...this.tr, quantity: Number(this.tr.quantity) });
      this.toasts.success(`Mutasi selesai (${r.batches.length} batch)`);
      this.transferOpen.set(false);
      await this.load();
    } catch (e) {
      this.toasts.error(e);
    }
  }
}
