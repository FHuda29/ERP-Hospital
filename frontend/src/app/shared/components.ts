import { Component, computed, input, output } from '@angular/core';
import { RouterLink } from '@angular/router';
import { AgePipe, DPipe, MrnPipe, STATUS, TRIAGE } from '../core/ui';

/** Badge status: warna + teks (warna tidak pernah satu-satunya penanda). */
@Component({
  selector: 'app-status',
  template: `<span class="badge" [class]="'badge-' + meta().tone">{{ meta().label }}</span>`,
})
export class StatusBadge {
  readonly value = input.required<string>();
  readonly meta = computed(() => STATUS[this.value()] ?? { label: this.value(), tone: 'neutral' });
}

@Component({
  selector: 'app-triage',
  template: `@if (level()) {
    <span class="badge" [class]="'badge-' + meta().tone"><span aria-hidden="true">●</span> {{ meta().label }}</span>
  }`,
})
export class TriageBadge {
  readonly level = input<number | null>();
  readonly meta = computed(() => TRIAGE[this.level() ?? 5] ?? TRIAGE[5]);
}

@Component({
  selector: 'app-page-header',
  template: `
    <div class="flex flex-wrap items-end justify-between gap-3 mb-4">
      <div>
        <h1 class="h1">{{ title() }}</h1>
        @if (subtitle()) {
          <p class="text-ink-3 text-sm mt-0.5">{{ subtitle() }}</p>
        }
      </div>
      <div class="flex flex-wrap gap-2"><ng-content /></div>
    </div>
  `,
})
export class PageHeader {
  readonly title = input.required<string>();
  readonly subtitle = input<string>();
}

@Component({
  selector: 'app-empty',
  template: `<div class="text-center text-ink-3 py-10 text-sm">{{ text() }}</div>`,
})
export class Empty {
  readonly text = input('Belum ada data');
}

@Component({
  selector: 'app-modal',
  template: `
    <div class="fixed inset-0 z-40 bg-ink/40 flex items-start justify-center p-4 overflow-y-auto" (click)="closed.emit()">
      <div
        class="card w-full mt-10 shadow-xl"
        [style.max-width.px]="width()"
        role="dialog"
        aria-modal="true"
        [attr.aria-label]="title()"
        (click)="$event.stopPropagation()"
      >
        <div class="flex items-center justify-between px-4 py-3 border-b border-line">
          <h2 class="h2">{{ title() }}</h2>
          <button class="btn btn-sm btn-ghost" (click)="closed.emit()" aria-label="Tutup">✕</button>
        </div>
        <div class="p-4"><ng-content /></div>
      </div>
    </div>
  `,
})
export class Modal {
  readonly title = input.required<string>();
  readonly width = input(640);
  readonly closed = output<void>();
}

/**
 * Patient banner (Blueprint §7.2): minimal dua identitas (nama + No. RM + tgl lahir),
 * alergi & alert keselamatan tampil menonjol.
 */
@Component({
  selector: 'app-patient-banner',
  imports: [AgePipe, DPipe, MrnPipe, RouterLink, StatusBadge, TriageBadge],
  template: `
    @if (patient(); as p) {
      <section class="card px-4 py-3 mb-4 border-l-4" [class.border-l-critical]="allergies().length" [class.border-l-primary]="!allergies().length" aria-label="Identitas pasien">
        <div class="flex flex-wrap items-center gap-x-6 gap-y-2">
          <div class="flex items-center gap-3">
            <div class="size-10 rounded-full bg-primary-soft text-primary font-semibold grid place-items-center" aria-hidden="true">{{ p.gender === 'L' ? '♂' : '♀' }}</div>
            <div>
              <a class="font-semibold text-base hover:underline" [routerLink]="['/patients', p.id]">{{ p.name }}</a>
              <div class="text-xs text-ink-2">
                RM <b class="tabular-nums">{{ p.mrn | mrn }}</b> · {{ p.gender === 'L' ? 'Laki-laki' : 'Perempuan' }} · Lahir {{ p.birthDate | d }} ({{ p.birthDate | age }})
              </div>
            </div>
          </div>
          @if (encounter(); as e) {
            <div class="text-xs text-ink-2 leading-5">
              <div><b class="text-ink">{{ e.encounterNo }}</b> · {{ e.unit?.name }} @if (e.bed) { · Bed {{ e.bed.code }} ({{ e.bed.careClass }}) }</div>
              <div>DPJP: {{ e.practitioner?.name ?? '—' }} · {{ e.payer?.name }} @if (e.sepNumber) { · SEP {{ e.sepNumber }} }</div>
            </div>
            <div class="flex gap-2 items-center"><app-status [value]="e.status" /><app-triage [level]="e.triageLevel" /></div>
          }
          <div class="ml-auto">
            @if (allergies().length) {
              <div class="alert alert-critical py-1.5 font-medium" role="alert">
                ⚠ ALERGI: @for (a of allergies(); track a.id) { <span>{{ a.substance }} ({{ a.severity }})@if (!$last) {, }</span> }
              </div>
            } @else {
              <span class="badge badge-neutral">Tidak ada alergi tercatat</span>
            }
          </div>
        </div>
        @if (accessBasis() === 'BREAK_GLASS') {
          <div class="alert alert-warning mt-2 text-xs">Akses darurat (break-glass) aktif — seluruh aktivitas Anda tercatat dan akan ditinjau.</div>
        }
      </section>
    }
  `,
})
export class PatientBanner {
  readonly patient = input<any>();
  readonly encounter = input<any>();
  readonly allergies = input<any[]>([]);
  readonly accessBasis = input<string | null>(null);
}

export const SHARED = [StatusBadge, TriageBadge, PageHeader, Empty, Modal, PatientBanner];
