import { inject } from '@angular/core';
import { CanActivateFn, Router, Routes } from '@angular/router';
import { AuthService } from './core/api';
import { Shell } from './layout/shell';
import { LoginPage } from './pages/login';

const authGuard: CanActivateFn = () => (inject(AuthService).user() ? true : inject(Router).parseUrl('/login'));

export const routes: Routes = [
  { path: 'login', component: LoginPage, title: 'Masuk — SIMRS' },
  {
    path: '',
    component: Shell,
    canActivate: [authGuard],
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'home' },
      { path: 'home', title: 'Beranda', loadComponent: () => import('./pages/home').then((m) => m.HomePage) },
      { path: 'patients', title: 'Pasien', loadComponent: () => import('./pages/patients').then((m) => m.PatientsPage) },
      { path: 'patients/:id', title: 'Detail Pasien', loadComponent: () => import('./pages/patient-detail').then((m) => m.PatientDetailPage) },
      { path: 'registration', title: 'Pendaftaran', loadComponent: () => import('./pages/registration').then((m) => m.RegistrationPage) },
      { path: 'appointments', title: 'Janji Temu', loadComponent: () => import('./pages/appointments').then((m) => m.AppointmentsPage) },
      { path: 'queue', title: 'Antrean', loadComponent: () => import('./pages/queue').then((m) => m.QueuePage) },
      { path: 'beds', title: 'Manajemen Bed', loadComponent: () => import('./pages/beds').then((m) => m.BedsPage) },
      { path: 'encounters', title: 'Kunjungan', loadComponent: () => import('./pages/encounters').then((m) => m.EncountersPage) },
      { path: 'encounters/:id', title: 'Workspace Klinis', loadComponent: () => import('./pages/workspace').then((m) => m.WorkspacePage) },
      { path: 'ancillary/:category', title: 'Penunjang', loadComponent: () => import('./pages/ancillary').then((m) => m.AncillaryPage) },
      { path: 'pharmacy', title: 'Farmasi', loadComponent: () => import('./pages/pharmacy').then((m) => m.PharmacyPage) },
      { path: 'billing', title: 'Kasir & Billing', loadComponent: () => import('./pages/billing').then((m) => m.BillingPage) },
      { path: 'billing/encounters/:id', title: 'Billing Kunjungan', loadComponent: () => import('./pages/billing-encounter').then((m) => m.BillingEncounterPage) },
      { path: 'billing/invoices/:id', title: 'Kuitansi', loadComponent: () => import('./pages/invoice').then((m) => m.InvoicePage) },
      { path: 'claims', title: 'Klaim', loadComponent: () => import('./pages/claims').then((m) => m.ClaimsPage) },
      { path: 'inventory', title: 'Inventori', loadComponent: () => import('./pages/inventory').then((m) => m.InventoryPage) },
      { path: 'procurement', title: 'Pengadaan', loadComponent: () => import('./pages/procurement').then((m) => m.ProcurementPage) },
      { path: 'finance', title: 'Keuangan', loadComponent: () => import('./pages/finance').then((m) => m.FinancePage) },
      { path: 'quality', title: 'Mutu & Insiden', loadComponent: () => import('./pages/quality').then((m) => m.QualityPage) },
      { path: 'master', title: 'Master Data', loadComponent: () => import('./pages/master').then((m) => m.MasterPage) },
      { path: 'users', title: 'Pengguna', loadComponent: () => import('./pages/users').then((m) => m.UsersPage) },
      { path: 'governance', title: 'Audit & Integrasi', loadComponent: () => import('./pages/governance').then((m) => m.GovernancePage) },
    ],
  },
  { path: '**', redirectTo: '' },
];
