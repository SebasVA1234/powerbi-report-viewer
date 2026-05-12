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

    // Stubs para los modales de PR-8b/c/d — por ahora muestran un toast
    // anunciando que están en construcción para que el admin sepa que el
    // botón funciona pero la feature concreta llega en siguiente sub-PR.
    function openReports(deptId, deptName) {
        if (typeof Notification !== 'undefined' && Notification.info) {
            Notification.info(`Asignación de reportes para "${deptName}" — modal en construcción (PR-8b). Por ahora podés asignar reportes individuales desde la tab Reportes › ícono verde de Accesos.`);
        }
    }
    function openDocs(deptId, deptName) {
        if (typeof Notification !== 'undefined' && Notification.info) {
            Notification.info(`Asignación de documentos para "${deptName}" — modal en construcción (PR-8c).`);
        }
    }
    function openModules(deptId, deptName) {
        if (typeof Notification !== 'undefined' && Notification.info) {
            Notification.info(`Switches de módulos (Cotizador, RRHH, etc) para "${deptName}" — modal en construcción (PR-8d).`);
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
    window.byDept = { reload, openReports, openDocs, openModules };
})();
