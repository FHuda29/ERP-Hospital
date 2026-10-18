import { Component, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Api, AuthService } from '../core/api';
import { PIPES, Toasts } from '../core/ui';
import { SHARED } from '../shared/components';

@Component({
  selector: 'app-governance',
  imports: [FormsModule, ...SHARED, ...PIPES],
  template: `
    <app-page-header title="Audit & Integrasi" subtitle="Jejak audit append-only berantai hash, tinjauan akses darurat, dan monitor antrean integrasi SATUSEHAT/BPJS." />
    <div class="tabs mb-4">
      @if (auth.can('audit.read')) {
        <button class="tab" [class.tab-active]="tab() === 'audit'" (click)="select('audit')">Jejak audit</button>
        <button class="tab" [class.tab-active]="tab() === 'bg'" (click)="select('bg')">Akses darurat</button>
      }
      @if (auth.can('integration.manage')) { <button class="tab" [class.tab-active]="tab() === 'outbox'" (click)="select('outbox')">Integrasi</button> }
    </div>

    @switch (tab()) {
      @case ('audit') {
        <div class="flex flex-wrap gap-2 mb-3 items-center">
          <input class="input w-56" [(ngModel)]="resourceType" placeholder="Resource (Patient, Encounter…)" />
          <input class="input w-80" [(ngModel)]="patientId" placeholder="ID pasien" />
          <button class="btn" (click)="loadAudit()">Filter</button>
          <button class="btn" (click)="verify()">Verifikasi integritas rantai</button>
          @if (chain(); as c) { <span class="badge" [class]="c.valid ? 'badge-success' : 'badge-critical'">{{ c.valid ? '✓ Utuh' : '✗ Rusak di #' + c.brokenAtSeq }} ({{ c.checked }} event)</span> }
        </div>
        <div class="card overflow-x-auto">
          <table class="tbl">
            <thead><tr><th>#</th><th>Waktu</th><th>Pengguna</th><th>Aksi</th><th>Resource</th><th>Pasien</th><th>Alasan</th><th>Hash</th></tr></thead>
            <tbody>@for (a of audit(); track a.seq) {
              <tr [class.bg-warning-soft]="a.action === 'BREAK_GLASS'">
                <td>{{ a.seq }}</td><td class="whitespace-nowrap">{{ a.at | dt }}</td><td>{{ a.actorName }}</td><td>{{ a.action }}</td>
                <td>{{ a.resourceType }}<div class="muted">{{ a.resourceId }}</div></td><td class="muted">{{ a.patientId?.slice(0, 8) }}</td><td>{{ a.reason }}</td><td class="muted tabular-nums">{{ a.hash.slice(0, 10) }}</td>
              </tr>
            }</tbody>
          </table>
        </div>
      }
      @case ('bg') {
        <div class="card overflow-x-auto">
          <table class="tbl">
            <thead><tr><th>Waktu</th><th>Pengguna</th><th>Pasien</th><th>Alasan</th><th>Berlaku s.d.</th><th>Tinjauan</th></tr></thead>
            <tbody>@for (b of breakGlass(); track b.id) {
              <tr>
                <td>{{ b.createdAt | dt }}</td><td>{{ b.userName }}</td><td>{{ b.patientName }}</td><td class="max-w-sm">{{ b.reason }}</td><td>{{ b.expiresAt | dt }}</td>
                <td>@if (b.reviewedAt) { <span class="badge badge-success">Ditinjau</span> <div class="muted">{{ b.reviewNote }}</div> }
                  @else if (auth.can('breakglass.review')) { <div class="flex gap-1"><input class="input w-48" [(ngModel)]="notes[b.id]" placeholder="Hasil tinjauan" /><button class="btn btn-sm" (click)="review(b.id)">Simpan</button></div> }
                  @else { <span class="badge badge-warning">Menunggu</span> }</td>
              </tr>
            } @empty { <tr><td colspan="6"><app-empty text="Tidak ada akses darurat" /></td></tr> }</tbody>
          </table>
        </div>
      }
      @case ('outbox') {
        @if (status(); as s) {
          <div class="flex flex-wrap gap-2 mb-3 items-center">
            <span class="badge badge-info">SATUSEHAT: {{ s.satusehatMode }}</span><span class="badge badge-info">BPJS: {{ s.bpjsMode }}</span>
            @for (o of s.outbox; track o.target + o.status) { <span class="badge badge-neutral">{{ o.target }} · {{ o.status }}: {{ o.count }}</span> }
            <select class="input w-40" [(ngModel)]="outStatus" (ngModelChange)="loadOutbox()"><option value="">Semua</option><option>PENDING</option><option>SENT</option><option>FAILED</option><option>DEAD</option></select>
            <button class="btn btn-primary" (click)="process()">Proses antrean sekarang</button>
          </div>
          @if (s.satusehatMode === 'mock') { <div class="alert alert-warning mb-3">Mode simulasi: tidak ada data yang dikirim ke SATUSEHAT/BPJS. Aktifkan mode sandbox/production setelah registrasi organisasi & kredensial resmi tersedia.</div> }
        }
        <div class="card overflow-x-auto">
          <table class="tbl">
            <thead><tr><th>Dibuat</th><th>Target</th><th>Resource</th><th>Operasi</th><th>Status</th><th class="num">Percobaan</th><th>ID eksternal / error</th><th></th></tr></thead>
            <tbody>@for (m of outbox(); track m.id) {
              <tr><td>{{ m.createdAt | dt }}</td><td>{{ m.target }}</td><td>{{ m.resourceType }}</td><td>{{ m.operation }}</td><td><app-status [value]="m.status" /></td><td class="num">{{ m.attempts }}</td>
                <td class="max-w-sm text-xs">{{ m.externalId }} <span class="text-critical">{{ m.lastError }}</span></td>
                <td>@if (m.status === 'FAILED' || m.status === 'DEAD') { <button class="btn btn-sm" (click)="replay(m.id)">Kirim ulang</button> }</td></tr>
            } @empty { <tr><td colspan="8"><app-empty /></td></tr> }</tbody>
          </table>
        </div>
      }
    }
  `,
})
export class GovernancePage implements OnInit {
  readonly auth = inject(AuthService);
  private readonly api = inject(Api);
  private readonly toasts = inject(Toasts);
  readonly tab = signal('audit');
  readonly audit = signal<any[]>([]);
  readonly chain = signal<any>(null);
  readonly breakGlass = signal<any[]>([]);
  readonly outbox = signal<any[]>([]);
  readonly status = signal<any>(null);
  resourceType = '';
  patientId = '';
  outStatus = '';
  notes: Record<string, string> = {};

  async ngOnInit() {
    await this.select(this.auth.can('audit.read') ? 'audit' : 'outbox');
  }

  async select(t: string) {
    this.tab.set(t);
    try {
      if (t === 'audit') await this.loadAudit();
      if (t === 'bg') this.breakGlass.set(await this.api.get('/auth/break-glass'));
      if (t === 'outbox') {
        this.status.set(await this.api.get('/integration/status'));
        await this.loadOutbox();
      }
    } catch (e) {
      this.toasts.error(e);
    }
  }

  async loadAudit() {
    this.audit.set(await this.api.get('/audit', { resourceType: this.resourceType, patientId: this.patientId, limit: 200 }));
  }

  async verify() {
    this.chain.set(await this.api.get('/audit/verify'));
  }

  async review(id: string) {
    try {
      await this.api.post(`/auth/break-glass/${id}/review`, { note: this.notes[id] ?? '' });
      await this.select('bg');
    } catch (e) {
      this.toasts.error(e);
    }
  }

  async loadOutbox() {
    this.outbox.set(await this.api.get('/integration/outbox', { status: this.outStatus }));
  }

  async process() {
    const r = await this.api.post('/integration/outbox/process');
    this.toasts.success(`Diproses ${r.processed}: terkirim ${r.sent}, gagal ${r.failed}`);
    await this.select('outbox');
  }

  async replay(id: string) {
    await this.api.post(`/integration/outbox/${id}/replay`);
    await this.loadOutbox();
  }
}
