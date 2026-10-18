import { HttpClient, HttpErrorResponse, HttpHeaders, HttpInterceptorFn, HttpParams } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { catchError, firstValueFrom, throwError } from 'rxjs';

export const API_BASE = '/api/v1';

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly details?: any,
  ) {
    super(message);
  }
}

export interface Me {
  id: string;
  username: string;
  name: string;
  facilityId: string;
  roles: string[];
  unitId: string | null;
  practitionerId: string | null;
  permissions: string[];
  facility: { id: string; code: string; name: string; type: string; timezone: string; features: Record<string, boolean> };
}

const TOKEN_KEY = 'simrs.token';
const USER_KEY = 'simrs.user';

/** Sesi disimpan di sessionStorage: tertutup saat tab ditutup (workstation bersama di RS). */
@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly router = inject(Router);
  readonly user = signal<Me | null>(this.restore());

  get token(): string | null {
    try {
      return sessionStorage.getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  }

  private restore(): Me | null {
    try {
      const raw = sessionStorage.getItem(USER_KEY);
      return raw ? (JSON.parse(raw) as Me) : null;
    } catch {
      return null;
    }
  }

  setSession(token: string, user: Me) {
    sessionStorage.setItem(TOKEN_KEY, token);
    sessionStorage.setItem(USER_KEY, JSON.stringify(user));
    this.user.set(user);
  }

  logout(redirect = true) {
    sessionStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(USER_KEY);
    this.user.set(null);
    if (redirect) void this.router.navigate(['/login']);
  }

  can(...perms: string[]): boolean {
    const p = this.user()?.permissions ?? [];
    return p.includes('*') || perms.some((x) => p.includes(x));
  }

  hasRole(...roles: string[]): boolean {
    return roles.some((r) => this.user()?.roles.includes(r));
  }
}

export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const auth = inject(AuthService);
  const token = auth.token;
  const authed = token ? req.clone({ setHeaders: { Authorization: `Bearer ${token}` } }) : req;
  return next(authed).pipe(
    catchError((err: HttpErrorResponse) => {
      if (err.status === 401 && !req.url.endsWith('/auth/login')) auth.logout();
      const e = err.error?.error;
      return throwError(() => new ApiError(e?.code ?? 'NETWORK_ERROR', e?.message ?? 'Tidak dapat terhubung ke server', err.status, e?.details));
    }),
  );
};

/** Klien API berbasis Promise — cocok dipakai bersama signals. */
@Injectable({ providedIn: 'root' })
export class Api {
  private readonly http = inject(HttpClient);

  get<T = any>(path: string, params?: Record<string, string | number | boolean | undefined | null>): Promise<T> {
    let hp = new HttpParams();
    for (const [k, v] of Object.entries(params ?? {})) if (v !== undefined && v !== null && v !== '') hp = hp.set(k, String(v));
    return firstValueFrom(this.http.get<T>(API_BASE + path, { params: hp }));
  }

  /** Setiap mutasi membawa Idempotency-Key — aman di-retry tanpa transaksi ganda. */
  post<T = any>(path: string, body: unknown = {}): Promise<T> {
    const headers = new HttpHeaders({ 'Idempotency-Key': crypto.randomUUID() });
    return firstValueFrom(this.http.post<T>(API_BASE + path, body, { headers }));
  }

  patch<T = any>(path: string, body: unknown = {}): Promise<T> {
    return firstValueFrom(this.http.patch<T>(API_BASE + path, body));
  }
}
