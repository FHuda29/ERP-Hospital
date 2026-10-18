import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { DbOrTx } from '../database/database.js';

type SeqKind = 'MRN' | 'RJ' | 'IGD' | 'RI' | 'INV' | 'PAY' | 'RX' | 'ORD' | 'CLM' | 'JRN' | 'PR' | 'PO' | 'GR' | 'BOOK' | 'INC';

/**
 * Penomoran dokumen atomik per fasilitas. Nomor RM tidak direset (period 'ALL'),
 * dokumen transaksi direset per bulan.
 */
@Injectable()
export class SequenceService {
  async next(db: DbOrTx, facilityId: string, key: SeqKind, period: string): Promise<number> {
    const res = await db.execute<{ last_value: number }>(sql`
      INSERT INTO sequences (facility_id, key, period, last_value)
      VALUES (${facilityId}, ${key}, ${period}, 1)
      ON CONFLICT (facility_id, key, period)
      DO UPDATE SET last_value = sequences.last_value + 1
      RETURNING last_value
    `);
    return Number(res.rows[0].last_value);
  }

  /** No. RM 8 digit, mis. 00-01-23-45 ditampilkan; disimpan 00012345. */
  async mrn(db: DbOrTx, facilityId: string): Promise<string> {
    return String(await this.next(db, facilityId, 'MRN', 'ALL')).padStart(8, '0');
  }

  /** Mis. RJ2610-00042, INV/2610/00001 */
  async document(db: DbOrTx, facilityId: string, key: SeqKind, isoDate: string, sep: '-' | '/' = '-'): Promise<string> {
    const period = isoDate.slice(2, 4) + isoDate.slice(5, 7);
    const n = await this.next(db, facilityId, key, period);
    return sep === '/' ? `${key}/${period}/${String(n).padStart(5, '0')}` : `${key}${period}-${String(n).padStart(5, '0')}`;
  }
}
