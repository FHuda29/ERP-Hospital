import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { AuthService } from '../core/api';
import { Toasts, setFacilityTimezone, tzLabel } from '../core/ui';

interface MenuItem {
  label: string;
  path: string;
  icon: string;
  perms: string[];
}
interface MenuGroup {
  group: string;
  items: MenuItem[];
}

const MENU: MenuGroup[] = [
  { group: 'Utama', items: [{ label: 'Beranda', path: '/home', icon: '⌂', perms: [] }] },
  {
    group: 'Front Office',
    items: [
      { label: 'Pasien (MPI)', path: '/patients', icon: '👤', perms: ['patient.read'] },
      { label: 'Pendaftaran', path: '/registration', icon: '📝', perms: ['encounter.write'] },
      { label: 'Janji Temu', path: '/appointments', icon: '📅', perms: ['appointment.write'] },
      { label: 'Antrean', path: '/queue', icon: '🔢', perms: ['queue.manage', 'clinical.write'] },
      { label: 'Manajemen Bed', path: '/beds', icon: '🛏', perms: ['bed.manage', 'encounter.read'] },
    ],
  },
  {
    group: 'Klinis',
    items: [
      { label: 'Daftar Kunjungan', path: '/encounters', icon: '🩺', perms: ['encounter.read'] },
      { label: 'Laboratorium', path: '/ancillary/LAB', icon: '🧪', perms: ['order.process'] },
      { label: 'Radiologi', path: '/ancillary/RADIOLOGI', icon: '☢', perms: ['order.process'] },
      { label: 'Farmasi', path: '/pharmacy', icon: '💊', perms: ['rx.verify', 'rx.dispense'] },
    ],
  },
  {
    group: 'Revenue Cycle',
    items: [
      { label: 'Kasir & Billing', path: '/billing', icon: '💳', perms: ['billing.read'] },
      { label: 'Klaim Penjamin', path: '/claims', icon: '📑', perms: ['claim.read'] },
    ],
  },
  {
    group: 'ERP',
    items: [
      { label: 'Inventori', path: '/inventory', icon: '📦', perms: ['inventory.read'] },
      { label: 'Pengadaan', path: '/procurement', icon: '🛒', perms: ['procurement.read'] },
      { label: 'Keuangan & GL', path: '/finance', icon: '📊', perms: ['finance.read'] },
    ],
  },
  {
    group: 'Manajemen',
    items: [
      { label: 'Mutu & Insiden', path: '/quality', icon: '🛡', perms: ['incident.read', 'incident.write'] },
      { label: 'Master Data', path: '/master', icon: '⚙', perms: ['master.write'] },
      { label: 'Pengguna', path: '/users', icon: '🔑', perms: ['user.manage'] },
      { label: 'Audit & Integrasi', path: '/governance', icon: '🔍', perms: ['audit.read', 'integration.manage'] },
    ],
  },
];

@Component({
  selector: 'app-shell',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, FormsModule],
  template: `
    <div class="min-h-screen flex">
      <aside class="no-print w-60 shrink-0 bg-white border-r border-line flex-col hidden md:flex" [class.!flex]="menuOpen()" [class.fixed]="menuOpen()" [class.inset-y-0]="menuOpen()" [class.z-30]="menuOpen()">
        <div class="h-14 flex items-center gap-2 px-4 border-b border-line">
          <div class="size-8 rounded-md bg-primary text-white grid place-items-center font-bold" aria-hidden="true">+</div>
          <div class="leading-tight">
            <div class="font-semibold text-sm">SIMRS Terpadu</div>
            <div class="text-[11px] text-ink-3 truncate max-w-40">{{ auth.user()?.facility?.name }}</div>
          </div>
        </div>
        <nav class="flex-1 overflow-y-auto py-2" aria-label="Menu utama">
          @for (g of menu(); track g.group) {
            <div class="px-4 pt-3 pb-1 text-[11px] font-semibold uppercase tracking-wide text-ink-3">{{ g.group }}</div>
            @for (m of g.items; track m.path) {
              <a
                [routerLink]="m.path"
                routerLinkActive="bg-primary-soft text-primary font-medium"
                (click)="menuOpen.set(false)"
                class="mx-2 flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm text-ink-2 hover:bg-canvas"
              >
                <span class="w-5 text-center" aria-hidden="true">{{ m.icon }}</span>{{ m.label }}
              </a>
            }
          }
        </nav>
        <div class="p-3 border-t border-line text-xs text-ink-3">v1.0 · Zona waktu {{ tz }}</div>
      </aside>

      <div class="flex-1 min-w-0 flex flex-col">
        <header class="no-print h-14 bg-white border-b border-line flex items-center gap-3 px-4 sticky top-0 z-20">
          <button class="btn btn-sm md:hidden" (click)="menuOpen.set(!menuOpen())" aria-label="Menu">☰</button>
          <form class="flex-1 max-w-xl" (ngSubmit)="search()" role="search">
            <input class="input" name="q" [(ngModel)]="q" placeholder="Cari pasien: nama, No. RM, NIK, No. JKN  ( / )" aria-label="Cari pasien" (keydown.escape)="q = ''" id="global-search" />
          </form>
          <div class="ml-auto flex items-center gap-3">
            <div class="text-right leading-tight hidden sm:block">
              <div class="text-sm font-medium">{{ auth.user()?.name }}</div>
              <div class="text-[11px] text-ink-3">{{ auth.user()?.roles?.join(', ') }}</div>
            </div>
            <button class="btn btn-sm" (click)="auth.logout()">Keluar</button>
          </div>
        </header>
        <main class="flex-1 p-4 md:p-6 min-w-0">
          <router-outlet />
        </main>
      </div>
    </div>

    <div class="fixed bottom-4 right-4 z-50 flex flex-col gap-2 w-80" aria-live="polite">
      @for (t of toasts.items(); track t.id) {
        <div class="alert shadow-lg cursor-pointer" [class]="'alert-' + (t.kind === 'error' ? 'critical' : t.kind)" (click)="toasts.dismiss(t.id)">{{ t.text }}</div>
      }
    </div>
  `,
  host: { '(document:keydown./)': 'focusSearch($event)' },
})
export class Shell {
  readonly auth = inject(AuthService);
  readonly toasts = inject(Toasts);
  private readonly router = inject(Router);
  readonly menuOpen = signal(false);
  q = '';
  readonly tz: string;

  readonly menu = computed(() =>
    MENU.map((g) => ({ ...g, items: g.items.filter((i) => !i.perms.length || this.auth.can(...i.perms)) })).filter((g) => g.items.length),
  );

  constructor() {
    setFacilityTimezone(this.auth.user()?.facility?.timezone ?? 'Asia/Jakarta');
    this.tz = tzLabel();
  }

  search() {
    if (this.q.trim()) void this.router.navigate(['/patients'], { queryParams: { q: this.q.trim() } });
  }

  focusSearch(e: Event) {
    const t = e.target as HTMLElement;
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName)) return;
    e.preventDefault();
    document.getElementById('global-search')?.focus();
  }
}
