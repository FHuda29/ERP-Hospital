import { Controller, Get, Inject, MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { sql } from 'drizzle-orm';
import { Public } from './common/auth.js';
import { CoreModule } from './core/core.module.js';
import { AuthGuard } from './core/auth.guard.js';
import { AllExceptionsFilter, AuditInterceptor, IdempotencyInterceptor, RequestIdMiddleware } from './core/http.js';
import { DATABASE_HANDLE } from './core/tokens.js';
import type { DatabaseHandle } from './database/database.js';
import { BillingModule } from './modules/billing/billing.module.js';
import { ClaimsModule } from './modules/claims/claims.module.js';
import { ClinicalModule } from './modules/clinical/clinical.module.js';
import { FinanceModule } from './modules/finance/finance.module.js';
import { IamModule } from './modules/iam/iam.module.js';
import { IntegrationModule } from './modules/integration/integration.module.js';
import { InventoryModule } from './modules/inventory/inventory.module.js';
import { ManagementModule } from './modules/management/management.module.js';
import { MasterModule } from './modules/master/master.module.js';
import { OrdersModule } from './modules/orders/orders.module.js';
import { PatientsModule } from './modules/patients/patients.module.js';
import { PharmacyModule } from './modules/pharmacy/pharmacy.module.js';
import { ProcurementModule } from './modules/procurement/procurement.module.js';
import { RegistrationModule } from './modules/registration/registration.module.js';
import { SeedModule } from './seed/seed.module.js';

@Controller('health')
class HealthController {
  constructor(@Inject(DATABASE_HANDLE) private readonly handle: DatabaseHandle) {}

  @Public()
  @Get()
  async health() {
    await this.handle.db.execute(sql`select 1`);
    return { status: 'ok', database: this.handle.driver, time: new Date().toISOString() };
  }
}

@Module({
  imports: [
    CoreModule,
    IamModule,
    MasterModule,
    PatientsModule,
    RegistrationModule,
    ClinicalModule,
    OrdersModule,
    PharmacyModule,
    InventoryModule,
    ProcurementModule,
    BillingModule,
    ClaimsModule,
    FinanceModule,
    IntegrationModule,
    ManagementModule,
    SeedModule,
  ],
  controllers: [HealthController],
  providers: [
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(RequestIdMiddleware).forRoutes('{*path}');
  }
}
