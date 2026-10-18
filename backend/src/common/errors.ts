import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Error domain dengan kode yang stabil (kontrak API). Klien bergantung pada `code`,
 * bukan pada teks pesan.
 */
export class AppError extends HttpException {
  constructor(
    public readonly code: string,
    message: string,
    status: HttpStatus = HttpStatus.UNPROCESSABLE_ENTITY,
    public readonly details?: unknown,
  ) {
    super({ code, message, details }, status);
  }
}

export const notFound = (resource: string, id?: string) =>
  new AppError(`${resource.toUpperCase()}_NOT_FOUND`, `${resource} tidak ditemukan${id ? `: ${id}` : ''}`, HttpStatus.NOT_FOUND);

export const conflict = (code: string, message: string, details?: unknown) =>
  new AppError(code, message, HttpStatus.CONFLICT, details);

export const forbidden = (code: string, message: string) => new AppError(code, message, HttpStatus.FORBIDDEN);

export const invalid = (code: string, message: string, details?: unknown) =>
  new AppError(code, message, HttpStatus.UNPROCESSABLE_ENTITY, details);
