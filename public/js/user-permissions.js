/**
 * PR-2d · Módulo de Administración de Permisos por Usuario.
 *
 * Abre un modal grande desde el botón "🔧 Permisos" de cada fila de la tabla
 * de usuarios. Muestra identidad, rol RBAC, departamentos y permisos
 * efectivos. Permite cambiar rol, departamentos, suspender/reactivar,
 * forzar cambio de contraseña, generar password temporal y eliminar.
 *
 * Reglas de seguridad horizontal (espejo del backend):
 * - Si el target es admin (rol legacy='admin' o tiene rol 'admin_sistema'),
 *   se muestra un aviso rojo y se deshabilitan: cambio de rol, dept, reset
 *   password y eliminar. Solo se permite ver permisos efectivos.
 *
 * Backend usado (todo ya existente):
 * - GET    /api/rbac/users/:id/context     → roles, depts, permisos efectivos
 * - GET    /api/rbac/roles                 → catálogo
 * - GET    /api/rbac/departments           → catálogo
 * - POST   /api/rbac/users/:id/roles/:code → asignar rol
 * - DELETE /api/rbac/users/:id/roles/:code → quitar rol
 * - POST   /api/rbac/users/:id/departments/:deptId → asignar dept
 * - DELETE /api/rbac/users/:id/departments/:deptId → quitar dept
 * - PUT    /api/users/:id                  → suspender (is_active=0)
 * - DELETE /api/users/:id                  → eliminar
 */
(function () {
    const userPerm = {
        currentUserId: null,
        currentContext: null,
        catalogRoles: [],
        catalogDepts: [],
        originalRole: null,
        originalDepts: new Set(),

        async open(userId) {
            this.currentUserId = userId;
            document.getElementById('user-perm-userid').value = userId;

            // Reset al estado inicial del modal
            this.switchTab('summary');
            document.getElementById('user-perm-admin-notice').style.display = 'none';
            document.getElementById('user-perm-is-admin').value = '0';

            // Abrir el modal antes del fetch para dar feedback inmediato
            document.getElementById('user-permissions-modal').classList.add('active');

            try {
                await Promise.all([
                    this.loadCatalogs(),
                    this.loadContext()
                ]);
                this.render();
            } catch (err) {
                console.error('[userPerm] error loading', err);
                Notification.error('No se pudo cargar el contexto del usuario');
            }
        },

        async loadCatalogs() {
            const headers = { Authorization: 'Bearer ' + Utils.getToken() };
            const [rolesR, deptsR] = await Promise.all([
                fetch('/api/rbac/roles', { headers }).then(r => r.json()),
                fetch('/api/rbac/departments', { headers }).then(r => r.json())
            ]);
            this.catalogRoles = (rolesR.data && rolesR.data.roles) || [];
            this.catalogDepts = (deptsR.data && deptsR.data.departments) || [];
        },

        async loadContext() {
            const headers = { Authorization: 'Bearer ' + Utils.getToken() };
            const r = await fetch(`/api/rbac/users/${this.currentUserId}/context`, { headers });
            const json = await r.json();
            this.currentContext = (json.data && json.data.context) || json.data || json;
        },

        render() {
            const ctx = this.currentContext;
            if (!ctx || !ctx.user) {
                Notification.error('Contexto inválido');
                return;
            }

            const user = ctx.user;
            const userRoles = ctx.roles || [];
            const userDepts = ctx.departments || ctx.depts || [];
            const userPerms = ctx.permissions || ctx.effective_permissions || [];

            // ---- Header: avatar + nombre + email + pills ----
            const initial = (user.full_name || user.username || '?').charAt(0).toUpperCase();
            document.getElementById('user-perm-avatar').textContent = initial;
            document.getElementById('user-perm-name').textContent = user.full_name || user.username;
            document.getElementById('user-perm-email').textContent = user.email || '';

            const isLegacyAdmin = user.role === 'admin';
            const hasAdminRole = userRoles.some(r => (r.code || r) === 'admin_sistema');
            const isAdmin = isLegacyAdmin || hasAdminRole;
            document.getElementById('user-perm-is-admin').value = isAdmin ? '1' : '0';

            // Pills de roles + departamentos
            const pillsContainer = document.getElementById('user-perm-pills');
            const rolePills = userRoles.length > 0
                ? userRoles.map(r => {
                    const code = r.code || r;
                    const name = r.name || code;
                    return `<span class="role-pill role-${code}"><span class="role-dot"></span>${escapeHtml(name)}</span>`;
                }).join('')
                : `<span class="role-pill role-none">Sin rol RBAC asignado</span>`;
            const deptPills = userDepts.length > 0
                ? userDepts.map(d => {
                    const name = d.name || d.code || d;
                    return `<span class="dept-pill">${escapeHtml(name)}</span>`;
                }).join('')
                : `<span class="role-pill role-none">Sin departamento</span>`;
            pillsContainer.innerHTML = rolePills + deptPills;

            // ---- Aviso de admin bloqueado ----
            if (isAdmin) {
                document.getElementById('user-perm-admin-notice').style.display = 'block';
                document.getElementById('user-perm-save-btn').disabled = true;
                document.getElementById('user-perm-save-btn').classList.add('btn-locked');
            } else {
                document.getElementById('user-perm-admin-notice').style.display = 'none';
                document.getElementById('user-perm-save-btn').disabled = false;
                document.getElementById('user-perm-save-btn').classList.remove('btn-locked');
            }

            // ---- Pane "Resumen": rol y deptos ----
            this.renderRoleSelect(userRoles, isAdmin);
            this.renderDeptCheckboxes(userDepts, isAdmin);

            // ---- Pane "Permisos efectivos" ----
            this.renderEffectivePermissions(userPerms, isAdmin);

            // ---- Pane "Cuenta" ----
            this.renderAccountTab(user, isAdmin);
        },

        renderRoleSelect(userRoles, isAdmin) {
            const select = document.getElementById('user-perm-role');
            // El primer rol RBAC asignado (el modelo soporta múltiples, pero la UI
            // simplifica a uno principal). Si después se quiere multi-rol, esto
            // pasa a checkboxes — para el admin no-técnico, dropdown es más claro.
            const currentCode = userRoles.length > 0 ? (userRoles[0].code || userRoles[0]) : '';
            this.originalRole = currentCode;

            const opts = ['<option value="">— Sin rol RBAC —</option>'];
            for (const r of this.catalogRoles) {
                const code = r.code;
                const name = r.name || code;
                const selected = code === currentCode ? 'selected' : '';
                opts.push(`<option value="${escapeHtml(code)}" ${selected}>${escapeHtml(name)}</option>`);
            }
            select.innerHTML = opts.join('');
            select.disabled = isAdmin;
        },

        renderDeptCheckboxes(userDepts, isAdmin) {
            const container = document.getElementById('user-perm-depts');
            const userDeptIds = new Set(userDepts.map(d => Number(d.id)));
            this.originalDepts = new Set(userDeptIds);

            if (this.catalogDepts.length === 0) {
                container.innerHTML = '<em style="color:var(--text-3); font-size:0.85rem; grid-column:1/-1;">No hay departamentos creados</em>';
                return;
            }

            container.innerHTML = this.catalogDepts.map(d => {
                const checked = userDeptIds.has(Number(d.id)) ? 'checked' : '';
                const disabled = isAdmin ? 'disabled' : '';
                return `
                    <label class="dept-check">
                        <input type="checkbox" value="${d.id}" data-dept-code="${escapeHtml(d.code)}" ${checked} ${disabled}>
                        <span>${escapeHtml(d.name || d.code)}</span>
                    </label>
                `;
            }).join('');
        },

        renderEffectivePermissions(perms, _isAdmin) {
            const container = document.getElementById('user-perm-effective');

            // Vocabulario plano para el admin no-técnico. Mapea permission codes
            // a frases legibles. Los códigos sin mapeo muestran el code crudo.
            const PRETTY = {
                'system.admin':              'Acceso total al sistema',
                'users.read':                'Ver lista de usuarios',
                'users.write':               'Crear, editar, eliminar usuarios',
                'roles.manage':              'Asignar roles a otros',
                'departments.manage':        'Gestionar departamentos',
                'categories.manage':         'Gestionar categorías',
                'reports.read.all':          'Ver todos los reportes',
                'reports.read.assigned':     'Ver reportes asignados',
                'reports.write':             'Crear/editar reportes',
                'documents.read.all':        'Ver todos los documentos',
                'documents.read.assigned':   'Ver documentos asignados',
                'documents.write':           'Subir y borrar documentos',
                'cotizador.use':             'Usar el Cotizador',
                'cotizador.tarifas.manage':  'Configurar tarifas del Cotizador',
                'permissions.manage':        'Asignar permisos a otros',
                'audit.read':                'Ver logs de auditoría',
                'hr.read.own':               'Ver su propio perfil RRHH',
                'hr.read.team':              'Ver empleados de su equipo',
                'hr.read.all':               'Ver todos los empleados',
                'hr.write':                  'Editar empleados',
                'hr.documents.upload':       'Subir documentos al expediente',
                'hr.positions.manage':       'Gestionar perfiles de cargo',
                'hr.holidays.manage':        'Gestionar feriados',
                'hr.attendance.manage':      'Registrar asistencia',
                'hr.timeoff.request':        'Solicitar días libres',
                'hr.timeoff.approve':        'Aprobar solicitudes de tiempo libre',
                'hr.memos.read':             'Leer memos dirigidos a él',
                'hr.memos.write':            'Emitir memos'
            };

            // perms puede venir como array de strings (codes) o array de objects {code, ...}
            const userPermCodes = new Set(
                (perms || []).map(p => typeof p === 'string' ? p : (p.code || p.permission_code))
            );

            // Renderizar TODOS los permisos del catálogo (los que tiene = granted,
            // los que no tiene = denied tachado). Esto da auditoría completa: el
            // admin ve qué le falta al usuario sin tener que adivinar.
            const allCodes = Object.keys(PRETTY);
            container.innerHTML = allCodes.map(code => {
                const granted = userPermCodes.has(code) || userPermCodes.has('system.admin');
                const label = PRETTY[code];
                const icon = granted ? '✓' : '×';
                const cls = granted ? 'granted' : 'denied';
                return `
                    <div class="perm-effective-item ${cls}">
                        <span class="perm-icon">${icon}</span>
                        <span>${escapeHtml(label)}</span>
                    </div>
                `;
            }).join('');
        },

        renderAccountTab(user, isAdmin) {
            const isActive = user.is_active !== false && user.is_active !== 0;
            const statusLabel = document.getElementById('user-perm-status-label');
            const toggleBtn = document.getElementById('user-perm-toggle-status');
            statusLabel.textContent = isActive ? 'Activo' : 'Suspendido';
            toggleBtn.textContent = isActive ? 'Suspender' : 'Reactivar';
            toggleBtn.disabled = isAdmin;
            toggleBtn.classList.toggle('btn-locked', isAdmin);

            // Aplicar bloqueo visual a todos los botones de la pane Account
            const accountPane = document.querySelector('[data-perm-pane="account"]');
            const buttons = accountPane.querySelectorAll('button');
            buttons.forEach(b => {
                b.disabled = isAdmin;
                b.classList.toggle('btn-locked', isAdmin);
            });
        },

        switchTab(tabName) {
            document.querySelectorAll('.user-perm-tab').forEach(t => {
                t.classList.toggle('active', t.dataset.permTab === tabName);
            });
            document.querySelectorAll('.user-perm-pane').forEach(p => {
                p.classList.toggle('active', p.dataset.permPane === tabName);
            });
        },

        async save() {
            if (document.getElementById('user-perm-is-admin').value === '1') {
                Notification.error('No podés modificar permisos de un Administrador');
                return;
            }

            const userId = this.currentUserId;
            const newRole = document.getElementById('user-perm-role').value;
            const selectedDepts = Array.from(document.querySelectorAll('#user-perm-depts input[type=checkbox]:checked'))
                .map(cb => ({ id: Number(cb.value), code: cb.dataset.deptCode }));

            const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + Utils.getToken() };
            const operations = [];

            // Diff de rol: quitar el viejo si cambió, agregar el nuevo
            if (newRole !== this.originalRole) {
                if (this.originalRole) {
                    operations.push({
                        label: `Quitar rol ${this.originalRole}`,
                        run: () => fetch(`/api/rbac/users/${userId}/roles/${this.originalRole}`, { method: 'DELETE', headers })
                    });
                }
                if (newRole) {
                    operations.push({
                        label: `Asignar rol ${newRole}`,
                        run: () => fetch(`/api/rbac/users/${userId}/roles/${newRole}`, { method: 'POST', headers })
                    });
                }
            }

            // Diff de departamentos
            const newDeptIds = new Set(selectedDepts.map(d => d.id));
            for (const oldId of this.originalDepts) {
                if (!newDeptIds.has(oldId)) {
                    operations.push({
                        label: `Quitar depto ${oldId}`,
                        run: () => fetch(`/api/rbac/users/${userId}/departments/${oldId}`, { method: 'DELETE', headers })
                    });
                }
            }
            for (const d of selectedDepts) {
                if (!this.originalDepts.has(d.id)) {
                    operations.push({
                        label: `Asignar depto ${d.code}`,
                        run: () => fetch(`/api/rbac/users/${userId}/departments/${d.id}`, { method: 'POST', headers })
                    });
                }
            }

            if (operations.length === 0) {
                Notification.info('No hay cambios para guardar');
                return;
            }

            try {
                for (const op of operations) {
                    const r = await op.run();
                    if (!r.ok) {
                        const j = await r.json().catch(() => ({}));
                        throw new Error(j.message || op.label + ' falló');
                    }
                }
                Notification.success(`${operations.length} cambio(s) aplicados`);
                closeModal('user-permissions-modal');
                if (typeof loadUsers === 'function') loadUsers();
            } catch (err) {
                console.error('[userPerm] save error', err);
                Notification.error(err.message || 'Error al guardar');
            }
        },

        async toggleStatus() {
            const userId = this.currentUserId;
            const ctx = this.currentContext;
            const isActive = ctx.user.is_active !== false && ctx.user.is_active !== 0;
            const newState = !isActive;
            const action = newState ? 'reactivar' : 'suspender';
            if (!confirm(`¿Seguro que querés ${action} a ${ctx.user.full_name || ctx.user.username}?`)) return;

            try {
                const r = await fetch(`/api/users/${userId}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + Utils.getToken() },
                    body: JSON.stringify({ is_active: newState ? 1 : 0 })
                });
                if (!r.ok) throw new Error('No se pudo cambiar el estado');
                Notification.success(`Usuario ${newState ? 'reactivado' : 'suspendido'}`);
                this.loadContext().then(() => this.render());
                if (typeof loadUsers === 'function') loadUsers();
            } catch (err) {
                Notification.error(err.message);
            }
        },

        async forceChangePassword() {
            const userId = this.currentUserId;
            if (!confirm('¿Forzar cambio de contraseña en el próximo login?')) return;
            try {
                const r = await fetch(`/api/users/${userId}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + Utils.getToken() },
                    body: JSON.stringify({ must_change_password: 1 })
                });
                if (!r.ok) throw new Error('No se pudo forzar el cambio');
                Notification.success('El usuario deberá cambiar su contraseña al iniciar sesión');
            } catch (err) {
                Notification.error(err.message);
            }
        },

        async resetPassword() {
            const userId = this.currentUserId;
            if (!confirm('Esto generará una contraseña temporal nueva. ¿Continuar?')) return;
            const temp = generateTempPassword();
            try {
                const r = await fetch(`/api/users/${userId}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + Utils.getToken() },
                    body: JSON.stringify({ password: temp, must_change_password: 1 })
                });
                if (!r.ok) throw new Error('No se pudo generar la contraseña');
                // Mostrar la temp UNA VEZ con copy
                showTempPasswordDialog(temp);
            } catch (err) {
                Notification.error(err.message);
            }
        },

        async deleteUser() {
            const userId = this.currentUserId;
            const ctx = this.currentContext;
            const name = ctx.user.full_name || ctx.user.username;
            if (!confirm(`¿ELIMINAR a ${name}? Esta acción no se puede deshacer.`)) return;
            if (!confirm('Confirmación final: ¿estás seguro?')) return;
            try {
                const r = await fetch(`/api/users/${userId}`, {
                    method: 'DELETE',
                    headers: { Authorization: 'Bearer ' + Utils.getToken() }
                });
                if (!r.ok) {
                    const j = await r.json().catch(() => ({}));
                    throw new Error(j.message || 'No se pudo eliminar');
                }
                Notification.success('Usuario eliminado');
                closeModal('user-permissions-modal');
                if (typeof loadUsers === 'function') loadUsers();
            } catch (err) {
                Notification.error(err.message);
            }
        }
    };

    // Helpers locales
    function escapeHtml(s) {
        if (s === null || s === undefined) return '';
        return String(s).replace(/[&<>"']/g, c => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[c]));
    }

    function generateTempPassword() {
        const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
        let out = '';
        for (let i = 0; i < 12; i++) out += chars.charAt(Math.floor(Math.random() * chars.length));
        return out;
    }

    function showTempPasswordDialog(temp) {
        const html = `
            <div style="text-align:center;">
                <p style="margin-bottom:0.5rem;">Contraseña temporal generada:</p>
                <code style="display:block; padding:1rem; background:var(--bg-elevated); border:1px solid var(--border); border-radius:var(--radius-md); font-size:1.2rem; letter-spacing:0.1em; margin:0.5rem 0;">${temp}</code>
                <p style="font-size:0.82rem; color:var(--text-3);">Cópiala ahora. No se mostrará de nuevo.</p>
                <button class="btn btn-primary" onclick="navigator.clipboard.writeText('${temp}'); this.textContent='✓ Copiado';" style="margin-top:0.75rem;">📋 Copiar al portapapeles</button>
            </div>
        `;
        // Reusa el Notification system o muestra un alert simple
        if (typeof Notification !== 'undefined' && Notification.dialog) {
            Notification.dialog({ title: 'Contraseña temporal', html, closeText: 'Listo' });
        } else {
            const w = window.open('', '', 'width=420,height=300');
            w.document.body.innerHTML = `<div style="font-family:system-ui; padding:1.5rem; text-align:center;">${html}</div>`;
        }
    }

    // Listener para tabs internos del modal
    document.addEventListener('click', (e) => {
        const tab = e.target.closest('.user-perm-tab');
        if (tab) {
            e.preventDefault();
            userPerm.switchTab(tab.dataset.permTab);
        }
    });

    // Submit del form
    document.addEventListener('submit', (e) => {
        if (e.target.id === 'user-perm-form') {
            e.preventDefault();
            userPerm.save();
        }
    });

    // Expose global
    window.userPerm = userPerm;
    window.openUserPermissions = (userId) => userPerm.open(userId);
})();
