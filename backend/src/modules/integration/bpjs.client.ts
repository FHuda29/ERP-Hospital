import { Inject, Injectable } from '@nestjs/common';
import { createDecipheriv, createHash, createHmac } from 'node:crypto';
import LZString from 'lz-string';
import { APP_CONFIG } from '../../core/tokens.js';
import type { AppConfig } from '../../config.js';

export interface PesertaInfo {
  noKartu: string;
  nama: string;
  statusPeserta: string;
  aktif: boolean;
  hakKelas: string;
  jenisPeserta: string;
  provUmum?: string;
}

export interface SepRequest {
  noKartu: string;
  tglSep: string;
  ppkPelayanan: string;
  /** 1 = rawat inap, 2 = rawat jalan */
  jnsPelayanan: '1' | '2';
  klsRawatHak: string;
  noMR: string;
  noRujukan?: string;
  diagAwal: string;
  poliTujuan?: string;
  dpjpLayan?: string;
  noTelp?: string;
  user: string;
}

/**
 * Klien BPJS Kesehatan VClaim.
 * Signature: HMAC-SHA256(consId & timestamp, secretKey) base64; respons dienkripsi
 * AES-256-CBC (key = SHA256(consId+secretKey+timestamp)) lalu LZ-string.
 * Endpoint & struktur payload WAJIB diverifikasi terhadap katalog VClaim versi yang berlaku
 * dan hanya dipakai setelah ada perjanjian kerja sama & kredensial resmi.
 */
@Injectable()
export class BpjsClient {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  get mode() {
    return this.config.bpjs.mode;
  }

  async peserta(noKartu: string, tglSep: string): Promise<PesertaInfo> {
    if (this.mode === 'mock') {
      // Simulasi: kartu berakhiran 0 dianggap nonaktif (untuk uji skenario penolakan)
      const aktif = !noKartu.endsWith('0');
      return {
        noKartu,
        nama: 'PESERTA SIMULASI',
        statusPeserta: aktif ? 'AKTIF' : 'TIDAK AKTIF (TUNGGAKAN)',
        aktif,
        hakKelas: ['KELAS_1', 'KELAS_2', 'KELAS_3'][Number(noKartu.slice(-1)) % 3],
        jenisPeserta: 'PBI (APBN)',
      };
    }
    const res = await this.request('GET', `/Peserta/nokartu/${noKartu}/tglSEP/${tglSep}`);
    const p = res.peserta;
    return {
      noKartu: p.noKartu,
      nama: p.nama,
      statusPeserta: p.statusPeserta?.keterangan,
      aktif: p.statusPeserta?.kode === '0',
      hakKelas: `KELAS_${p.hakKelas?.kode}`,
      jenisPeserta: p.jenisPeserta?.keterangan,
      provUmum: p.provUmum?.nmProvider,
    };
  }

  async createSep(req: SepRequest): Promise<string> {
    if (this.mode === 'mock') {
      const rand = Math.floor(Math.random() * 1e6).toString().padStart(6, '0');
      return `${req.ppkPelayanan.slice(0, 8).padEnd(8, '0')}${req.tglSep.slice(5, 7)}${req.tglSep.slice(2, 4)}V${rand}`;
    }
    const body = {
      request: {
        t_sep: {
          noKartu: req.noKartu,
          tglSep: req.tglSep,
          ppkPelayanan: req.ppkPelayanan,
          jnsPelayanan: req.jnsPelayanan,
          klsRawat: { klsRawatHak: req.klsRawatHak.replace('KELAS_', ''), klsRawatNaik: '', pembiayaan: '', penanggungJawab: '' },
          noMR: req.noMR,
          rujukan: { asalRujukan: '1', tglRujukan: req.tglSep, noRujukan: req.noRujukan ?? '', ppkRujukan: '' },
          catatan: '',
          diagAwal: req.diagAwal,
          poli: { tujuan: req.poliTujuan ?? '', eksekutif: '0' },
          cob: { cob: '0' },
          katarak: { katarak: '0' },
          jaminan: { lakaLantas: '0', noLP: '', penjamin: { tglKejadian: '', keterangan: '', suplesi: { suplesi: '0', noSepSuplesi: '', lokasiLaka: { kdPropinsi: '', kdKabupaten: '', kdKecamatan: '' } } } },
          tujuanKunj: '0',
          flagProcedure: '',
          kdPenunjang: '',
          assesmentPel: '',
          skdp: { noSurat: '', kodeDPJP: '' },
          dpjpLayan: req.dpjpLayan ?? '',
          noTelp: req.noTelp ?? '',
          user: req.user,
        },
      },
    };
    const res = await this.request('POST', '/SEP/2.0/insert', body);
    return res.sep.noSep;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async request(method: string, path: string, body?: unknown): Promise<any> {
    const { consId, secretKey, userKey, vclaimBaseUrl } = this.config.bpjs;
    if (!consId || !secretKey || !userKey) throw new Error('Kredensial BPJS VClaim belum dikonfigurasi');
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = createHmac('sha256', secretKey).update(`${consId}&${timestamp}`).digest('base64');
    const res = await fetch(`${vclaimBaseUrl}${path}`, {
      method,
      headers: {
        'X-cons-id': consId,
        'X-timestamp': timestamp,
        'X-signature': signature,
        user_key: userKey,
        'Content-Type': 'Application/x-www-form-urlencoded',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`BPJS HTTP ${res.status}`);
    const json = (await res.json()) as { metaData: { code: string; message: string }; response: string | null };
    if (json.metaData.code !== '200') throw new Error(`BPJS ${json.metaData.code}: ${json.metaData.message}`);
    if (!json.response) return null;
    return JSON.parse(BpjsClient.decrypt(json.response, consId + secretKey + timestamp));
  }

  static decrypt(payload: string, keySeed: string): string {
    const key = createHash('sha256').update(keySeed, 'utf8').digest();
    const decipher = createDecipheriv('aes-256-cbc', key, key.subarray(0, 16));
    const decrypted = Buffer.concat([decipher.update(Buffer.from(payload, 'base64')), decipher.final()]).toString('utf8');
    return LZString.decompressFromEncodedURIComponent(decrypted) ?? '';
  }
}
