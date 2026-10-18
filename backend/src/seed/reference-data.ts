/**
 * Subset data referensi untuk dev/demo. Produksi: impor ICD-10 (WHO/Kemenkes),
 * ICD-9-CM, KFA, dan formularium lengkap dari sumber resmi melalui modul master data.
 */
export const ICD10: [string, string, string][] = [
  ['A01.0', 'Typhoid fever', 'Demam tifoid'],
  ['A09', 'Diarrhoea and gastroenteritis of presumed infectious origin', 'Diare dan gastroenteritis'],
  ['A15.0', 'Tuberculosis of lung', 'Tuberkulosis paru'],
  ['A90', 'Dengue fever', 'Demam dengue'],
  ['A91', 'Dengue haemorrhagic fever', 'Demam berdarah dengue'],
  ['B05.9', 'Measles without complication', 'Campak tanpa komplikasi'],
  ['E11.9', 'Type 2 diabetes mellitus without complications', 'Diabetes melitus tipe 2 tanpa komplikasi'],
  ['E11.6', 'Type 2 diabetes mellitus with other specified complications', 'DM tipe 2 dengan komplikasi lain'],
  ['E78.5', 'Hyperlipidaemia, unspecified', 'Hiperlipidemia'],
  ['E86', 'Volume depletion', 'Dehidrasi'],
  ['I10', 'Essential (primary) hypertension', 'Hipertensi esensial (primer)'],
  ['I11.9', 'Hypertensive heart disease without heart failure', 'Penyakit jantung hipertensi'],
  ['I20.9', 'Angina pectoris, unspecified', 'Angina pektoris'],
  ['I21.9', 'Acute myocardial infarction, unspecified', 'Infark miokard akut'],
  ['I50.9', 'Heart failure, unspecified', 'Gagal jantung'],
  ['I63.9', 'Cerebral infarction, unspecified', 'Stroke infark'],
  ['I64', 'Stroke, not specified as haemorrhage or infarction', 'Stroke'],
  ['J00', 'Acute nasopharyngitis [common cold]', 'Nasofaringitis akut (common cold)'],
  ['J02.9', 'Acute pharyngitis, unspecified', 'Faringitis akut'],
  ['J06.9', 'Acute upper respiratory infection, unspecified', 'ISPA'],
  ['J18.9', 'Pneumonia, unspecified', 'Pneumonia'],
  ['J44.9', 'Chronic obstructive pulmonary disease, unspecified', 'PPOK'],
  ['J45.9', 'Asthma, unspecified', 'Asma'],
  ['K21.9', 'Gastro-oesophageal reflux disease without oesophagitis', 'GERD'],
  ['K29.7', 'Gastritis, unspecified', 'Gastritis'],
  ['K30', 'Dyspepsia', 'Dispepsia'],
  ['K35.8', 'Acute appendicitis, other and unspecified', 'Apendisitis akut'],
  ['K80.2', 'Calculus of gallbladder without cholecystitis', 'Batu kandung empedu'],
  ['L03.9', 'Cellulitis, unspecified', 'Selulitis'],
  ['M54.5', 'Low back pain', 'Nyeri punggung bawah'],
  ['M79.1', 'Myalgia', 'Mialgia'],
  ['N18.9', 'Chronic kidney disease, unspecified', 'Penyakit ginjal kronik'],
  ['N39.0', 'Urinary tract infection, site not specified', 'Infeksi saluran kemih'],
  ['O80', 'Single spontaneous delivery', 'Persalinan spontan tunggal'],
  ['O82', 'Single delivery by caesarean section', 'Persalinan dengan seksio sesarea'],
  ['P07.3', 'Other preterm infants', 'Bayi prematur'],
  ['R05', 'Cough', 'Batuk'],
  ['R10.4', 'Other and unspecified abdominal pain', 'Nyeri perut'],
  ['R50.9', 'Fever, unspecified', 'Demam'],
  ['R51', 'Headache', 'Sakit kepala'],
  ['S06.0', 'Concussion', 'Komosio serebri'],
  ['S52.5', 'Fracture of lower end of radius', 'Fraktur radius distal'],
  ['S61.9', 'Open wound of wrist and hand, part unspecified', 'Luka terbuka tangan'],
  ['T78.4', 'Allergy, unspecified', 'Alergi'],
  ['Z00.0', 'General medical examination', 'Pemeriksaan kesehatan umum'],
  ['Z09.8', 'Follow-up examination after other treatment', 'Kontrol pasca pengobatan'],
  ['Z34.9', 'Supervision of normal pregnancy, unspecified', 'Pemeriksaan kehamilan normal'],
];

export const ICD9CM: [string, string][] = [
  ['38.93', 'Venous catheterization, not elsewhere classified (pemasangan infus)'],
  ['47.09', 'Other appendectomy'],
  ['74.1', 'Low cervical cesarean section'],
  ['86.22', 'Excisional debridement of wound'],
  ['86.59', 'Closure of skin and subcutaneous tissue (hecting)'],
  ['87.03', 'Computerized axial tomography of head'],
  ['87.44', 'Routine chest x-ray'],
  ['88.76', 'Diagnostic ultrasound of abdomen and retroperitoneum'],
  ['89.52', 'Electrocardiogram'],
  ['90.59', 'Other microscopic examination of blood'],
  ['93.57', 'Application of other wound dressing (perawatan luka)'],
  ['93.94', 'Respiratory medication administered by nebulizer'],
  ['96.04', 'Insertion of endotracheal tube'],
  ['99.04', 'Transfusion of packed cells'],
  ['99.21', 'Injection of antibiotic'],
];

/** Interaksi obat (nama generik huruf kecil). */
export const INTERACTIONS: [string, string, 'MAJOR' | 'MODERATE' | 'MINOR', string][] = [
  ['warfarin', 'asam asetilsalisilat', 'MAJOR', 'Risiko perdarahan meningkat bermakna'],
  ['warfarin', 'ibuprofen', 'MAJOR', 'Risiko perdarahan gastrointestinal'],
  ['captopril', 'kalium klorida', 'MAJOR', 'Risiko hiperkalemia'],
  ['clopidogrel', 'omeprazole', 'MODERATE', 'Omeprazole menurunkan efek antiplatelet clopidogrel'],
  ['simvastatin', 'amlodipine', 'MODERATE', 'Risiko miopati — batasi simvastatin 20 mg/hari'],
  ['asam asetilsalisilat', 'ibuprofen', 'MODERATE', 'Ibuprofen mengurangi efek kardioprotektif aspirin'],
  ['metformin', 'ceftriaxone', 'MINOR', 'Pantau fungsi ginjal'],
];

export interface SeedItem {
  code: string;
  name: string;
  generic: string;
  category: 'OBAT' | 'ALKES' | 'BMHP';
  form?: string;
  strength?: string;
  uom: string;
  price: number;
  cost: number;
  min: number;
  highAlert?: boolean;
  narcotic?: boolean;
  formulary?: boolean;
  kfa?: string;
}

export const ITEMS: SeedItem[] = [
  { code: 'OB-PCT500', name: 'Paracetamol', generic: 'paracetamol', category: 'OBAT', form: 'Tablet', strength: '500 mg', uom: 'TAB', price: 500, cost: 180, min: 500 },
  { code: 'OB-AMX500', name: 'Amoxicillin', generic: 'amoxicillin', category: 'OBAT', form: 'Kapsul', strength: '500 mg', uom: 'KAP', price: 900, cost: 350, min: 300 },
  { code: 'OB-AML10', name: 'Amlodipine', generic: 'amlodipine', category: 'OBAT', form: 'Tablet', strength: '10 mg', uom: 'TAB', price: 700, cost: 220, min: 300 },
  { code: 'OB-CAP25', name: 'Captopril', generic: 'captopril', category: 'OBAT', form: 'Tablet', strength: '25 mg', uom: 'TAB', price: 400, cost: 120, min: 200 },
  { code: 'OB-MET500', name: 'Metformin', generic: 'metformin', category: 'OBAT', form: 'Tablet', strength: '500 mg', uom: 'TAB', price: 450, cost: 150, min: 300 },
  { code: 'OB-OME20', name: 'Omeprazole', generic: 'omeprazole', category: 'OBAT', form: 'Kapsul', strength: '20 mg', uom: 'KAP', price: 1200, cost: 400, min: 200 },
  { code: 'OB-SIM20', name: 'Simvastatin', generic: 'simvastatin', category: 'OBAT', form: 'Tablet', strength: '20 mg', uom: 'TAB', price: 800, cost: 250, min: 200 },
  { code: 'OB-CLO75', name: 'Clopidogrel', generic: 'clopidogrel', category: 'OBAT', form: 'Tablet', strength: '75 mg', uom: 'TAB', price: 2500, cost: 900, min: 100 },
  { code: 'OB-ASA80', name: 'Asam Asetilsalisilat', generic: 'asam asetilsalisilat', category: 'OBAT', form: 'Tablet', strength: '80 mg', uom: 'TAB', price: 300, cost: 90, min: 200 },
  { code: 'OB-IBU400', name: 'Ibuprofen', generic: 'ibuprofen', category: 'OBAT', form: 'Tablet', strength: '400 mg', uom: 'TAB', price: 600, cost: 200, min: 200 },
  { code: 'OB-WAR2', name: 'Warfarin', generic: 'warfarin', category: 'OBAT', form: 'Tablet', strength: '2 mg', uom: 'TAB', price: 1500, cost: 600, min: 50, highAlert: true },
  { code: 'OB-CTX1G', name: 'Ceftriaxone', generic: 'ceftriaxone', category: 'OBAT', form: 'Injeksi', strength: '1 g', uom: 'VIAL', price: 18000, cost: 7500, min: 100 },
  { code: 'OB-INSGL', name: 'Insulin Glargine', generic: 'insulin glargine', category: 'OBAT', form: 'Injeksi pen', strength: '100 IU/ml', uom: 'PEN', price: 185000, cost: 120000, min: 10, highAlert: true },
  { code: 'OB-KCL', name: 'Kalium Klorida 7,46%', generic: 'kalium klorida', category: 'OBAT', form: 'Injeksi', strength: '25 ml', uom: 'FLS', price: 22000, cost: 9000, min: 20, highAlert: true },
  { code: 'OB-MOR10', name: 'Morfin', generic: 'morfin', category: 'OBAT', form: 'Injeksi', strength: '10 mg/ml', uom: 'AMP', price: 35000, cost: 15000, min: 10, highAlert: true, narcotic: true },
  { code: 'OB-RL500', name: 'Ringer Laktat', generic: 'ringer laktat', category: 'OBAT', form: 'Infus', strength: '500 ml', uom: 'BTL', price: 15000, cost: 6500, min: 100 },
  { code: 'OB-NS500', name: 'Natrium Klorida 0,9%', generic: 'natrium klorida', category: 'OBAT', form: 'Infus', strength: '500 ml', uom: 'BTL', price: 14000, cost: 6000, min: 100 },
  { code: 'OB-MVIT', name: 'Multivitamin Premium', generic: 'multivitamin', category: 'OBAT', form: 'Tablet', strength: '-', uom: 'TAB', price: 3500, cost: 1500, min: 50, formulary: false },
  { code: 'BM-SPU3', name: 'Spuit 3 cc', generic: 'spuit', category: 'BMHP', uom: 'PCS', price: 3000, cost: 1100, min: 500 },
  { code: 'BM-IVC22', name: 'IV Catheter 22G', generic: 'iv catheter', category: 'BMHP', uom: 'PCS', price: 12000, cost: 5000, min: 200 },
  { code: 'BM-KASA', name: 'Kasa Steril 16x16', generic: 'kasa steril', category: 'BMHP', uom: 'BKS', price: 4500, cost: 1800, min: 300 },
];

export const SERVICES: { code: string; name: string; category: string; icd9?: string; loinc?: string; prices: number | Record<string, number> }[] = [
  { code: 'ADM-RJ', name: 'Administrasi Rawat Jalan', category: 'ADMINISTRASI', prices: 25000 },
  { code: 'ADM-IGD', name: 'Administrasi IGD', category: 'ADMINISTRASI', prices: 50000 },
  { code: 'ADM-RI', name: 'Administrasi Rawat Inap', category: 'ADMINISTRASI', prices: 100000 },
  { code: 'KONSUL-UMUM', name: 'Konsultasi Dokter Umum', category: 'KONSULTASI', prices: 75000 },
  { code: 'KONSUL-SPESIALIS', name: 'Konsultasi Dokter Spesialis', category: 'KONSULTASI', prices: 150000 },
  { code: 'IGD-PERIKSA', name: 'Pemeriksaan Dokter IGD', category: 'KONSULTASI', prices: 150000 },
  { code: 'VISITE', name: 'Visite Dokter', category: 'VISITE', prices: 100000 },
  { code: 'AKOMODASI', name: 'Akomodasi Rawat Inap', category: 'AKOMODASI', prices: { KELAS_3: 200000, KELAS_2: 350000, KELAS_1: 500000, KRIS: 300000, VIP: 900000, VVIP: 1500000, ICU: 1500000, ISOLASI: 750000 } },
  { code: 'LAB-DL', name: 'Darah Lengkap', category: 'LAB', loinc: '58410-2', prices: 85000 },
  { code: 'LAB-GDS', name: 'Gula Darah Sewaktu', category: 'LAB', loinc: '2345-7', prices: 30000 },
  { code: 'LAB-HBA1C', name: 'HbA1c', category: 'LAB', loinc: '4548-4', prices: 175000 },
  { code: 'LAB-KOL', name: 'Kolesterol Total', category: 'LAB', loinc: '2093-3', prices: 45000 },
  { code: 'LAB-RFT', name: 'Ureum & Kreatinin', category: 'LAB', loinc: '2160-0', prices: 90000 },
  { code: 'LAB-LFT', name: 'SGOT & SGPT', category: 'LAB', loinc: '1742-6', prices: 80000 },
  { code: 'LAB-ELEK', name: 'Elektrolit (Na, K, Cl)', category: 'LAB', loinc: '2823-3', prices: 150000 },
  { code: 'LAB-NS1', name: 'NS1 Antigen Dengue', category: 'LAB', loinc: '75377-2', prices: 200000 },
  { code: 'RAD-THX', name: 'Foto Thorax PA', category: 'RADIOLOGI', icd9: '87.44', prices: 175000 },
  { code: 'RAD-USGABD', name: 'USG Abdomen', category: 'RADIOLOGI', icd9: '88.76', prices: 300000 },
  { code: 'RAD-CTHEAD', name: 'CT Scan Kepala', category: 'RADIOLOGI', icd9: '87.03', prices: 950000 },
  { code: 'TND-HECT', name: 'Hecting / Jahit Luka', category: 'TINDAKAN', icd9: '86.59', prices: 150000 },
  { code: 'TND-NEBU', name: 'Nebulisasi', category: 'TINDAKAN', icd9: '93.94', prices: 75000 },
  { code: 'TND-EKG', name: 'Elektrokardiografi (EKG)', category: 'TINDAKAN', icd9: '89.52', prices: 90000 },
  { code: 'TND-INFUS', name: 'Pemasangan Infus', category: 'TINDAKAN', icd9: '38.93', prices: 60000 },
  { code: 'TND-GV', name: 'Perawatan Luka', category: 'TINDAKAN', icd9: '93.57', prices: 70000 },
];
