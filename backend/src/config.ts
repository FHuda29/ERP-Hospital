import { createHash } from 'node:crypto';

/**
 * Konfigurasi dibaca dari environment saat dipanggil (bukan saat import)
 * supaya test dapat mengatur env sebelum aplikasi dibuat.
 */
export function getConfig() {
  const env = process.env;
  const isProd = env.NODE_ENV === 'production';

  const jwtSecret = env.JWT_SECRET ?? (isProd ? undefined : 'dev-only-jwt-secret-change-me');
  if (!jwtSecret) throw new Error('JWT_SECRET wajib diisi pada production');

  // Kunci enkripsi data pribadi (NIK). Production wajib 32 byte base64 dari KMS/secret manager.
  let encryptionKey: Buffer;
  if (env.DATA_ENCRYPTION_KEY) {
    encryptionKey = Buffer.from(env.DATA_ENCRYPTION_KEY, 'base64');
    if (encryptionKey.length !== 32) throw new Error('DATA_ENCRYPTION_KEY harus 32 byte (base64)');
  } else if (isProd) {
    throw new Error('DATA_ENCRYPTION_KEY wajib diisi pada production');
  } else {
    encryptionKey = createHash('sha256').update('dev-only-encryption-key').digest();
  }

  return {
    isProd,
    port: Number(env.PORT ?? 3000),
    /** Bila kosong, memakai PostgreSQL embedded (PGlite) — hanya untuk dev/test. */
    databaseUrl: env.DATABASE_URL,
    /** Direktori data PGlite; 'memory' untuk in-memory. */
    pgliteDir: env.PGLITE_DIR ?? './data/pglite',
    jwtSecret,
    jwtExpiresIn: env.JWT_EXPIRES_IN ?? '8h',
    encryptionKey,
    seedDemo: env.SEED_DEMO ? env.SEED_DEMO === 'true' : !isProd,
    outboxWorker: env.OUTBOX_WORKER !== 'false',
    corsOrigin: env.CORS_ORIGIN ?? 'http://localhost:4200',
    breakGlassMinutes: Number(env.BREAK_GLASS_MINUTES ?? 60),
    satusehat: {
      /** mock | sandbox | production */
      mode: env.SATUSEHAT_MODE ?? 'mock',
      authUrl: env.SATUSEHAT_AUTH_URL ?? 'https://api-satusehat-stg.dto.kemkes.go.id/oauth2/v1',
      baseUrl: env.SATUSEHAT_BASE_URL ?? 'https://api-satusehat-stg.dto.kemkes.go.id/fhir-r4/v1',
      clientId: env.SATUSEHAT_CLIENT_ID ?? '',
      clientSecret: env.SATUSEHAT_CLIENT_SECRET ?? '',
    },
    bpjs: {
      /** mock | live */
      mode: env.BPJS_MODE ?? 'mock',
      vclaimBaseUrl: env.BPJS_VCLAIM_URL ?? 'https://apijkn-dev.bpjs-kesehatan.go.id/vclaim-rest-dev',
      consId: env.BPJS_CONS_ID ?? '',
      secretKey: env.BPJS_SECRET_KEY ?? '',
      userKey: env.BPJS_USER_KEY ?? '',
    },
  };
}

export type AppConfig = ReturnType<typeof getConfig>;
