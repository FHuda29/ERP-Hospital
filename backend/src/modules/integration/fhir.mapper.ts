import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DB, type Db } from '../../database/database.js';
import { diagnoses, encounters, facilities, patients, practitioners, units, vitalSigns } from '../../database/schema.js';
import { notFound } from '../../common/errors.js';
import { CryptoService } from '../../core/crypto.service.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
export type FhirResource = { resourceType: string; id?: string; [k: string]: any };

const ENCOUNTER_CLASS: Record<string, { code: string; display: string }> = {
  RAWAT_JALAN: { code: 'AMB', display: 'ambulatory' },
  IGD: { code: 'EMER', display: 'emergency' },
  RAWAT_INAP: { code: 'IMP', display: 'inpatient encounter' },
};

const ENCOUNTER_STATUS: Record<string, string> = {
  REGISTERED: 'arrived',
  TRIAGED: 'triaged',
  IN_PROGRESS: 'in-progress',
  FINISHED: 'finished',
  CANCELLED: 'cancelled',
};

/** LOINC untuk tanda vital (profil SATUSEHAT Observation). */
const VITAL_LOINC: { field: keyof typeof vitalSigns.$inferSelect; code: string; display: string; unit: string; ucum: string }[] = [
  { field: 'heartRate', code: '8867-4', display: 'Heart rate', unit: 'beats/minute', ucum: '/min' },
  { field: 'respRate', code: '9279-1', display: 'Respiratory rate', unit: 'breaths/minute', ucum: '/min' },
  { field: 'systolic', code: '8480-6', display: 'Systolic blood pressure', unit: 'mm[Hg]', ucum: 'mm[Hg]' },
  { field: 'diastolic', code: '8462-4', display: 'Diastolic blood pressure', unit: 'mm[Hg]', ucum: 'mm[Hg]' },
  { field: 'temperature', code: '8310-5', display: 'Body temperature', unit: 'C', ucum: 'Cel' },
  { field: 'spo2', code: '59408-5', display: 'Oxygen saturation in Arterial blood by Pulse oximetry', unit: '%', ucum: '%' },
];

/**
 * Pemetaan data internal → FHIR R4 (mengikuti pola profil SATUSEHAT).
 * Dipakai oleh FHIR facade (pertukaran standar) dan adapter SATUSEHAT.
 * Catatan: profil & terminologi wajib diverifikasi ulang terhadap Playbook SATUSEHAT terbaru.
 */
@Injectable()
export class FhirMapper {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly crypto: CryptoService,
  ) {}

  async patient(facilityId: string, id: string): Promise<FhirResource> {
    const [p] = await this.db.select().from(patients).where(and(eq(patients.id, id), eq(patients.facilityId, facilityId)));
    if (!p) throw notFound('Pasien', id);
    const identifier: any[] = [{ use: 'usual', system: `urn:simrs:mrn:${facilityId}`, value: p.mrn }];
    if (p.nikEncrypted) identifier.unshift({ use: 'official', system: 'https://fhir.kemkes.go.id/id/nik', value: this.crypto.decrypt(p.nikEncrypted) });
    if (p.satusehatId) identifier.push({ use: 'official', system: 'https://fhir.kemkes.go.id/id/ihs-number', value: p.satusehatId });
    return {
      resourceType: 'Patient',
      id: p.id,
      identifier,
      active: p.status === 'ACTIVE',
      name: [{ use: 'official', text: p.name }],
      gender: p.gender === 'L' ? 'male' : 'female',
      birthDate: p.birthDate,
      telecom: p.phone ? [{ system: 'phone', value: p.phone, use: 'mobile' }] : [],
      address: p.address ? [{ use: 'home', line: [p.address], city: p.city ?? undefined, country: 'ID' }] : [],
      deceasedBoolean: p.status === 'DECEASED',
    };
  }

  async encounter(facilityId: string, id: string, external = false): Promise<FhirResource> {
    const [row] = await this.db
      .select({ e: encounters, p: patients, pr: practitioners, u: units, f: facilities })
      .from(encounters)
      .innerJoin(patients, eq(patients.id, encounters.patientId))
      .innerJoin(units, eq(units.id, encounters.unitId))
      .innerJoin(facilities, eq(facilities.id, encounters.facilityId))
      .leftJoin(practitioners, eq(practitioners.id, encounters.practitionerId))
      .where(and(eq(encounters.id, id), eq(encounters.facilityId, facilityId)));
    if (!row) throw notFound('Kunjungan', id);
    const { e, p, pr, u, f } = row;
    const dx = await this.db.select().from(diagnoses).where(eq(diagnoses.encounterId, id));
    const cls = ENCOUNTER_CLASS[e.type];
    const ref = (type: string, internal: string, ext: string | null) => `${type}/${external ? (ext ?? internal) : internal}`;
    return {
      resourceType: 'Encounter',
      ...(external ? (e.satusehatEncounterId ? { id: e.satusehatEncounterId } : {}) : { id: e.id }),
      identifier: [{ system: `http://sys-ids.kemkes.go.id/encounter/${f.satusehatOrgId ?? f.code}`, value: e.encounterNo }],
      status: ENCOUNTER_STATUS[e.status] ?? 'unknown',
      class: { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: cls.code, display: cls.display },
      subject: { reference: ref('Patient', p.id, p.satusehatId), display: p.name },
      participant: pr
        ? [
            {
              type: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ParticipationType', code: 'ATND', display: 'attender' }] }],
              individual: { reference: ref('Practitioner', pr.id, pr.satusehatId), display: pr.name },
            },
          ]
        : [],
      period: { start: e.startAt.toISOString(), ...(e.endAt ? { end: e.endAt.toISOString() } : {}) },
      location: [{ location: { reference: ref('Location', u.id, u.satusehatLocationId), display: u.name } }],
      diagnosis: dx.map((d, i) => ({
        condition: { reference: `Condition/${d.id}`, display: d.display },
        use: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/diagnosis-role', code: 'DD', display: 'Discharge diagnosis' }] },
        rank: d.rank === 'PRIMER' ? 1 : i + 2,
      })),
      serviceProvider: { reference: `Organization/${f.satusehatOrgId ?? f.id}` },
    };
  }

  async condition(facilityId: string, diagnosisId: string, external = false): Promise<FhirResource> {
    const [row] = await this.db
      .select({ d: diagnoses, e: encounters, p: patients })
      .from(diagnoses)
      .innerJoin(encounters, eq(encounters.id, diagnoses.encounterId))
      .innerJoin(patients, eq(patients.id, diagnoses.patientId))
      .where(and(eq(diagnoses.id, diagnosisId), eq(diagnoses.facilityId, facilityId)));
    if (!row) throw notFound('Diagnosis', diagnosisId);
    const { d, e, p } = row;
    return {
      resourceType: 'Condition',
      ...(external ? {} : { id: d.id }),
      clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-clinical', code: 'active', display: 'Active' }] },
      category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-category', code: 'encounter-diagnosis', display: 'Encounter Diagnosis' }] }],
      code: { coding: [{ system: 'http://hl7.org/fhir/sid/icd-10', code: d.icd10Code, display: d.display }] },
      subject: { reference: `Patient/${external ? (p.satusehatId ?? p.id) : p.id}`, display: p.name },
      encounter: { reference: `Encounter/${external ? (e.satusehatEncounterId ?? e.id) : e.id}` },
      recordedDate: d.createdAt.toISOString(),
    };
  }

  async vitalObservations(facilityId: string, vitalId: string, external = false): Promise<FhirResource[]> {
    const [row] = await this.db
      .select({ v: vitalSigns, e: encounters, p: patients })
      .from(vitalSigns)
      .innerJoin(encounters, eq(encounters.id, vitalSigns.encounterId))
      .innerJoin(patients, eq(patients.id, vitalSigns.patientId))
      .where(and(eq(vitalSigns.id, vitalId), eq(vitalSigns.facilityId, facilityId)));
    if (!row) throw notFound('Tanda vital', vitalId);
    const { v, e, p } = row;
    return VITAL_LOINC.filter((m) => v[m.field] !== null && v[m.field] !== undefined).map((m) => ({
      resourceType: 'Observation',
      ...(external ? {} : { id: `${v.id}-${m.code}` }),
      status: 'final',
      category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'vital-signs', display: 'Vital Signs' }] }],
      code: { coding: [{ system: 'http://loinc.org', code: m.code, display: m.display }] },
      subject: { reference: `Patient/${external ? (p.satusehatId ?? p.id) : p.id}` },
      encounter: { reference: `Encounter/${external ? (e.satusehatEncounterId ?? e.id) : e.id}` },
      effectiveDateTime: v.createdAt.toISOString(),
      valueQuantity: { value: Number(v[m.field]), unit: m.unit, system: 'http://unitsofmeasure.org', code: m.ucum },
    }));
  }

  async conditionsForEncounter(facilityId: string, encounterId: string) {
    const dx = await this.db
      .select({ id: diagnoses.id })
      .from(diagnoses)
      .where(and(eq(diagnoses.encounterId, encounterId), eq(diagnoses.facilityId, facilityId)));
    return Promise.all(dx.map((d) => this.condition(facilityId, d.id)));
  }

  async observationsForEncounter(facilityId: string, encounterId: string) {
    const vs = await this.db
      .select({ id: vitalSigns.id })
      .from(vitalSigns)
      .where(and(eq(vitalSigns.encounterId, encounterId), eq(vitalSigns.facilityId, facilityId)));
    return (await Promise.all(vs.map((v) => this.vitalObservations(facilityId, v.id)))).flat();
  }

  static bundle(resources: FhirResource[]): FhirResource {
    return { resourceType: 'Bundle', type: 'searchset', total: resources.length, entry: resources.map((resource) => ({ resource })) };
  }
}
