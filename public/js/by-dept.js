/**
 * PR-8a · Vista "Por Departamento" en Administración.
 *
 * Renderiza una tarjeta por departamento con:
 *   - Header: nombre + count de personas + permisos heredados
 *   - Botones de gestión: Reportes / Documentos / Módulos (los modales
 *     concretos llegan en PR-8b/c/d)
 *   - Lista de personas del depto con botón "Editar" que abre el modal
 *     existente openUserPermissions() para casos individuales.
 *
 * Backend usado (todo existente):
 *   - GET /api/rbac/departments
 *   - GET /api/users?limit=500   (devuelve `departments` como string)
 *
 * Se hidrata al entrar a la tab "Por Departamento" y se refresca cuando
 * se cierra el modal de Editar (porque pudieron cambiar deptos del user).
 */
(function () {
    let _depts = [];
    let _users = [];
    let _initialized = false;

    async function init() {
        if (_initialized) return;
        _initialized = true;
        // Listener: cuando se hace click en la tab, cargamos los datos
        document.addEventListener('click', (e) => {
            const tab = e.target.closest('.tab-btn[data-tab="by-dept"]');
            if (tab) reload();
        });
        // Cargar al iniciar admin section
        reload();
    }

    async function reload() {
        const grid = document.getElementById('by-dept-grid');
        if (!grid) return;
        grid.innerHTML = '<div class="loading" style="grid-column:1/-1; text-align:center; padding:2rem; color:var(--text-3);">Cargando departamentos…</div>';
        try {
            const headers = { Authorization: 'Bearer ' + Utils.getToken() };
            const [deptsR, usersR] = await Promise.all([
                fetch('/api/rbac/departments', { headers }).then(r => r.json()),
                fetch('/api/users?limit=500',    { headers }).then(r => r.json())
            ]);
            _depts = (deptsR.data && deptsR.data.departments) || [];
            _users = (usersR.data && usersR.data.users) || [];
            render();
        } catch (err) {
            console.error('by-dept reload error:', err);
            grid.innerHTML = '<div class="error" style="grid-column:1/-1; text-align:center; padding:2rem; color:var(--danger);">No se pudieron cargar los departamentos</div>';
        }
    }

    function usersOfDept(deptName) {
        return _users.filter(u => {
            const deptStr = (u.departments || '').toLowerCase();
            return deptStr.split(',').map(s => s.trim()).includes(deptName.toLowerCase());
        });
    }

    function usersWithoutDept() {
        return _users.filter(u => !u.departments || u.departments.trim() === '');
    }

    function render() {
        const grid = document.getElementById('by-dept-grid');
        if (!grid) return;
        if (_depts.length === 0) {
            grid.innerHTML = '<div class="empty" style="grid-column:1/-1; text-align:center; padding:2rem; color:var(--text-3);">No hay departamentos creados. Andá a la tab "Departamentos" para crear uno.</div>';
            return;
        }
        const cards = _depts.map(d => renderCard(d, usersOfDept(d.name))).join('');
        const orphans = usersWithoutDept();
        const orphanCard = orphans.length > 0
            ? renderOrphanCard(orphans)
            : '';
        grid.innerHTML = cards + orphanCard;
    }

    function renderCard(dept, users) {
        const count = users.length;
        const usersList = users.length > 0
            ? users.map(u => `
                <div class="by-dept-person">
                    <div class="by-dept-avatar">${escapeHtml((u.full_name || u.username || '?').charAt(0).toUpperCase())}</div>
                    <div class="by-dept-person-info">
                        <div class="by-dept-person-name">${escapeHtml(u.full_name)}</div>
                        <div class="by-dept-person-meta">${escapeHtml(u.email)}${u.role === 'admin' ? ' · <span class="by-dept-admin-tag">ADMIN</span>' : ''}</div>
                    </div>
                    <button class="by-dept-person-edit" onclick="openUserPermissions(${u.id})" title="Editar permisos individuales">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
                    </button>
                </div>
            `).join('')
            : '<div class="by-dept-empty">Sin personas en este departamento</div>';

        return `
            <div class="by-dept-card" data-dept-id="${dept.id}" data-dept-code="${escapeHtml(dept.code)}">
                <div class="by-dept-card-header">
                    <div class="by-dept-card-title">
                        <span class="by-dept-card-icon">🏢</span>
                        <div>
                            <div class="by-dept-card-name">${escapeHtml(dept.name)}</div>
                            <div class="by-dept-card-count">${count} ${count === 1 ? 'persona' : 'personas'}</div>
                        </div>
                    </div>
                </div>

                <div class="by-dept-actions">
                    <button class="by-dept-action-btn" onclick="byDept.openReports(${dept.id}, '${escapeHtml(dept.name).replace(/'/g, "\\'")}')">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><rect x="3" y="3" width="18" height="18" rx="2"></rect><line x1="9" y1="9" x2="15" y2="9"></line><line x1="9" y1="13" x2="15" y2="13"></line></svg>
                        <span>Reportes</span>
                    </button>
                    <button class="by-dept-action-btn" onclick="byDept.openDocs(${dept.id}, '${escapeHtml(dept.name).replace(/'/g, "\\'")}')">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>
                        <span>Documentos</span>
                    </button>
                    <button class="by-dept-action-btn" onclick="byDept.openModules(${dept.id}, '${escapeHtml(dept.name).replace(/'/g, "\\'")}')">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><rect x="3" y="3" width="7" height="7"></rect><rect x="14" y="3" width="7" height="7"></rect><rect x="3" y="14" width="7" height="7"></rect><rect x="14" y="14" width="7" height="7"></rect></svg>
                        <span>Módulos</span>
                    </button>
                </div>

                <div class="by-dept-people-title">Personas del departamento</div>
                <div class="by-dept-people-list">${usersList}</div>
            </div>
        `;
    }

    function renderOrphanCard(users) {
        const usersList = users.map(u => `
            <div class="by-dept-person">
                <div class="by-dept-avatar">${escapeHtml((u.full_name || u.username || '?').charAt(0).toUpperCase())}</div>
                <div class="by-dept-person-info">
                    <div class="by-dept-person-name">${escapeHtml(u.full_name)}</div>
                    <div class="by-dept-person-meta">${escapeHtml(u.email)}${u.role === 'admin' ? ' · <span class="by-dept-admin-tag">ADMIN</span>' : ''}</div>
                </div>
                <button class="by-dept-person-edit" onclick="openUserPermissions(${u.id})" title="Asignar departamento o editar permisos">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
                </button>
            </div>
        `).join('');
        return `
            <div class="by-dept-card by-dept-card-orphan">
                <div class="by-dept-card-header">
                    <div class="by-dept-card-title">
                        <span class="by-dept-card-icon">❓</span>
                        <div>
                            <div class="by-dept-card-name">Sin departamento asignado</div>
                            <div class="by-dept-card-count">${users.length} ${users.length === 1 ? 'persona' : 'personas'}</div>
                        </div>
                    </div>
                </div>
                <p style="margin: 0 0 0.85rem 0; font-size:0.82rem; color:var(--text-3);">
                    Estas personas no pertenecen a ningún departamento. Editalas y asignáles uno para que hereden los permisos del depto.
                </p>
                <div class="by-dept-people-list">${usersList}</div>
            </div>
        `;
    }

    // PR-8b: modal "Gestionar Reportes" del departamento.
    // Abre un modal con lista de reportes del sistema y checkboxes
    // indicando cuáles están asignados al depto via resource_acl.
    async function openReports(deptId, deptName) {
        const modal = ensureResourceModal('reports', deptId, deptName);
        const list = modal.querySelector('.dept-resource-list');
        list.innerHTML = '<div class="loading" style="padding:1rem; text-align:center; color:var(--text-3);">Cargando reportes…</div>';
        modal.classList.add('active');

        try {
            const headers = { Authorization: 'Bearer ' + Utils.getToken() };
            const [reportsR, aclsR] = await Promise.all([
                fetch('/api/reports', { headers }).then(r => r.json()),
                fetch(`/api/rbac/acl/principal/department/${deptId}`, { headers }).then(r => r.json())
            ]);
            const reports = (reportsR.data && reportsR.data.reports) || reportsR.data || [];
            const acls = (aclsR.data && aclsR.data.acls) || aclsR.data || [];
            // Set de resource_id de reportes ya asignados al depto
            const assignedReportIds = new Set(
                acls.filter(a => a.resource_type === 'report').map(a => Number(a.resource_id))
            );
            modal.dataset.initialAssigned = JSON.stringify(Array.from(assignedReportIds));

            if (reports.length === 0) {
                list.innerHTML = '<div class="empty" style="padding:1rem; text-align:center; color:var(--text-3); font-style:italic;">No hay reportes creados todavía. Andá a Administración › Reportes para crear uno.</div>';
                return;
            }
            list.innerHTML = reports.map(r => {
                const checked = assignedReportIds.has(Number(r.id)) ? 'checked' : '';
                return `
                    <label class="dept-resource-row">
                        <input type="checkbox" data-resource-id="${r.id}" ${checked}>
                        <div class="dept-resource-info">
                            <div class="dept-resource-name">${escapeHtml(r.name)}</div>
                            ${r.category ? `<div class="dept-resource-meta">${escapeHtml(r.category)}</div>` : ''}
                        </div>
                    </label>
                `;
            }).join('');
        } catch (err) {
            console.error('openReports error:', err);
            list.innerHTML = `<div class="error" style="padding:1rem; text-align:center; color:var(--danger);">Error al cargar reportes</div>`;
        }
    }

    // PR-8c: modal "Gestionar Documentos" del departamento. Mismo patrón
    // que openReports, pero pide /api/documents y filtra por resource_type
    // ='document' al leer las ACLs.
    async function openDocs(deptId, deptName) {
        const modal = ensureResourceModal('docs', deptId, deptName);
        const list = modal.querySelector('.dept-resource-list');
        list.innerHTML = '<div class="loading" style="padding:1rem; text-align:center; color:var(--text-3);">Cargando documentos…</div>';
        modal.classList.add('active');

        try {
            const headers = { Authorization: 'Bearer ' + Utils.getToken() };
            const [docsR, aclsR] = await Promise.all([
                fetch('/api/documents', { headers }).then(r => r.json()),
                fetch(`/api/rbac/acl/principal/department/${deptId}`, { headers }).then(r => r.json())
            ]);
            const docs = (docsR.data && docsR.data.documents) || docsR.data || [];
            const acls = (aclsR.data && aclsR.data.acls) || aclsR.data || [];
            const assignedDocIds = new Set(
                acls.filter(a => a.resource_type === 'document').map(a => Number(a.resource_id))
            );
            modal.dataset.initialAssigned = JSON.stringify(Array.from(assignedDocIds));

            if (docs.length === 0) {
                list.innerHTML = '<div class="empty" style="padding:1rem; text-align:center; color:var(--text-3); font-style:italic;">No hay documentos cargados todavía. Andá a Administración › Documentos para subir uno.</div>';
                return;
            }
            list.innerHTML = docs.map(d => {
                const checked = assignedDocIds.has(Number(d.id)) ? 'checked' : '';
                return `
                    <label class="dept-resource-row">
                        <input type="checkbox" data-resource-id="${d.id}" ${checked}>
                        <div class="dept-resource-info">
                            <div class="dept-resource-name">${escapeHtml(d.name || d.filename || 'Sin nombre')}</div>
                            ${d.category ? `<div class="dept-resource-meta">${escapeHtml(d.category)}</div>` : ''}
                        </div>
                    </label>
                `;
            }).join('');
        } catch (err) {
            console.error('openDocs error:', err);
            list.innerHTML = `<div class="error" style="padding:1rem; text-align:center; color:var(--danger);">Error al cargar documentos</div>`;
        }
    }
    // PR-8d + PR-9: modal "Módulos del depto" — interactivo.
    // Cada columna tiene 2 niveles:
    //   - Cabecera = switch maestro (bulk: prende/apaga para todo el depto)
    //   - Celda por user = toggle individual
    // Módulos gestionables: Cotizador (cotizador.use), RRHH (hr.read.own).
    // Reportes/Documentos son ✓ siempre y se gestionan con sus botones
    // específicos del card.
    const MODULES = [
        { key: 'cot', label: '💲 Cotizador', perm: 'cotizador.use', toggleable: true },
        { key: 'hr',  label: '👥 RRHH',      perm: 'hr.read.own',   toggleable: true }
    ];
    // Cache del último deptId + ctxs cargados (para refresh tras un toggle)
    let _modulesModalState = { deptId: null, deptName: null, ctxs: [] };

    async function openModules(deptId, deptName) {
        let modal = document.getElementById('dept-modules-modal');
        if (!modal) {
            modal = document.createElement('div');
            modal.id = 'dept-modules-modal';
            modal.className = 'modal';
            modal.innerHTML = `
                <div class="modal-content" style="max-width: 780px;">
                    <div class="modal-header">
                        <h3 class="dept-modules-title">Módulos del departamento</h3>
                        <button class="btn-close" onclick="document.getElementById('dept-modules-modal').classList.remove('active')">&times;</button>
                    </div>
                    <div class="modal-body">
                        <p style="font-size:0.85rem; color:var(--text-3); margin: 0 0 0.85rem 0;">
                            Qué módulos puede usar cada persona del departamento. Los permisos vienen del <strong>rol RBAC</strong> de cada user. Para cambiarlos, click en <strong>Editar</strong> del usuario.
                        </p>
                        <div class="dept-modules-table-wrap">
                            <table class="dept-modules-table">
                                <thead id="dept-modules-thead">
                                    <!-- Cabeceras dinámicas con switches maestros — render en JS -->
                                </thead>
                                <tbody id="dept-modules-tbody"></tbody>
                            </table>
                        </div>
                    </div>
                    <div class="modal-footer">
                        <button type="button" class="btn btn-outline" onclick="document.getElementById('dept-modules-modal').classList.remove('active')">Cerrar</button>
                    </div>
                </div>
            `;
            document.body.appendChild(modal);
        }
        modal.querySelector('.dept-modules-title').textContent = `Módulos del depto: ${deptName}`;
        const tbody = modal.querySelector('#dept-modules-tbody');
        tbody.innerHTML = '<tr><td colspan="6" class="loading" style="text-align:center; padding:1rem; color:var(--text-3);">Cargando…</td></tr>';
        modal.classList.add('active');

        const dept = _depts.find(d => Number(d.id) === Number(deptId));
        if (!dept) return;
        const users = usersOfDept(dept.name);
        if (users.length === 0) {
            tbody.innerHTML = `<tr><td colspan="6" class="empty" style="text-align:center; padding:1rem; color:var(--text-3); font-style:italic;">Sin personas en este departamento</td></tr>`;
            return;
        }

        try {
            const headers = { Authorization: 'Bearer ' + Utils.getToken() };
            const contexts = await Promise.all(
                users.map(u =>
                    fetch(`/api/rbac/users/${u.id}/context`, { headers })
                        .then(r => r.json())
                        .then(j => ({ user: u, ctx: j.data || j }))
                        .catch(err => ({ user: u, ctx: null, err }))
                )
            );
            _modulesModalState = { deptId, deptName, ctxs: contexts };
            renderModulesTable();
        } catch (err) {
            console.error('openModules error:', err);
            tbody.innerHTML = `<tr><td colspan="6" class="error" style="text-align:center; padding:1rem; color:var(--danger);">Error al cargar permisos</td></tr>`;
        }
    }

    // Re-render del thead + tbody del modal de módulos. Usa la cache
    // _modulesModalState que se actualiza tras cada toggle.
    function renderModulesTable() {
        const { ctxs, deptId } = _modulesModalState;
        const thead = document.getElementById('dept-modules-thead');
        const tbody = document.getElementById('dept-modules-tbody');
        if (!thead || !tbody) return;
        const hasPerm = (ctx, user, perm) => {
            const set = new Set((ctx?.permissions) || []);
            if (user.role === 'admin' || set.has('system.admin')) return true;
            return set.has(perm);
        };
        const counts = MODULES.map(m => {
            const all = ctxs.length;
            const yes = ctxs.filter(({ ctx, user }) => hasPerm(ctx, user, m.perm)).length;
            const state = yes === 0 ? 'off' : yes === all ? 'on' : 'mixed';
            return { ...m, state, yes, all };
        });
        // Thead con switches maestros
        thead.innerHTML = `
            <tr>
                <th>Persona</th>
                <th class="dept-mod-fixed" title="Reportes — se asigna desde el botón Reportes del card">📊 Reportes</th>
                <th class="dept-mod-fixed" title="Documentos — se asigna desde el botón Documentos del card">📄 Docs</th>
                ${counts.map(c => `
                    <th class="dept-mod-toggle-col">
                        <div class="dept-mod-master">
                            <span>${c.label}</span>
                            <button type="button"
                                    class="dept-switch dept-switch-${c.state}"
                                    data-perm="${c.perm}"
                                    data-state="${c.state}"
                                    onclick="byDept.toggleMaster('${c.perm}')"
                                    title="${c.state === 'on' ? 'Todos tienen acceso — click para quitar a todos' : c.state === 'off' ? 'Nadie tiene acceso — click para dar a todos' : c.yes + ' de ' + c.all + ' tienen acceso — click para alinear a todos en ON'}">
                                <span class="dept-switch-thumb"></span>
                            </button>
                            <small class="dept-mod-count">${c.yes}/${c.all}</small>
                        </div>
                    </th>
                `).join('')}
                <th></th>
            </tr>
        `;
        // Tbody con celdas interactivas por user
        tbody.innerHTML = ctxs.map(({ user, ctx }) => {
            const isAdmin = user.role === 'admin' || (ctx?.permissions || []).includes('system.admin');
            const fixedCell = '<span class="dept-mod-yes" title="Siempre activo">✓</span>';
            const toggleCells = MODULES.map(m => {
                const on = hasPerm(ctx, user, m.perm);
                if (isAdmin) {
                    return `<td><span class="dept-mod-yes" title="Admin del sistema — siempre activo">✓</span></td>`;
                }
                return `
                    <td>
                        <button type="button"
                                class="dept-switch dept-switch-${on ? 'on' : 'off'} dept-switch-small"
                                onclick="byDept.toggleUser(${user.id}, '${m.perm}', ${on ? 'true' : 'false'})"
                                title="${on ? 'Quitar acceso a ' + (user.full_name || user.username) : 'Dar acceso a ' + (user.full_name || user.username)}">
                            <span class="dept-switch-thumb"></span>
                        </button>
                    </td>
                `;
            }).join('');
            return `
                <tr>
                    <td>
                        <div class="dept-mod-person">
                            <div class="by-dept-avatar" style="width:26px; height:26px; font-size:0.72rem;">${escapeHtml((user.full_name || user.username || '?').charAt(0).toUpperCase())}</div>
                            <div>
                                <div style="font-size:0.85rem; font-weight:600; color:var(--text-1);">${escapeHtml(user.full_name)}${isAdmin ? ' <span class="by-dept-admin-tag">ADMIN</span>' : ''}</div>
                                <div style="font-size:0.72rem; color:var(--text-3);">${escapeHtml(user.email)}</div>
                            </div>
                        </div>
                    </td>
                    <td>${fixedCell}</td>
                    <td>${fixedCell}</td>
                    ${toggleCells}
                    <td>
                        <button class="btn-edit" onclick="openUserPermissions(${user.id}); document.getElementById('dept-modules-modal').classList.remove('active');" title="Abrir modal individual completo">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
                        </button>
                    </td>
                </tr>
            `;
        }).join('');
    }

    // Switch maestro: bulk grant/remove para todos los users del depto.
    async function toggleMaster(permCode) {
        const { deptId, deptName, ctxs } = _modulesModalState;
        if (!deptId) return;
        const hasPerm = (ctx, user) => {
            const set = new Set((ctx?.permissions) || []);
            if (user.role === 'admin' || set.has('system.admin')) return true;
            return set.has(permCode);
        };
        const allHave = ctxs.every(({ ctx, user }) => hasPerm(ctx, user));
        // Si todos tienen → action 'remove' (quita overrides).
        // Si no, intentamos llevar a todos a tener → action 'grant'.
        const action = allHave ? 'remove' : 'grant';
        try {
            const r = await fetch(`/api/rbac/departments/${deptId}/bulk-permission`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + Utils.getToken() },
                body: JSON.stringify({ permission_code: permCode, action })
            });
            const j = await r.json();
            if (!r.ok || !j.success) throw new Error(j.message || 'Error');
            const verb = action === 'grant' ? 'Activado' : 'Quitado';
            Notification.success(`${verb} "${permCode}" para ${deptName} (${j.data?.affected || 0} personas)`);
            // Refrescar contextos
            await reloadModulesContexts();
            renderModulesTable();
        } catch (err) {
            console.error('toggleMaster error:', err);
            Notification.error(err.message || 'Error al aplicar permiso al depto');
        }
    }

    // Toggle individual: grant override o quitar override para ese (user, perm).
    async function toggleUser(userId, permCode, currentlyOn) {
        try {
            const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + Utils.getToken() };
            let r;
            if (currentlyOn) {
                // El user actualmente tiene el permiso. Decisión: quitar el
                // override si lo tiene, o crear deny si vino del rol.
                // Simple: intentar DELETE primero (si vino de override grant).
                // Si después de DELETE sigue teniendo el permiso por el rol,
                // creamos un deny.
                const delR = await fetch(`/api/rbac/users/${userId}/permission-overrides/${permCode}`, {
                    method: 'DELETE', headers
                });
                const delJ = await delR.json();
                // Verificar si todavía tiene el permiso via rol
                const ctxR = await fetch(`/api/rbac/users/${userId}/context`, { headers });
                const ctxJ = await ctxR.json();
                const stillHas = ((ctxJ.data?.permissions) || []).includes(permCode);
                if (stillHas) {
                    // Vino del rol — necesitamos deny explícito
                    await fetch(`/api/rbac/users/${userId}/permission-overrides`, {
                        method: 'POST', headers,
                        body: JSON.stringify({ permission_code: permCode, effect: 'deny' })
                    });
                }
            } else {
                // No lo tiene → grant override
                r = await fetch(`/api/rbac/users/${userId}/permission-overrides`, {
                    method: 'POST', headers,
                    body: JSON.stringify({ permission_code: permCode, effect: 'grant' })
                });
                if (!r.ok) {
                    const j = await r.json().catch(() => ({}));
                    throw new Error(j.message || 'Error');
                }
            }
            await reloadModulesContexts();
            renderModulesTable();
        } catch (err) {
            console.error('toggleUser error:', err);
            Notification.error(err.message || 'Error al cambiar permiso del usuario');
        }
    }

    async function reloadModulesContexts() {
        const { ctxs } = _modulesModalState;
        const headers = { Authorization: 'Bearer ' + Utils.getToken() };
        const fresh = await Promise.all(
            ctxs.map(({ user }) =>
                fetch(`/api/rbac/users/${user.id}/context`, { headers })
                    .then(r => r.json())
                    .then(j => ({ user, ctx: j.data || j }))
                    .catch(() => ({ user, ctx: null }))
            )
        );
        _modulesModalState.ctxs = fresh;
    }

    // Modal genérico (reutilizado por reports/docs) — se crea una sola vez y
    // se rellena dinámicamente según el resource type.
    function ensureResourceModal(resourceType, deptId, deptName) {
        const titleFor = (rt, name) =>
            (rt === 'reports' ? 'Reportes' : 'Documentos') + ' asignados a ' + name;
        let modal = document.getElementById('dept-resource-modal');
        if (modal) {
            modal.querySelector('.dept-resource-title').textContent = titleFor(resourceType, deptName);
            modal.dataset.deptId = deptId;
            modal.dataset.deptName = deptName;
            modal.dataset.resourceType = resourceType;
            return modal;
        }
        modal = document.createElement('div');
        modal.id = 'dept-resource-modal';
        modal.className = 'modal';
        modal.dataset.deptId = deptId;
        modal.dataset.deptName = deptName;
        modal.dataset.resourceType = resourceType;
        modal.innerHTML = `
            <div class="modal-content" style="max-width: 640px;">
                <div class="modal-header">
                    <h3 class="dept-resource-title">${escapeHtml(titleFor(resourceType, deptName))}</h3>
                    <button class="btn-close" onclick="document.getElementById('dept-resource-modal').classList.remove('active')">&times;</button>
                </div>
                <div class="modal-body">
                    <p style="font-size:0.85rem; color:var(--text-3); margin: 0 0 0.85rem 0;">
                        Marcá los recursos que el departamento <strong>"${escapeHtml(deptName)}"</strong> debe ver. Todos los miembros del depto los verán automáticamente.
                    </p>
                    <div class="dept-resource-list"></div>
                </div>
                <div class="modal-footer">
                    <button type="button" class="btn btn-outline" onclick="document.getElementById('dept-resource-modal').classList.remove('active')">Cancelar</button>
                    <button type="button" class="btn btn-primary" onclick="byDept.saveResource()">Guardar cambios</button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
        return modal;
    }

    async function saveResource() {
        const modal = document.getElementById('dept-resource-modal');
        if (!modal) return;
        const deptId = Number(modal.dataset.deptId);
        const deptName = modal.dataset.deptName;
        // resourceType del modal es 'reports' o 'docs' (plural ui-friendly);
        // la tabla resource_acl usa 'report' o 'document' (singular).
        const resourceType = modal.dataset.resourceType === 'reports' ? 'report' : 'document';
        const initialAssigned = new Set(JSON.parse(modal.dataset.initialAssigned || '[]').map(Number));
        const currentChecked = new Set(
            Array.from(modal.querySelectorAll('input[type="checkbox"]:checked'))
                .map(cb => Number(cb.dataset.resourceId))
        );
        // Diff: agregar las nuevas, quitar las que se desmarcaron
        const toAdd = [...currentChecked].filter(id => !initialAssigned.has(id));
        const toRemove = [...initialAssigned].filter(id => !currentChecked.has(id));

        if (toAdd.length === 0 && toRemove.length === 0) {
            Notification.info('No hay cambios para guardar');
            return;
        }
        const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + Utils.getToken() };
        const ops = [];
        // 1. Crear las nuevas ACLs
        for (const resourceId of toAdd) {
            ops.push(fetch('/api/rbac/acl', {
                method: 'POST', headers,
                body: JSON.stringify({
                    resource_type: resourceType, resource_id: resourceId,
                    principal_type: 'department', principal_id: deptId,
                    actions: ['view']
                })
            }).then(r => r.json()));
        }
        // 2. Para quitar, primero hay que encontrar el ACL id — re-fetcheamos
        // las ACLs del depto y filtramos por las que vamos a quitar.
        if (toRemove.length > 0) {
            const r = await fetch(`/api/rbac/acl/principal/department/${deptId}`, { headers });
            const j = await r.json();
            const acls = (j.data && j.data.acls) || j.data || [];
            const toDelete = acls.filter(a =>
                a.resource_type === resourceType &&
                toRemove.includes(Number(a.resource_id))
            );
            for (const acl of toDelete) {
                ops.push(fetch(`/api/rbac/acl/${acl.id}`, { method: 'DELETE', headers }).then(r => r.json()));
            }
        }
        try {
            await Promise.all(ops);
            const summary = `${toAdd.length} agregado(s) · ${toRemove.length} quitado(s) en "${deptName}"`;
            Notification.success(summary);
            modal.classList.remove('active');
        } catch (err) {
            console.error('saveResource error:', err);
            Notification.error('Error al guardar cambios');
        }
    }

    function escapeHtml(s) {
        if (s === null || s === undefined) return '';
        return String(s).replace(/[&<>"']/g, c => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[c]));
    }

    // Init al cargar admin section
    document.addEventListener('DOMContentLoaded', init);
    // Re-render cuando se cierra el modal de editar persona (puede haber cambiado deptos)
    document.addEventListener('user-permissions-saved', () => reload());

    // Expose globals
    window.byDept = {
        reload, openReports, openDocs, openModules, saveResource,
        toggleMaster, toggleUser
    };
})();
