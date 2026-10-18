import { Inject, Injectable } from '@nestjs/common';
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { APP_CONFIG } from './tokens.js';
import type { AppConfig } from '../config.js';

/**
 * Enkripsi field data pribadi spesifik (UU 27/2022 PDP) — AES-256-GCM.
 * Format: v1.<iv>.<tag>.<ciphertext> (base64url). Hash HMAC untuk pencarian deterministik.
 */
@Injectable()
export class CryptoService {
  private readonly key: Buffer;
  private readonly hmacKey: Buffer;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.key = config.encryptionKey;
    this.hmacKey = createHmac('sha256', config.encryptionKey).update('lookup-hash').digest();
  }

  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return ['v1', iv.toString('base64url'), tag.toString('base64url'), enc.toString('base64url')].join('.');
  }

  decrypt(payload: string): string {
    const [v, iv, tag, data] = payload.split('.');
    if (v !== 'v1') throw new Error('Format ciphertext tidak dikenal');
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
  }

  lookupHash(value: string): string {
    return createHmac('sha256', this.hmacKey).update(value.trim()).digest('hex');
  }

  /** 3201************1234 */
  static maskNik(nik: string): string {
    return nik.length < 8 ? '****' : nik.slice(0, 4) + '*'.repeat(nik.length - 8) + nik.slice(-4);
  }
}
