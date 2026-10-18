import { Global, Inject, Injectable, Module, OnApplicationShutdown } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { eq } from 'drizzle-orm';
import { getConfig, type AppConfig } from '../config.js';
import { createDatabase, DB, type Db, type DatabaseHandle } from '../database/database.js';
import { facilities } from '../database/schema.js';
import { notFound } from '../common/errors.js';
import { todayIn } from '../common/util.js';
import { APP_CONFIG, DATABASE_HANDLE } from './tokens.js';
import { AuditService } from './audit.service.js';
import { CryptoService } from './crypto.service.js';
import { SequenceService } from './sequence.service.js';
import { CareAccessService } from './care-access.service.js';

/** Info fasilitas (tenant) yang sering dipakai: zona waktu, kode BPJS/SATUSEHAT. */
@Injectable()
export class FacilityService {
  private cache = new Map<string, typeof facilities.$inferSelect>();
  constructor(@Inject(DB) private readonly db: Db) {}

  async get(facilityId: string) {
    const hit = this.cache.get(facilityId);
    if (hit) return hit;
    const [f] = await this.db.select().from(facilities).where(eq(facilities.id, facilityId));
    if (!f) throw notFound('Fasilitas', facilityId);
    this.cache.set(facilityId, f);
    return f;
  }

  invalidate(facilityId: string) {
    this.cache.delete(facilityId);
  }

  async today(facilityId: string) {
    return todayIn((await this.get(facilityId)).timezone);
  }
}

@Injectable()
class DatabaseLifecycle implements OnApplicationShutdown {
  constructor(@Inject(DATABASE_HANDLE) private readonly handle: DatabaseHandle) {}
  async onApplicationShutdown() {
    await this.handle.close();
  }
}

@Global()
@Module({
  imports: [
    JwtModule.registerAsync({
      global: true,
      useFactory: () => {
        const c = getConfig();
        return { secret: c.jwtSecret, signOptions: { expiresIn: c.jwtExpiresIn as unknown as number } };
      },
    }),
  ],
  providers: [
    { provide: APP_CONFIG, useFactory: () => getConfig() },
    { provide: DATABASE_HANDLE, useFactory: (c: AppConfig) => createDatabase(c), inject: [APP_CONFIG] },
    { provide: DB, useFactory: (h: DatabaseHandle) => h.db, inject: [DATABASE_HANDLE] },
    DatabaseLifecycle,
    AuditService,
    CryptoService,
    SequenceService,
    CareAccessService,
    FacilityService,
  ],
  exports: [APP_CONFIG, DB, DATABASE_HANDLE, AuditService, CryptoService, SequenceService, CareAccessService, FacilityService],
})
export class CoreModule {}
