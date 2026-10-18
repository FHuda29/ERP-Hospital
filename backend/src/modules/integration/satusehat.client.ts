import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { APP_CONFIG } from '../../core/tokens.js';
import type { AppConfig } from '../../config.js';
import type { FhirResource } from './fhir.mapper.js';

/**
 * Klien SATUSEHAT (FHIR R4). Mode:
 * - mock: tidak ada panggilan jaringan; ID eksternal disimulasikan (untuk dev/UAT tanpa kredensial).
 * - sandbox/production: OAuth2 client_credentials + REST FHIR.
 * Integrasi tidak boleh dianggap aktif tanpa registrasi organisasi & kredensial resmi.
 */
@Injectable()
export class SatusehatClient {
  private readonly logger = new Logger('SATUSEHAT');
  private token: { value: string; expiresAt: number } | null = null;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  get mode() {
    return this.config.satusehat.mode;
  }

  /** Cari IHS Number pasien berdasarkan NIK. */
  async findPatientIdByNik(nik: string): Promise<string | null> {
    if (this.mode === 'mock') {
      return 'P' + BigInt('0x' + createHash('sha256').update(nik).digest('hex').slice(0, 12)).toString().padStart(11, '0').slice(0, 11);
    }
    const res = await this.request('GET', `/Patient?identifier=${encodeURIComponent(`https://fhir.kemkes.go.id/id/nik|${nik}`)}`);
    return res?.entry?.[0]?.resource?.id ?? null;
  }

  async create(resource: FhirResource): Promise<string> {
    if (this.mode === 'mock') return `mock-${resource.resourceType.toLowerCase()}-${randomUUID()}`;
    const res = await this.request('POST', `/${resource.resourceType}`, resource);
    if (!res?.id) throw new Error(`SATUSEHAT tidak mengembalikan id untuk ${resource.resourceType}`);
    return res.id;
  }

  async update(resource: FhirResource & { id: string }): Promise<string> {
    if (this.mode === 'mock') return resource.id;
    const res = await this.request('PUT', `/${resource.resourceType}/${resource.id}`, resource);
    return res?.id ?? resource.id;
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;
    const { authUrl, clientId, clientSecret } = this.config.satusehat;
    if (!clientId || !clientSecret) throw new Error('Kredensial SATUSEHAT belum dikonfigurasi');
    const res = await fetch(`${authUrl}/accesstoken?grant_type=client_credentials`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Autentikasi SATUSEHAT gagal: HTTP ${res.status}`);
    const json = (await res.json()) as { access_token: string; expires_in: string | number };
    this.token = { value: json.access_token, expiresAt: Date.now() + Number(json.expires_in) * 1000 };
    return this.token.value;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async request(method: string, path: string, body?: unknown): Promise<any> {
    const res = await fetch(`${this.config.satusehat.baseUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${await this.accessToken()}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    if (!res.ok) {
      // Log status saja — respons bisa memuat PHI
      this.logger.warn(`${method} ${path.split('?')[0]} → HTTP ${res.status}`);
      throw new Error(`SATUSEHAT HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    return text ? JSON.parse(text) : null;
  }
}
