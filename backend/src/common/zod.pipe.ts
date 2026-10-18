import { HttpStatus, PipeTransform } from '@nestjs/common';
import { z } from 'zod';
import { AppError } from './errors.js';

/** Validasi DTO berbasis Zod. Penggunaan: @Body(new ZodPipe(Schema)) body: z.infer<typeof Schema> */
export class ZodPipe<T extends z.ZodType> implements PipeTransform {
  constructor(private readonly schema: T) {}

  transform(value: unknown): z.infer<T> {
    const parsed = this.schema.safeParse(value);
    if (!parsed.success) {
      throw new AppError(
        'VALIDATION_FAILED',
        'Data yang dikirim tidak valid',
        HttpStatus.BAD_REQUEST,
        parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      );
    }
    return parsed.data;
  }
}

/** Skema umum yang dipakai berulang. */
export const zDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Format tanggal YYYY-MM-DD');
export const zUuid = z.uuid();
export const zMoney = z.number().nonnegative().max(1e13);
export const zPagination = z.object({
  q: z.string().trim().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
