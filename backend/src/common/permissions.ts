/**
 * RBAC: peran → izin. Izin granular dipakai di controller melalui @Permissions().
 * ABAC tambahan (unit kerja & hubungan perawatan) ditegakkan di CareAccessService.
 */
export const ROLES = [
  'ADMIN',
  'DIREKSI',
  'DOKTER',
  'PERAWAT',
  'BIDAN',
  'ADMISI',
  'REKAM_MEDIS',
  'FARMASI',
  'LAB',
  'RADIOLOGI',
  'KASIR',
  'CASEMIX',
  'KEUANGAN',
  'GUDANG',
  'PENGADAAN',
  'MUTU',
] as const;
export type Role = (typeof ROLES)[number];

export type Permission =
  | 'patient.read' | 'patient.write' | 'patient.merge'
  | 'appointment.write' | 'queue.manage'
  | 'encounter.read' | 'encounter.write' | 'triage.write' | 'bed.manage'
  | 'clinical.read' | 'clinical.write' | 'clinical.sign'
  | 'order.write' | 'order.process' | 'result.write' | 'result.verify'
  | 'rx.write' | 'rx.verify' | 'rx.dispense' | 'emar.write'
  | 'inventory.read' | 'inventory.write'
  | 'procurement.read' | 'procurement.write' | 'procurement.approve' | 'procurement.receive'
  | 'billing.read' | 'billing.write' | 'payment.write'
  | 'claim.read' | 'claim.write'
  | 'finance.read' | 'finance.write' | 'ap.write'
  | 'master.read' | 'master.write' | 'user.manage'
  | 'audit.read' | 'integration.manage' | 'dashboard.read'
  | 'incident.read' | 'incident.write' | 'breakglass.review';

const clinicalBase: Permission[] = ['patient.read', 'encounter.read', 'clinical.read', 'master.read', 'incident.write'];

export const ROLE_PERMISSIONS: Record<Role, Permission[] | '*'> = {
  ADMIN: '*',
  DIREKSI: ['dashboard.read', 'finance.read', 'billing.read', 'claim.read', 'procurement.read', 'procurement.approve', 'inventory.read', 'incident.read', 'master.read', 'audit.read', 'breakglass.review'],
  DOKTER: [...clinicalBase, 'encounter.write', 'clinical.write', 'clinical.sign', 'order.write', 'rx.write', 'triage.write', 'dashboard.read'],
  PERAWAT: [...clinicalBase, 'encounter.write', 'triage.write', 'clinical.write', 'clinical.sign', 'emar.write', 'bed.manage', 'queue.manage'],
  BIDAN: [...clinicalBase, 'encounter.write', 'triage.write', 'clinical.write', 'clinical.sign', 'emar.write'],
  ADMISI: ['patient.read', 'patient.write', 'appointment.write', 'queue.manage', 'encounter.read', 'encounter.write', 'bed.manage', 'master.read', 'billing.read'],
  REKAM_MEDIS: ['patient.read', 'patient.write', 'patient.merge', 'encounter.read', 'clinical.read', 'master.read', 'audit.read', 'dashboard.read'],
  FARMASI: ['patient.read', 'encounter.read', 'clinical.read', 'rx.verify', 'rx.dispense', 'inventory.read', 'inventory.write', 'master.read', 'procurement.read', 'procurement.write', 'incident.write'],
  LAB: ['patient.read', 'encounter.read', 'order.process', 'result.write', 'result.verify', 'master.read', 'inventory.read', 'incident.write'],
  RADIOLOGI: ['patient.read', 'encounter.read', 'order.process', 'result.write', 'result.verify', 'master.read', 'incident.write'],
  KASIR: ['patient.read', 'encounter.read', 'billing.read', 'billing.write', 'payment.write', 'master.read'],
  CASEMIX: ['patient.read', 'encounter.read', 'clinical.read', 'billing.read', 'billing.write', 'claim.read', 'claim.write', 'master.read'],
  KEUANGAN: ['billing.read', 'claim.read', 'claim.write', 'finance.read', 'finance.write', 'ap.write', 'procurement.read', 'dashboard.read', 'master.read', 'payment.write'],
  GUDANG: ['inventory.read', 'inventory.write', 'procurement.read', 'procurement.receive', 'master.read'],
  PENGADAAN: ['procurement.read', 'procurement.write', 'inventory.read', 'master.read', 'master.write'],
  MUTU: ['incident.read', 'incident.write', 'dashboard.read', 'audit.read', 'master.read'],
};

export function permissionsFor(roles: string[]): Set<Permission> | '*' {
  const set = new Set<Permission>();
  for (const r of roles) {
    const p = ROLE_PERMISSIONS[r as Role];
    if (p === '*') return '*';
    p?.forEach((x) => set.add(x));
  }
  return set;
}

export function hasPermission(roles: string[], perm: Permission): boolean {
  const p = permissionsFor(roles);
  return p === '*' || p.has(perm);
}

/** Peran klinis yang aksesnya ke RME dibatasi hubungan perawatan (ABAC). */
export const CARE_RELATIONSHIP_ROLES: Role[] = ['DOKTER', 'PERAWAT', 'BIDAN'];
