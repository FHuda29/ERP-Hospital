import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { Api, AuthService, type Me } from '../core/api';
import { setFacilityTimezone } from '../core/ui';

@Component({
  selector: 'app-login',
  imports: [FormsModule],
  template: `
    <div class="min-h-screen grid lg:grid-cols-2">
      <div class="hidden lg:flex flex-col justify-between bg-primary text-white p-10">
        <div class="flex items-center gap-2 font-semibold"><span class="size-8 rounded-md bg-white text-primary grid place-items-center font-bold">+</span> SIMRS Terpadu</div>
        <div>
          <h1 class="text-2xl font-semibold leading-tight mb-3">Sistem Informasi Manajemen Rumah Sakit &amp; ERP</h1>
          <p class="text-white/80 max-w-md">Satu sumber data untuk perjalanan pasien, layanan klinis, pendapatan, sumber daya, dan analitik — dengan audit menyeluruh.</p>
          <ul class="mt-6 space-y-1 text-sm text-white/80">
            <li>• RME sesuai Permenkes 24/2022 · integrasi SATUSEHAT (FHIR R4)</li>
            <li>• Bridging BPJS Kesehatan (VClaim/SEP) · klaim INA-CBG</li>
            <li>• Pelindungan data pribadi (UU 27/2022): enkripsi NIK, audit, break-glass</li>
          </ul>
        </div>
        <div class="text-xs text-white/60">Hanya untuk pengguna berwenang. Seluruh akses dicatat.</div>
      </div>
      <div class="flex items-center justify-center p-6">
        <form class="card card-pad w-full max-w-sm space-y-4" (ngSubmit)="submit()">
          <div>
            <h2 class="h1">Masuk</h2>
            <p class="muted">Gunakan akun yang diberikan unit IT rumah sakit.</p>
          </div>
          @if (error()) {
            <div class="alert alert-critical" role="alert">{{ error() }}</div>
          }
          <div class="field">
            <label class="label" for="fc">Kode fasilitas</label>
            <input id="fc" class="input uppercase" name="facilityCode" [(ngModel)]="facilityCode" required autocomplete="organization" />
          </div>
          <div class="field">
            <label class="label" for="un">Username</label>
            <input id="un" class="input" name="username" [(ngModel)]="username" required autocomplete="username" />
          </div>
          <div class="field">
            <label class="label" for="pw">Kata sandi</label>
            <input id="pw" class="input" type="password" name="password" [(ngModel)]="password" required autocomplete="current-password" />
          </div>
          <button class="btn btn-primary w-full" [disabled]="busy()">{{ busy() ? 'Memproses…' : 'Masuk' }}</button>
          @if (isLocal) {
          <details class="text-xs text-ink-3">
            <summary class="cursor-pointer">Akun demo</summary>
            <p class="mt-2">Kode <b>RSDEMO</b>, kata sandi <b>Simrs2026!</b> — username: admin, direktur, dr.andi, dr.sari, ns.budi, ns.rina, admisi, rekammedis, apoteker, lab, lab2, radiologi, kasir, casemix, keuangan, gudang, pengadaan, mutu.</p>
          </details>
          }
        </form>
      </div>
    </div>
  `,
})
export class LoginPage {
  private readonly api = inject(Api);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  facilityCode = 'RSDEMO';
  username = '';
  password = '';
  readonly busy = signal(false);
  readonly error = signal('');
  /** Petunjuk akun demo hanya tampil di lingkungan lokal, tidak di server publik. */
  readonly isLocal = ['localhost', '127.0.0.1'].includes(location.hostname);

  async submit() {
    this.busy.set(true);
    this.error.set('');
    try {
      const res = await this.api.post<{ accessToken: string; user: Me }>('/auth/login', {
        facilityCode: this.facilityCode.trim().toUpperCase(),
        username: this.username.trim(),
        password: this.password,
      });
      this.auth.setSession(res.accessToken, res.user);
      setFacilityTimezone(res.user.facility.timezone);
      await this.router.navigate(['/home']);
    } catch (e: any) {
      this.error.set(e.message);
    } finally {
      this.busy.set(false);
      this.password = '';
    }
  }
}
