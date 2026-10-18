import { Component, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Api } from '../core/api';
import { PIPES, Toasts } from '../core/ui';
import { SHARED } from '../shared/components';

@Component({
  selector: 'app-users',
  imports: [FormsModule, ...SHARED, ...PIPES],
  template: `
    <app-page-header title="Pengguna & Peran" subtitle="RBAC per peran + ABAC unit kerja/DPJP. Prinsip least privilege; akun dinonaktifkan, tidak dihapus.">
      <button class="btn btn-primary" (click)="startNew()">+ Pengguna</button>
    </app-page-header>
    <div class="card overflow-x-auto">
      <table class="tbl">
        <thead><tr><th>Username</th><th>Nama</th><th>Peran</th><th>Unit</th><th>Login terakhir</th><th>Status</th><th></th></tr></thead>
        <tbody>
          @for (u of rows(); track u.id) {
            <tr>
              <td class="font-medium">{{ u.username }}</td><td>{{ u.fullName }}</td>
              <td>@for (r of u.roles; track r) { <span class="badge badge-info mr-1">{{ r }}</span> }</td>
              <td>{{ unitName(u.unitId) }}</td><td>{{ u.lastLoginAt | dt }}</td>
              <td>@if (!u.active) { <span class="badge badge-neutral">Nonaktif</span> } @else if (u.lockedUntil && u.lockedUntil > now) { <span class="badge badge-critical">Terkunci</span> } @else { <span class="badge badge-success">Aktif</span> }</td>
              <td><button class="btn btn-sm" (click)="startEdit(u)">Ubah</button></td>
            </tr>
          }
        </tbody>
      </table>
    </div>

    @if (editing) {
      <app-modal [title]="editing.id ? 'Ubah pengguna' : 'Pengguna baru'" [width]="640" (closed)="editing = null">
        <div class="grid sm:grid-cols-2 gap-3">
          @if (!editing.id) { <div class="field"><label class="label">Username</label><input class="input" [(ngModel)]="editing.username" /></div> }
          <div class="field"><label class="label">Nama lengkap</label><input class="input" [(ngModel)]="editing.fullName" /></div>
          <div class="field"><label class="label">{{ editing.id ? 'Reset kata sandi (opsional)' : 'Kata sandi' }}</label><input class="input" type="password" [(ngModel)]="editing.password" placeholder="min. 10, huruf besar/kecil & angka" /></div>
          <div class="field"><label class="label">Unit kerja</label><select class="input" [(ngModel)]="editing.unitId"><option [ngValue]="null">—</option>@for (u of units(); track u.id) {<option [ngValue]="u.id">{{ u.name }}</option>}</select></div>
          <div class="field"><label class="label">Tautan tenaga kesehatan</label><select class="input" [(ngModel)]="editing.practitionerId"><option [ngValue]="null">—</option>@for (p of practitioners(); track p.id) {<option [ngValue]="p.id">{{ p.name }}</option>}</select></div>
          @if (editing.id) { <label class="text-sm flex items-center gap-2 mt-5"><input type="checkbox" [(ngModel)]="editing.active" /> Aktif</label> }
          <div class="sm:col-span-2"><div class="label">Peran</div>
            <div class="flex flex-wrap gap-2">@for (r of roles(); track r) {
              <label class="badge badge-neutral cursor-pointer"><input type="checkbox" [checked]="editing.roles.includes(r)" (change)="toggleRole(r)" /> {{ r }}</label>
            }</div></div>
        </div>
        <div class="flex justify-end mt-3"><button class="btn btn-primary" (click)="save()">Simpan</button></div>
      </app-modal>
    }
  `,
})
export class UsersPage implements OnInit {
  private readonly api = inject(Api);
  private readonly toasts = inject(Toasts);
  readonly rows = signal<any[]>([]);
  readonly roles = signal<string[]>([]);
  readonly units = signal<any[]>([]);
  readonly practitioners = signal<any[]>([]);
  readonly now = new Date().toISOString();
  editing: any = null;

  async ngOnInit() {
    const [r, u, p] = await Promise.all([this.api.get('/users/roles'), this.api.get('/master/units'), this.api.get('/master/practitioners')]);
    this.roles.set(r);
    this.units.set(u);
    this.practitioners.set(p);
    await this.load();
  }

  async load() {
    this.rows.set(await this.api.get('/users'));
  }

  unitName(id: string) {
    return this.units().find((u) => u.id === id)?.name ?? '—';
  }

  startNew() {
    this.editing = { username: '', fullName: '', password: '', roles: [], unitId: null, practitionerId: null };
  }

  startEdit(u: any) {
    this.editing = { ...u, roles: [...u.roles], password: '' };
  }

  toggleRole(r: string) {
    const roles: string[] = this.editing.roles;
    this.editing.roles = roles.includes(r) ? roles.filter((x) => x !== r) : [...roles, r];
  }

  async save() {
    const e = this.editing;
    try {
      if (e.id) {
        await this.api.patch(`/users/${e.id}`, { fullName: e.fullName, roles: e.roles, unitId: e.unitId, practitionerId: e.practitionerId, active: e.active, ...(e.password ? { password: e.password } : {}) });
      } else {
        await this.api.post('/users', { username: e.username, fullName: e.fullName, password: e.password, roles: e.roles, unitId: e.unitId, practitionerId: e.practitionerId });
      }
      this.toasts.success('Pengguna tersimpan');
      this.editing = null;
      await this.load();
    } catch (err: any) {
      this.toasts.error(err.details ? `${err.message}: ${err.details.map((d: any) => `${d.path} ${d.message}`).join('; ')}` : err);
    }
  }
}
