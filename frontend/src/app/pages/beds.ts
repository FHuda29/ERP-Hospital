import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Api, AuthService } from '../core/api';
import { PIPES, STATUS, Toasts } from '../core/ui';
import { SHARED } from '../shared/components';

@Component({
  selector: 'app-beds',
  imports: [RouterLink, ...SHARED, ...PIPES],
  template: `
    <app-page-header title="Manajemen Tempat Tidur" subtitle="Status real-time per bangsal & kelas (termasuk KRIS). Bed kosong setelah pulang berstatus 'Dibersihkan' sampai dinyatakan siap.">
      <button class="btn" (click)="load()">Muat ulang</button>
    </app-page-header>
    <div class="flex flex-wrap gap-2 mb-4">
      @for (s of summary(); track s.status) { <span class="badge" [class]="'badge-' + s.tone">{{ s.label }}: {{ s.count }}</span> }
    </div>
    @for (u of grouped(); track u.unit) {
      <div class="card card-pad mb-4">
        <h2 class="h2 mb-3">{{ u.unit }}</h2>
        @for (r of u.rooms; track r.room) {
          <div class="mb-3">
            <div class="text-sm font-medium mb-1.5">{{ r.room }} <span class="badge badge-neutral">{{ r.careClass }}</span></div>
            <div class="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-2">
              @for (b of r.beds; track b.bedId) {
                <div class="rounded-md border p-2 text-sm" [class]="tone(b.status)">
                  <div class="flex justify-between items-center"><b>{{ b.bedCode }}</b><app-status [value]="b.status" /></div>
                  @if (b.encounterId) {
                    <a class="text-xs underline" [routerLink]="['/encounters', b.encounterId]">Lihat pasien</a>
                  } @else if (auth.can('bed.manage')) {
                    <div class="flex gap-1 mt-1.5">
                      @if (b.status !== 'AVAILABLE') { <button class="btn btn-sm" (click)="set(b, 'AVAILABLE')">Siap</button> }
                      @if (b.status === 'AVAILABLE') { <button class="btn btn-sm" (click)="set(b, 'MAINTENANCE')">Perbaikan</button> }
                    </div>
                  }
                </div>
              }
            </div>
          </div>
        }
      </div>
    }
  `,
})
export class BedsPage implements OnInit {
  readonly auth = inject(AuthService);
  private readonly api = inject(Api);
  private readonly toasts = inject(Toasts);
  readonly beds = signal<any[]>([]);

  readonly summary = computed(() => {
    const m = new Map<string, number>();
    for (const b of this.beds()) m.set(b.status, (m.get(b.status) ?? 0) + 1);
    return [...m].map(([status, count]) => ({ status, count, ...STATUS[status] }));
  });

  readonly grouped = computed(() => {
    const units = new Map<string, Map<string, any>>();
    for (const b of this.beds()) {
      if (!units.has(b.unitName)) units.set(b.unitName, new Map());
      const rooms = units.get(b.unitName)!;
      if (!rooms.has(b.roomName)) rooms.set(b.roomName, { room: b.roomName, careClass: b.careClass, beds: [] });
      rooms.get(b.roomName).beds.push(b);
    }
    return [...units].map(([unit, rooms]) => ({ unit, rooms: [...rooms.values()] }));
  });

  tone(s: string) {
    return { AVAILABLE: 'border-success/40 bg-success-soft', OCCUPIED: 'border-primary/40 bg-primary-soft', CLEANING: 'border-warning/40 bg-warning-soft', MAINTENANCE: 'border-line bg-canvas' }[s] ?? '';
  }

  async ngOnInit() {
    await this.load();
  }

  async load() {
    this.beds.set(await this.api.get('/master/bed-board'));
  }

  async set(b: any, status: string) {
    try {
      await this.api.post(`/beds/${b.bedId}/status`, { status });
      await this.load();
    } catch (e) {
      this.toasts.error(e);
    }
  }
}
