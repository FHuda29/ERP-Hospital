import {
  Body,
  Controller,
  Get,
  Header,
  Inject,
  Injectable,
  Logger,
  Module,
  OnApplicationShutdown,
  OnModuleInit,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { and, desc, eq, inArray, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import { DB, type Db, type DbOrTx } from '../../database/database.js';
import { diagnoses, encounters, outboxMessages, patients, vitalSigns } from '../../database/schema.js';
import { AuditResource, CurrentUser, Permissions, ReqMeta, type AuthUser, type RequestMeta } from '../../common/auth.js';
import { invalid, notFound } from '../../common/errors.js';
import { ZodPipe } from '../../common/zod.pipe.js';
import { APP_CONFIG } from '../../core/tokens.js';
import { AuditService } from '../../core/audit.service.js';
import { CareAccessService } from '../../core/care-access.service.js';
import { CryptoService } from '../../core/crypto.service.js';
import { FacilityService } from '../../core/core.module.js';
import type { AppConfig } from '../../config.js';
import { FhirMapper } from './fhir.mapper.js';
import { SatusehatClient } from './satusehat.client.js';
import { BpjsClient } from './bpjs.client.js';

const MAX_ATTEMPTS = 8;

export interface OutboxInput {
  facilityId: string;
  target: 'SATUSEHAT' | 'BPJS_VCLAIM';
  resourceType: string;
  resourceId: string;
  operation: string;
  /** Hanya referensi internal — resource FHIR dibangun saat kirim (meminimalkan PHI tersimpan). */
  payload?: Record<string, unknown>;
}

@Injectable()
export class OutboxService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** Dipanggil di dalam transaksi bisnis yang sama (transactional outbox). */
  async enqueue(tx: DbOrTx, m: OutboxInput) {
    await tx
      .insert(outboxMessages)
      .values({
        ...m,
        payload: m.payload ?? {},
        idempotencyKey: `${m.target}:${m.resourceType}:${m.operation}:${m.resourceId}`,
      })
      .onConflictDoNothing();
  }

  list(facilityId: string, status?: string) {
    const conds = [eq(outboxMessages.facilityId, facilityId)];
    if (status) conds.push(eq(outboxMessages.status, status));
    return this.db.select().from(outboxMessages).where(and(...conds)).orderBy(desc(outboxMessages.createdAt)).limit(300);
  }

  async stats(facilityId: string) {
    return this.db
      .select({ target: outboxMessages.target, status: outboxMessages.status, count: sql<number>`count(*)::int` })
      .from(outboxMessages)
      .where(eq(outboxMessages.facilityId, facilityId))
      .groupBy(outboxMessages.target, outboxMessages.status);
  }

  async replay(facilityId: string, id: string) {
    const [row] = await this.db
      .update(outboxMessages)
      .set({ status: 'PENDING', attempts: 0, nextAttemptAt: new Date(), lastError: null })
      .where(and(eq(outboxMessages.id, id), eq(outboxMessages.facilityId, facilityId), inArray(outboxMessages.status, ['FAILED', 'DEAD'])))
      .returning();
    if (!row) throw invalid('OUTBOX_NOT_REPLAYABLE', 'Pesan tidak ditemukan atau tidak dalam status gagal');
    return row;
  }
}

/** Pemroses outbox: retry dengan exponential backoff, dead-letter setelah MAX_ATTEMPTS. */
@Injectable()
export class OutboxProcessor implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger('Outbox');
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly mapper: FhirMapper,
    private readonly satusehat: SatusehatClient,
    private readonly crypto: CryptoService,
  ) {}

  onModuleInit() {
    if (this.config.outboxWorker) this.timer = setInterval(() => void this.processBatch(), 5_000);
  }

  onApplicationShutdown() {
    if (this.timer) clearInterval(this.timer);
  }

  async processBatch(limit = 20): Promise<{ processed: number; sent: number; failed: number }> {
    if (this.running) return { processed: 0, sent: 0, failed: 0 };
    this.running = true;
    let sent = 0;
    let failed = 0;
    try {
      const batch = await this.db
        .select()
        .from(outboxMessages)
        .where(and(inArray(outboxMessages.status, ['PENDING', 'FAILED']), lte(outboxMessages.nextAttemptAt, new Date())))
        .orderBy(outboxMessages.createdAt)
        .limit(limit);
      for (const msg of batch) {
        try {
          const externalId = await this.dispatch(msg);
          await this.db
            .update(outboxMessages)
            .set({ status: 'SENT', sentAt: new Date(), externalId, attempts: msg.attempts + 1, lastError: null })
            .where(eq(outboxMessages.id, msg.id));
          sent++;
        } catch (e) {
          const attempts = msg.attempts + 1;
          const backoffSec = Math.min(3600, 2 ** attempts * 5);
          await this.db
            .update(outboxMessages)
            .set({
              status: attempts >= MAX_ATTEMPTS ? 'DEAD' : 'FAILED',
              attempts,
              lastError: (e as Error).message.slice(0, 1000),
              nextAttemptAt: new Date(Date.now() + backoffSec * 1000),
            })
            .where(eq(outboxMessages.id, msg.id));
          failed++;
        }
      }
      return { processed: batch.length, sent, failed };
    } finally {
      this.running = false;
    }
  }

  private async dispatch(msg: typeof outboxMessages.$inferSelect): Promise<string> {
    if (msg.target !== 'SATUSEHAT') throw new Error(`Target ${msg.target} tidak didukung oleh worker`);
    const f = msg.facilityId;
    switch (`${msg.resourceType}:${msg.operation}`) {
      case 'Encounter:CREATE': {
        await this.ensurePatientIhs(f, msg.resourceId);
        const resource = await this.mapper.encounter(f, msg.resourceId, true);
        delete resource.id;
        const id = await this.satusehat.create(resource);
        await this.db.update(encounters).set({ satusehatEncounterId: id }).where(eq(encounters.id, msg.resourceId));
        return id;
      }
      case 'Encounter:FINISH': {
        const resource = await this.mapper.encounter(f, msg.resourceId, true);
        if (!resource.id) throw new Error('Encounter belum terkirim ke SATUSEHAT (menunggu Encounter:CREATE)');
        // Diagnosis dikirim lebih dulu sebagai Condition
        const dx = await this.db.select({ id: diagnoses.id }).from(diagnoses).where(eq(diagnoses.encounterId, msg.resourceId));
        for (const d of dx) await this.satusehat.create(await this.mapper.condition(f, d.id, true));
        return this.satusehat.update(resource as typeof resource & { id: string });
      }
      case 'Observation:CREATE': {
        const [vs] = await this.db
          .select({ ssId: encounters.satusehatEncounterId })
          .from(vitalSigns)
          .innerJoin(encounters, eq(encounters.id, vitalSigns.encounterId))
          .where(eq(vitalSigns.id, msg.resourceId));
        if (!vs?.ssId) throw new Error('Encounter belum terkirim ke SATUSEHAT (menunggu Encounter:CREATE)');
        const obs = await this.mapper.vitalObservations(f, msg.resourceId, true);
        const ids = [];
        for (const o of obs) ids.push(await this.satusehat.create(o));
        return ids.join(',');
      }
      default:
        throw new Error(`Operasi ${msg.resourceType}:${msg.operation} tidak dikenal`);
    }
  }

  /** Pastikan pasien punya IHS Number (lookup by NIK). */
  private async ensurePatientIhs(facilityId: string, encounterId: string) {
    const [row] = await this.db
      .select({ p: patients })
      .from(encounters)
      .innerJoin(patients, eq(patients.id, encounters.patientId))
      .where(and(eq(encounters.id, encounterId), eq(encounters.facilityId, facilityId)));
    if (!row) throw new Error('Kunjungan tidak ditemukan');
    if (row.p.satusehatId) return;
    if (!row.p.nikEncrypted) throw new Error('Pasien tanpa NIK tidak dapat dipetakan ke IHS Number');
    const ihs = await this.satusehat.findPatientIdByNik(this.crypto.decrypt(row.p.nikEncrypted));
    if (!ihs) throw new Error('IHS Number pasien tidak ditemukan di SATUSEHAT');
    await this.db.update(patients).set({ satusehatId: ihs }).where(eq(patients.id, row.p.id));
  }
}

/* ------------------------------- Controllers ------------------------------- */

@Controller('integration')
@AuditResource('Integration')
export class IntegrationController {
  constructor(
    private readonly outbox: OutboxService,
    private readonly processor: OutboxProcessor,
    private readonly satusehat: SatusehatClient,
    private readonly bpjs: BpjsClient,
    private readonly facility: FacilityService,
  ) {}

  @Get('status')
  @Permissions('integration.manage', 'dashboard.read')
  async status(@CurrentUser() u: AuthUser) {
    return { satusehatMode: this.satusehat.mode, bpjsMode: this.bpjs.mode, outbox: await this.outbox.stats(u.facilityId) };
  }

  @Get('outbox')
  @Permissions('integration.manage')
  list(@CurrentUser() u: AuthUser, @Query('status') status?: string) {
    return this.outbox.list(u.facilityId, status);
  }

  @Post('outbox/process')
  @Permissions('integration.manage')
  process() {
    return this.processor.processBatch(100);
  }

  @Post('outbox/:id/replay')
  @Permissions('integration.manage')
  replay(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.outbox.replay(u.facilityId, id);
  }

  /** Cek eligibilitas peserta JKN sebelum registrasi. */
  @Post('bpjs/peserta')
  @Permissions('encounter.write', 'patient.write')
  async peserta(@CurrentUser() u: AuthUser, @Body(new ZodPipe(z.object({ noKartu: z.string().regex(/^\d{13}$/) }))) body: { noKartu: string }) {
    return this.bpjs.peserta(body.noKartu, await this.facility.today(u.facilityId));
  }
}

/**
 * FHIR R4 facade — antarmuka pertukaran standar (bukan API internal).
 * Akses tetap melalui RBAC + ABAC hubungan perawatan dan tercatat di audit.
 */
@Controller('fhir/R4')
export class FhirController {
  constructor(
    private readonly mapper: FhirMapper,
    private readonly access: CareAccessService,
    private readonly audit: AuditService,
    @Inject(DB) private readonly db: Db,
  ) {}

  @Get('metadata')
  @Header('Content-Type', 'application/fhir+json')
  metadata() {
    return {
      resourceType: 'CapabilityStatement',
      status: 'active',
      kind: 'instance',
      fhirVersion: '4.0.1',
      format: ['json'],
      rest: [{ mode: 'server', resource: ['Patient', 'Encounter', 'Condition', 'Observation'].map((type) => ({ type, interaction: [{ code: 'read' }, { code: 'search-type' }] })) }],
    };
  }

  @Get('Patient/:id')
  @Permissions('clinical.read')
  @Header('Content-Type', 'application/fhir+json')
  async patient(@CurrentUser() u: AuthUser, @Param('id') id: string, @ReqMeta() meta: RequestMeta) {
    await this.access.assertCanAccessPatient(u, id);
    await this.audit.log(u, { action: 'FHIR_READ', resourceType: 'Patient', resourceId: id, patientId: id }, meta);
    return this.mapper.patient(u.facilityId, id);
  }

  @Get('Encounter/:id')
  @Permissions('clinical.read')
  @Header('Content-Type', 'application/fhir+json')
  async encounter(@CurrentUser() u: AuthUser, @Param('id') id: string, @ReqMeta() meta: RequestMeta) {
    const patientId = await this.patientOf(u.facilityId, id);
    await this.access.assertCanAccessPatient(u, patientId);
    await this.audit.log(u, { action: 'FHIR_READ', resourceType: 'Encounter', resourceId: id, patientId }, meta);
    return this.mapper.encounter(u.facilityId, id);
  }

  @Get('Condition')
  @Permissions('clinical.read')
  @Header('Content-Type', 'application/fhir+json')
  async conditions(@CurrentUser() u: AuthUser, @Query('encounter') encounterId: string, @ReqMeta() meta: RequestMeta) {
    const patientId = await this.patientOf(u.facilityId, encounterId);
    await this.access.assertCanAccessPatient(u, patientId);
    await this.audit.log(u, { action: 'FHIR_READ', resourceType: 'Condition', resourceId: encounterId, patientId }, meta);
    return FhirMapper.bundle(await this.mapper.conditionsForEncounter(u.facilityId, encounterId));
  }

  @Get('Observation')
  @Permissions('clinical.read')
  @Header('Content-Type', 'application/fhir+json')
  async observations(@CurrentUser() u: AuthUser, @Query('encounter') encounterId: string, @ReqMeta() meta: RequestMeta) {
    const patientId = await this.patientOf(u.facilityId, encounterId);
    await this.access.assertCanAccessPatient(u, patientId);
    await this.audit.log(u, { action: 'FHIR_READ', resourceType: 'Observation', resourceId: encounterId, patientId }, meta);
    return FhirMapper.bundle(await this.mapper.observationsForEncounter(u.facilityId, encounterId));
  }

  private async patientOf(facilityId: string, encounterId?: string) {
    if (!encounterId) throw invalid('FHIR_PARAM_REQUIRED', 'Parameter encounter wajib diisi');
    const [e] = await this.db
      .select({ patientId: encounters.patientId })
      .from(encounters)
      .where(and(eq(encounters.id, encounterId), eq(encounters.facilityId, facilityId)));
    if (!e) throw notFound('Kunjungan', encounterId);
    return e.patientId;
  }
}

@Module({
  controllers: [IntegrationController, FhirController],
  providers: [OutboxService, OutboxProcessor, FhirMapper, SatusehatClient, BpjsClient],
  exports: [OutboxService, OutboxProcessor, BpjsClient],
})
export class IntegrationModule {}
