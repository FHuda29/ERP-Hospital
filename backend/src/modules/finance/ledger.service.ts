import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import { DB, type Db, type DbOrTx } from '../../database/database.js';
import { accounts, journalEntries, journalLines } from '../../database/schema.js';
import { conflict, invalid, notFound } from '../../common/errors.js';
import { round2, sum } from '../../common/util.js';
import { SequenceService } from '../../core/sequence.service.js';

export interface JournalLineInput {
  accountCode: string;
  debit?: number;
  credit?: number;
  costCenterId?: string | null;
  memo?: string;
}

export interface JournalInput {
  date: string;
  description: string;
  sourceType: string;
  sourceId?: string | null;
  lines: JournalLineInput[];
}

/**
 * Buku besar double-entry. Semua posting otomatis (billing, kasir, farmasi, pengadaan, klaim)
 * melewati service ini sehingga jurnal selalu seimbang & tertelusur ke dokumen sumber.
 */
@Injectable()
export class LedgerService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly seq: SequenceService,
  ) {}

  async post(tx: DbOrTx, facilityId: string, input: JournalInput, userId: string | null) {
    const lines = input.lines
      .map((l) => ({ ...l, debit: round2(l.debit ?? 0), credit: round2(l.credit ?? 0) }))
      .filter((l) => l.debit !== 0 || l.credit !== 0);
    if (lines.length < 2) throw invalid('JOURNAL_TOO_FEW_LINES', 'Jurnal minimal memiliki dua baris');
    for (const l of lines) {
      if (l.debit < 0 || l.credit < 0 || (l.debit > 0 && l.credit > 0)) {
        throw invalid('JOURNAL_LINE_INVALID', `Baris jurnal ${l.accountCode} tidak valid`);
      }
    }
    const totalDebit = sum(lines.map((l) => l.debit));
    const totalCredit = sum(lines.map((l) => l.credit));
    if (totalDebit !== totalCredit) {
      throw invalid('JOURNAL_UNBALANCED', `Jurnal tidak seimbang (D ${totalDebit} ≠ K ${totalCredit})`);
    }

    const codes = [...new Set(lines.map((l) => l.accountCode))];
    const found = await tx
      .select({ code: accounts.code, isPostable: accounts.isPostable })
      .from(accounts)
      .where(and(eq(accounts.facilityId, facilityId), inArray(accounts.code, codes)));
    for (const c of codes) {
      const acc = found.find((f) => f.code === c);
      if (!acc) throw invalid('ACCOUNT_NOT_FOUND', `Akun ${c} tidak ada di bagan akun`);
      if (!acc.isPostable) throw invalid('ACCOUNT_NOT_POSTABLE', `Akun ${c} adalah akun induk`);
    }

    const journalNo = await this.seq.document(tx, facilityId, 'JRN', input.date, '/');
    const [entry] = await tx
      .insert(journalEntries)
      .values({
        facilityId,
        journalNo,
        date: input.date,
        description: input.description,
        sourceType: input.sourceType,
        sourceId: input.sourceId ?? null,
        postedBy: userId,
      })
      .returning();
    await tx.insert(journalLines).values(
      lines.map((l) => ({
        journalId: entry.id,
        accountCode: l.accountCode,
        debit: l.debit,
        credit: l.credit,
        costCenterId: l.costCenterId ?? null,
        memo: l.memo ?? null,
      })),
    );
    return entry;
  }

  /** Jurnal balik (koreksi) — jurnal asli tidak pernah dihapus. */
  async reverse(facilityId: string, journalId: string, date: string, userId: string) {
    return this.db.transaction(async (tx) => {
      const [entry] = await tx
        .select()
        .from(journalEntries)
        .where(and(eq(journalEntries.id, journalId), eq(journalEntries.facilityId, facilityId)));
      if (!entry) throw notFound('Jurnal', journalId);
      if (entry.status === 'REVERSED') throw conflict('JOURNAL_ALREADY_REVERSED', 'Jurnal sudah dibalik');
      const lines = await tx.select().from(journalLines).where(eq(journalLines.journalId, journalId));
      const rev = await this.post(
        tx,
        facilityId,
        {
          date,
          description: `Pembalikan ${entry.journalNo}: ${entry.description}`,
          sourceType: 'REVERSAL',
          sourceId: entry.id,
          lines: lines.map((l) => ({ accountCode: l.accountCode, debit: l.credit, credit: l.debit, costCenterId: l.costCenterId, memo: l.memo ?? undefined })),
        },
        userId,
      );
      await tx.update(journalEntries).set({ status: 'REVERSED' }).where(eq(journalEntries.id, journalId));
      await tx.update(journalEntries).set({ reversalOf: entry.id }).where(eq(journalEntries.id, rev.id));
      return rev;
    });
  }
}
