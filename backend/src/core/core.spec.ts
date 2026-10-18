import { CryptoService } from './crypto.service.js';
import { AuditService } from './audit.service.js';
import { computeEws } from '../modules/clinical/clinical.module.js';
import { careDays, todayIn } from '../common/util.js';
import { getConfig } from '../config.js';

describe('CryptoService (NIK)', () => {
  const svc = new CryptoService(getConfig());

  it('enkripsi AES-GCM dapat didekripsi & tiap ciphertext unik', () => {
    const a = svc.encrypt('3201010101800001');
    const b = svc.encrypt('3201010101800001');
    expect(a).not.toBe(b);
    expect(svc.decrypt(a)).toBe('3201010101800001');
  });

  it('ciphertext yang diubah ditolak (auth tag)', () => {
    const c = svc.encrypt('3201010101800001').split('.');
    c[3] = Buffer.from('xxxx').toString('base64url');
    expect(() => svc.decrypt(c.join('.'))).toThrow();
  });

  it('hash lookup deterministik & masking', () => {
    expect(svc.lookupHash('3201010101800001')).toBe(svc.lookupHash(' 3201010101800001 '));
    expect(CryptoService.maskNik('3201010101800001')).toBe('3201********0001');
  });
});

describe('Early Warning Score', () => {
  it('normal = 0, kondisi syok tinggi', () => {
    expect(computeEws({ respRate: 16, spo2: 98, systolic: 120, heartRate: 80, temperature: 37 })).toBe(0);
    expect(computeEws({ respRate: 26, spo2: 91, systolic: 85, heartRate: 125, temperature: 39.5 })).toBe(3 + 3 + 3 + 2 + 2);
    expect(computeEws({})).toBeNull();
  });
});

describe('Audit hash chain', () => {
  it('hash berubah bila isi berubah', () => {
    const row = { facilityId: 'f', actorId: 'a', action: 'READ', resourceType: 'Patient', resourceId: '1', patientId: '1', reason: null, at: new Date('2026-10-18T00:00:00Z') };
    const h1 = AuditService.computeHash('0'.repeat(64), row);
    const h2 = AuditService.computeHash('0'.repeat(64), { ...row, action: 'UPDATE' });
    expect(h1).toHaveLength(64);
    expect(h1).not.toBe(h2);
  });
});

describe('Utilitas tanggal', () => {
  it('hari rawat minimal 1 & zona waktu WIT', () => {
    expect(careDays('2026-10-18T10:00:00Z', '2026-10-18T20:00:00Z')).toBe(1);
    expect(careDays('2026-10-15T10:00:00Z', '2026-10-18T08:00:00Z')).toBe(3);
    expect(todayIn('Asia/Jayapura', new Date('2026-10-18T16:30:00Z'))).toBe('2026-10-19');
  });
});
