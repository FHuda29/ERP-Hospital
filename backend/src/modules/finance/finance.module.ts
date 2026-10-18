import { Body, Controller, Get, Inject, Injectable, Module, Param, Post, Query } from '@nestjs/common';
import { and, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import { DB, type Db } from '../../database/database.js';
import { accounts, costCenters, journalEntries, journalLines } from '../../database/schema.js';
import { AuditResource, CurrentUser, Permissions, type AuthUser } from '../../common/auth.js';
import { conflict, notFound } from '../../common/errors.js';
import { round2 } from '../../common/util.js';
import { ZodPipe, zDate } from '../../common/zod.pipe.js';
import { FacilityService } from '../../core/core.module.js';
import { LedgerService } from './ledger.service.js';

const AccountSchema = z.object({
  code: z.string().regex(/^\d-\d{4}$/),
  name: z.string().min(2),
  type: z.enum(['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE']),
  parentCode: z.string().optional(),
  isPostable: z.boolean().default(true),
});

const ManualJournalSchema = z.object({
  date: zDate,
  description: z.string().min(3),
  lines: z
    .array(
      z.object({
        accountCode: z.string(),
        debit: z.number().nonnegative().default(0),
        credit: z.number().nonnegative().default(0),
        costCenterId: z.uuid().optional(),
        memo: z.string().optional(),
      }),
    )
    .min(2),
});

const PeriodSchema = z.object({ from: zDate.optional(), to: zDate.optional() });

@Injectable()
export class FinanceService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly ledger: LedgerService,
    private readonly facility: FacilityService,
  ) {}

  listAccounts(facilityId: string) {
    return this.db.select().from(accounts).where(eq(accounts.facilityId, facilityId)).orderBy(accounts.code);
  }

  async createAccount(facilityId: string, input: z.infer<typeof AccountSchema>) {
    const exists = await this.db.select().from(accounts).where(and(eq(accounts.facilityId, facilityId), eq(accounts.code, input.code)));
    if (exists.length) throw conflict('ACCOUNT_EXISTS', `Akun ${input.code} sudah ada`);
    const normalBalance = input.type === 'ASSET' || input.type === 'EXPENSE' ? 'D' : 'C';
    const [row] = await this.db.insert(accounts).values({ ...input, facilityId, normalBalance }).returning();
    return row;
  }

  listCostCenters(facilityId: string) {
    return this.db.select().from(costCenters).where(eq(costCenters.facilityId, facilityId)).orderBy(costCenters.code);
  }

  async listJournals(facilityId: string, q: { from?: string; to?: string; sourceType?: string }) {
    const conds = [eq(journalEntries.facilityId, facilityId)];
    if (q.from) conds.push(gte(journalEntries.date, q.from));
    if (q.to) conds.push(lte(journalEntries.date, q.to));
    if (q.sourceType) conds.push(eq(journalEntries.sourceType, q.sourceType));
    const entries = await this.db
      .select()
      .from(journalEntries)
      .where(and(...conds))
      .orderBy(desc(journalEntries.createdAt))
      .limit(300);
    if (!entries.length) return [];
    const lines = await this.db
      .select()
      .from(journalLines)
      .where(inArray(journalLines.journalId, entries.map((e) => e.id)));
    return entries.map((e) => ({ ...e, lines: lines.filter((l) => l.journalId === e.id) }));
  }

  async getJournal(facilityId: string, id: string) {
    const [entry] = await this.db.select().from(journalEntries).where(and(eq(journalEntries.id, id), eq(journalEntries.facilityId, facilityId)));
    if (!entry) throw notFound('Jurnal', id);
    const lines = await this.db.select().from(journalLines).where(eq(journalLines.journalId, id));
    return { ...entry, lines };
  }

  manualJournal(user: AuthUser, input: z.infer<typeof ManualJournalSchema>) {
    return this.db.transaction((tx) =>
      this.ledger.post(tx, user.facilityId, { ...input, sourceType: 'MANUAL' }, user.id),
    );
  }

  async reverse(user: AuthUser, id: string) {
    return this.ledger.reverse(user.facilityId, id, await this.facility.today(user.facilityId), user.id);
  }

  /** Neraca saldo per akun untuk periode. */
  async trialBalance(facilityId: string, from?: string, to?: string) {
    const conds = [eq(journalEntries.facilityId, facilityId)];
    if (from) conds.push(gte(journalEntries.date, from));
    if (to) conds.push(lte(journalEntries.date, to));
    const rows = await this.db
      .select({
        accountCode: journalLines.accountCode,
        debit: sql<string>`coalesce(sum(${journalLines.debit}),0)`,
        credit: sql<string>`coalesce(sum(${journalLines.credit}),0)`,
      })
      .from(journalLines)
      .innerJoin(journalEntries, eq(journalEntries.id, journalLines.journalId))
      .where(and(...conds))
      .groupBy(journalLines.accountCode);
    const accs = await this.listAccounts(facilityId);
    const lines = accs
      .filter((a) => a.isPostable)
      .map((a) => {
        const r = rows.find((x) => x.accountCode === a.code);
        const debit = round2(Number(r?.debit ?? 0));
        const credit = round2(Number(r?.credit ?? 0));
        const balance = a.normalBalance === 'D' ? round2(debit - credit) : round2(credit - debit);
        return { code: a.code, name: a.name, type: a.type, normalBalance: a.normalBalance, debit, credit, balance };
      });
    const totalDebit = round2(lines.reduce((s, l) => s + l.debit, 0));
    const totalCredit = round2(lines.reduce((s, l) => s + l.credit, 0));
    return { from: from ?? null, to: to ?? null, lines, totalDebit, totalCredit, balanced: totalDebit === totalCredit };
  }

  async incomeStatement(facilityId: string, from?: string, to?: string) {
    const tb = await this.trialBalance(facilityId, from, to);
    const revenue = tb.lines.filter((l) => l.type === 'REVENUE');
    const expense = tb.lines.filter((l) => l.type === 'EXPENSE');
    const totalRevenue = round2(revenue.reduce((s, l) => s + l.balance, 0));
    const totalExpense = round2(expense.reduce((s, l) => s + l.balance, 0));
    return { from: tb.from, to: tb.to, revenue, expense, totalRevenue, totalExpense, netIncome: round2(totalRevenue - totalExpense) };
  }

  async balanceSheet(facilityId: string, asOf?: string) {
    const tb = await this.trialBalance(facilityId, undefined, asOf);
    const pick = (t: string) => tb.lines.filter((l) => l.type === t && l.balance !== 0);
    const total = (xs: { balance: number }[]) => round2(xs.reduce((s, l) => s + l.balance, 0));
    const assets = pick('ASSET');
    const liabilities = pick('LIABILITY');
    const equity = pick('EQUITY');
    const currentEarnings = round2(total(pick('REVENUE')) - total(pick('EXPENSE')));
    return {
      asOf: asOf ?? null,
      assets,
      liabilities,
      equity,
      currentEarnings,
      totalAssets: total(assets),
      totalLiabilitiesAndEquity: round2(total(liabilities) + total(equity) + currentEarnings),
    };
  }
}

@Controller('finance')
@AuditResource('Finance')
export class FinanceController {
  constructor(private readonly svc: FinanceService) {}

  @Get('accounts')
  @Permissions('finance.read', 'master.read')
  accounts(@CurrentUser() u: AuthUser) {
    return this.svc.listAccounts(u.facilityId);
  }

  @Post('accounts')
  @Permissions('finance.write')
  createAccount(@CurrentUser() u: AuthUser, @Body(new ZodPipe(AccountSchema)) body: z.infer<typeof AccountSchema>) {
    return this.svc.createAccount(u.facilityId, body);
  }

  @Get('cost-centers')
  @Permissions('finance.read')
  costCenters(@CurrentUser() u: AuthUser) {
    return this.svc.listCostCenters(u.facilityId);
  }

  @Get('journals')
  @Permissions('finance.read')
  journals(@CurrentUser() u: AuthUser, @Query() q: { from?: string; to?: string; sourceType?: string }) {
    return this.svc.listJournals(u.facilityId, q);
  }

  @Get('journals/:id')
  @Permissions('finance.read')
  journal(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.svc.getJournal(u.facilityId, id);
  }

  @Post('journals')
  @Permissions('finance.write')
  manual(@CurrentUser() u: AuthUser, @Body(new ZodPipe(ManualJournalSchema)) body: z.infer<typeof ManualJournalSchema>) {
    return this.svc.manualJournal(u, body);
  }

  @Post('journals/:id/reverse')
  @Permissions('finance.write')
  reverse(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.svc.reverse(u, id);
  }

  @Get('reports/trial-balance')
  @Permissions('finance.read')
  trialBalance(@CurrentUser() u: AuthUser, @Query(new ZodPipe(PeriodSchema)) q: z.infer<typeof PeriodSchema>) {
    return this.svc.trialBalance(u.facilityId, q.from, q.to);
  }

  @Get('reports/income-statement')
  @Permissions('finance.read')
  incomeStatement(@CurrentUser() u: AuthUser, @Query(new ZodPipe(PeriodSchema)) q: z.infer<typeof PeriodSchema>) {
    return this.svc.incomeStatement(u.facilityId, q.from, q.to);
  }

  @Get('reports/balance-sheet')
  @Permissions('finance.read')
  balanceSheet(@CurrentUser() u: AuthUser, @Query(new ZodPipe(PeriodSchema)) q: z.infer<typeof PeriodSchema>) {
    return this.svc.balanceSheet(u.facilityId, q.to);
  }
}

@Module({
  controllers: [FinanceController],
  providers: [LedgerService, FinanceService],
  exports: [LedgerService],
})
export class FinanceModule {}
