// Admin Module
let currentUsers = [];
let currentAllReports = [];
let permissionsMatrix = null;

// Initialize Admin Section
async function initializeAdminSection() {
    if (!Auth.isAdmin()) {
        Notification.error('No tiene permisos de administrador');
        showSection('reports');
        return;
    }
    
    setupAdminTabs();
    await loadUsers();
    await loadAllReports();
    setupAdminForms();
}

// Setup Admin Tabs
// IMPORTANTE: scopeado a #admin-section. Antes este listener corría sobre
// TODOS los .tab-btn de la página (incluyendo los sub-tabs del modal de
// accesos y los tabs de RRHH) y al disparar el click borraba .active de
// TODOS los .tab-content del documento. Por eso el modal abría con la
// pestaña Usuarios "vacía".
function setupAdminTabs() {
    const adminSection = document.getElementById('admin-section');
    if (!adminSection) return;
    const adminTabBtns = adminSection.querySelectorAll(':scope > .admin-tabs > .tab-btn');
    const adminTabContents = adminSection.querySelectorAll(':scope > .tab-content');

    adminTabBtns.forEach(tab => {
        tab.addEventListener('click', () => {
            adminTabBtns.forEach(t => t.classList.remove('active'));
            adminTabContents.forEach(c => c.classList.remove('active'));

            tab.classList.add('active');
            const tabContent = document.getElementById(`${tab.dataset.tab}-tab`);
            if (tabContent) {
                tabContent.classList.add('active');
                switch (tab.dataset.tab) {
                    case 'users': loadUsers(); break;
                    case 'reports': loadAllReports(); break;
                    case 'documents':
                        if (typeof loadAllDocumentsAdmin === 'function') loadAllDocumentsAdmin();
                        break;
                    case 'settings': loadSettings(); break;
                    // PR-1d: tabs nuevos
                    case 'departments':
                        if (typeof rbacAdmin !== 'undefined') rbacAdmin.loadDepartments();
                        break;
                    case 'categories':
                        if (typeof rbacAdmin !== 'undefined') rbacAdmin.loadCategories();
                        break;
                    case 'rbac-permissions':
                        if (typeof rbacAdmin !== 'undefined') rbacAdmin.switchView('resource');
                        break;
                }
            }
        });
    });
}

// Load Users
async function loadUsers() {
    const tbody = document.getElementById('users-table-body');
    try {
        tbody.innerHTML = '<tr><td colspan="6" class="loading">Cargando usuarios...</td></tr>';
        const response = await API.getUsers();
        if (response.success) {
            currentUsers = response.data.users;
            displayUsers(currentUsers);
        }
    } catch (error) {
        console.error('Error loading users:', error);
        tbody.innerHTML = '<tr><td colspan="6" class="error">Error al cargar usuarios</td></tr>';
    }
}

// Display Users - Con botón de editar
function displayUsers(users) {
    const tbody = document.getElementById('users-table-body');
    if (users.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6">No hay usuarios</td></tr>';
        return;
    }
    tbody.innerHTML = users.map(user => `
        <tr>
            <td>
                <div class="user-row">
                    <div class="user-avatar">${user.full_name.charAt(0).toUpperCase()}</div>
                    <div class="user-details">
                        <div class="user-name">${user.full_name}</div>
                        <div class="user-username">@${user.username}</div>
                    </div>
                </div>
            </td>
            <td>${user.full_name}</td>
            <td>${user.email}</td>
            <td><span class="badge ${user.role === 'admin' ? 'badge-admin' : 'badge-user'}">${user.role === 'admin' ? 'Administrador' : 'Usuario'}</span></td>
            <td><span class="badge ${user.is_active ? 'badge-success' : 'badge-danger'}">${user.is_active ? 'Activo' : 'Inactivo'}</span></td>
            <td>
                <div class="table-actions">
                    <button class="btn-edit" onclick="editUser(${user.id})" title="Editar Usuario">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
                    </button>
                    <button class="btn-delete" onclick="deleteUser(${user.id})" title="Eliminar">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
                    </button>
                </div>
            </td>
        </tr>
    `).join('');
}

// Load All Reports
async function loadAllReports() {
    const tbody = document.getElementById('reports-table-body');
    try {
        tbody.innerHTML = '<tr><td colspan="6" class="loading">Cargando reportes...</td></tr>';
        const response = await API.getAllReports();
        if (response.success) {
            currentAllReports = response.data.reports;
            displayAllReports(currentAllReports);
        }
    } catch (error) {
        console.error('Error loading reports:', error);
        tbody.innerHTML = '<tr><td colspan="6" class="error">Error al cargar reportes</td></tr>';
    }
}

// Display All Reports (CON BOTÓN DE ACCESOS NUEVO)
function displayAllReports(reports) {
    const tbody = document.getElementById('reports-table-body');
    if (reports.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6">No hay reportes</td></tr>';
        return;
    }
    
    tbody.innerHTML = reports.map(report => `
        <tr>
            <td><strong>${report.name}</strong></td>
            <td>${report.category || 'Sin categoría'}</td>
            <td>${report.description || 'Sin descripción'}</td>
            <td><span class="badge badge-info">${report.users_with_access || 0} usuarios</span></td>
            <td><span class="badge ${report.is_active ? 'badge-success' : 'badge-danger'}">${report.is_active ? 'Activo' : 'Inactivo'}</span></td>
            <td>
                <div class="table-actions">
                    <button class="btn-edit" onclick="editReport(${report.id})" title="Editar">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
                    </button>
                    <button class="btn-permissions" onclick="showReportAccessModal(${report.id}, '${report.name}')" title="Gestionar Accesos">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path></svg>
                    </button>
                    <button class="btn-delete" onclick="deleteReport(${report.id})" title="Eliminar">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
                    </button>
                </div>
            </td>
        </tr>
    `).join('');
}

// Load Permissions Matrix (Legacy view)
async function loadPermissionsMatrix() {
    const container = document.getElementById('permissions-matrix');
    try {
        container.innerHTML = '<div class="loading">Cargando matriz de permisos...</div>';
        const response = await API.getPermissionsMatrix();
        if (response.success) {
            permissionsMatrix = response.data;
            displayPermissionsMatrix(permissionsMatrix);
        }
    } catch (error) {
        container.innerHTML = '<div class="error">Error al cargar permisos</div>';
    }
}

// Display Permissions Matrix
function displayPermissionsMatrix(data) {
    const container = document.getElementById('permissions-matrix');
    if (!data.users.length || !data.reports.length) {
        container.innerHTML = '<div class="empty-state">No hay datos para mostrar</div>';
        return;
    }
    let html = '<table class="matrix-table"><thead><tr><th>Usuario</th>';
    data.reports.forEach(report => {
        html += `<th class="rotate" title="${report.name}">${report.name.substring(0, 15)}...</th>`;
    });
    html += '</tr></thead><tbody>';
    data.matrix.forEach(userRow => {
        html += `<tr><td><strong>${userRow.user.username}</strong></td>`;
        data.reports.forEach(report => {
            const permission = userRow.permissions[report.id];
            const checked = permission && permission.can_view;
            html += `<td class="matrix-cell"><div class="permission-checkbox"><input type="checkbox" ${checked ? 'checked' : ''} onchange="togglePermission(${userRow.user.id}, ${report.id}, this.checked)" title="${checked ? 'Quitar acceso' : 'Dar acceso'}"></div></td>`;
        });
        html += '</tr>';
    });
    html += '</tbody></table>';
    container.innerHTML = html;
}

// Toggle Permission (Single)
async function togglePermission(userId, reportId, grant) {
    try {
        if (grant) {
            await API.assignPermission(userId, reportId, { can_view: true, can_export: false });
            Notification.success('Permiso otorgado');
        } else {
            await API.removePermission(userId, reportId);
            Notification.success('Permiso revocado');
        }
    } catch (error) {
        Notification.error('Error al cambiar permiso');
        loadPermissionsMatrix();
    }
}

// Modals Helpers
async function showCreateUserModal() {
    document.getElementById('create-user-modal').classList.add('active');
    document.getElementById('create-user-form').reset();
    // Cargar departamentos y roles del catálogo RBAC para checkboxes inline.
    // Si la carga falla (red, sin permisos), el modal sigue funcionando como
    // antes — el admin podrá asignar después desde Permisos avanzados.
    try {
        const headers = { Authorization: 'Bearer ' + Utils.getToken() };
        const [deptsR, rolesR] = await Promise.all([
            fetch('/api/rbac/departments', { headers }).then(r => r.json()),
            fetch('/api/rbac/roles',        { headers }).then(r => r.json())
        ]);
        const depts = (deptsR.data && deptsR.data.departments) || [];
        const roles = (rolesR.data && rolesR.data.roles) || [];

        const renderChecks = (items, klass) => items.length === 0
            ? '<em style="color:var(--text-3); font-size:0.85rem;">Sin elementos.</em>'
            : items.map(it => `
                <label class="checkbox-row" style="display:flex; align-items:center; gap:0.5rem; padding:0.4rem 0.6rem; border-radius:6px; background:rgba(255,255,255,0.03); cursor:pointer;">
                    <input type="checkbox" class="${klass}" value="${it.id}" data-code="${it.code || ''}">
                    <span>${(it.name || '').replace(/</g,'&lt;')}</span>
                </label>
            `).join('');

        document.getElementById('create-user-departments-checks').innerHTML = renderChecks(depts, 'create-user-dept-check');
        document.getElementById('create-user-roles-checks').innerHTML       = renderChecks(roles, 'create-user-role-check');
    } catch (err) {
        document.getElementById('create-user-departments-checks').innerHTML = '<em style="color:var(--danger); font-size:0.85rem;">No se pudo cargar el catálogo: ' + (err.message || err) + '</em>';
        document.getElementById('create-user-roles-checks').innerHTML       = '';
    }
}
function showCreateReportModal() {
    document.getElementById('create-report-modal').classList.add('active');
    document.getElementById('create-report-form').reset();
}
function closeModal(modalId) {
    document.getElementById(modalId).classList.remove('active');
}

// Setup Admin Forms (Create & Edit)
function setupAdminForms() {
    // Create User
    // Después de crear el user, asigna los departamentos y roles RBAC seleccionados
    // en el mismo modal. Cada asignación es una llamada separada (las APIs RBAC
    // son granulares); si una falla, igual reportamos lo que SÍ se hizo.
    const createUserForm = document.getElementById('create-user-form');
    if (createUserForm) {
        createUserForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const formData = new FormData(createUserForm);
            const payload = Object.fromEntries(formData);
            const submitBtn = createUserForm.querySelector('button[type="submit"]');
            if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Creando...'; }
            try {
                const created = await API.createUser(payload);
                // user.controller.createUser devuelve { data: { id, username, ... } }
                const newUserId = created && created.data && created.data.id;

                // Capturar deptos y roles seleccionados ANTES de cerrar el modal.
                const deptIds = [...document.querySelectorAll('.create-user-dept-check')].filter(c => c.checked).map(c => Number(c.value));
                const roleCodes = [...document.querySelectorAll('.create-user-role-check')].filter(c => c.checked).map(c => c.dataset.code);

                let assignedDepts = 0, assignedRoles = 0;
                if (newUserId && (deptIds.length > 0 || roleCodes.length > 0)) {
                    const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + Utils.getToken() };
                    for (const dId of deptIds) {
                        const r = await fetch(`/api/rbac/users/${newUserId}/departments/${dId}`, {
                            method: 'POST', headers, body: JSON.stringify({ is_head: false })
                        });
                        if (r.ok) assignedDepts++;
                    }
                    for (const code of roleCodes) {
                        const r = await fetch(`/api/rbac/users/${newUserId}/roles/${code}`, {
                            method: 'POST', headers, body: JSON.stringify({})
                        });
                        if (r.ok) assignedRoles++;
                    }
                }

                const extras = [];
                if (assignedDepts > 0) extras.push(`${assignedDepts} depto${assignedDepts !== 1 ? 's' : ''}`);
                if (assignedRoles > 0) extras.push(`${assignedRoles} rol${assignedRoles !== 1 ? 'es' : ''}`);
                Notification.success(extras.length > 0
                    ? `Usuario creado · ${extras.join(' · ')} asignados`
                    : 'Usuario creado exitosamente');

                closeModal('create-user-modal');
                loadUsers();
            } catch (error) {
                Notification.error(error.message || 'Error al crear usuario');
            } finally {
                if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Crear Usuario'; }
            }
        });
    }
    
    // Create Report
    const createReportForm = document.getElementById('create-report-form');
    if (createReportForm) {
        createReportForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const formData = new FormData(createReportForm);
            try {
                await API.createReport(Object.fromEntries(formData));
                Notification.success('Reporte creado exitosamente');
                closeModal('create-report-modal');
                loadAllReports();
            } catch (error) {
                Notification.error(error.message || 'Error al crear reporte');
            }
        });
    }

    // Edit Report Form (NUEVO)
    const editReportForm = document.getElementById('edit-report-form');
    if (editReportForm) {
        editReportForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const id = document.getElementById('edit-report-id').value;
            const reportData = {
                name: document.getElementById('edit-report-name').value,
                description: document.getElementById('edit-report-description').value,
                embed_url: document.getElementById('edit-report-url').value,
                category: document.getElementById('edit-report-category').value
            };
            try {
                await API.updateReport(id, reportData);
                Notification.success('Reporte actualizado correctamente');
                closeModal('edit-report-modal');
                loadAllReports();
            } catch (error) {
                Notification.error('Error al actualizar: ' + error.message);
            }
        });
    }
}

// Delete Functions
async function deleteUser(userId) {
    const u = currentUsers.find(x => x.id === userId);
    const ok = await confirmDialog({
        title: '¿Eliminar usuario?',
        message: `Vas a eliminar a "${u ? (u.full_name || u.username) : 'este usuario'}". Pierde su acceso, sus permisos y sus solicitudes (RRHH se desvincula). No se puede deshacer.`,
        confirmText: 'Eliminar usuario',
        typeToConfirm: 'ELIMINAR'
    });
    if (!ok) return;
    try {
        await API.deleteUser(userId);
        Notification.success('Usuario eliminado');
        loadUsers();
    } catch (error) {
        Notification.error(error.message);
    }
}
async function deleteReport(reportId) {
    const r = currentAllReports.find(x => x.id === reportId);
    const userCount = r && r.users_with_access ? r.users_with_access : 0;
    const impact = userCount > 0
        ? `Afecta a ${userCount} usuario${userCount !== 1 ? 's' : ''} con acceso asignado.`
        : 'Nadie tiene acceso asignado a este reporte hoy.';
    const ok = await confirmDialog({
        title: '¿Eliminar reporte?',
        message: `Vas a eliminar "${r ? r.name : 'este reporte'}". ${impact} La acción no se puede deshacer.`,
        confirmText: 'Eliminar reporte',
        typeToConfirm: 'ELIMINAR'
    });
    if (!ok) return;
    try {
        await API.deleteReport(reportId);
        Notification.success('Reporte eliminado');
        loadAllReports();
    } catch (error) {
        Notification.error(error.message);
    }
}

// EDIT REPORT LOGIC (NUEVO)
function editReport(reportId) {
    const report = currentAllReports.find(r => r.id === reportId);
    if (!report) return Notification.error('Reporte no encontrado');

    document.getElementById('edit-report-id').value = report.id;
    document.getElementById('edit-report-name').value = report.name;
    document.getElementById('edit-report-description').value = report.description || '';
    document.getElementById('edit-report-url').value = report.embed_url;
    document.getElementById('edit-report-category').value = report.category || '';

    document.getElementById('edit-report-modal').classList.add('active');
}

// ============================================================
// MANAGE ACCESS MODAL — 3 vistas (usuarios / departamentos / roles)
// ============================================================
// Usuarios: usa el legacy user_report_permissions vía syncReportPermissions
// (atómico, ya existía).
// Departamentos / Roles: usa resource_acl. Como no hay sync atómico para
// estos, calculamos un diff entre el estado actual y el deseado, y emitimos
// POST/DELETE individuales. Es idempotente y la UI bloquea el botón
// mientras corre. Si una operación falla a mitad, mostramos qué se grabó.

const _accessState = {
    resourceType: null,   // 'report' | 'document'
    resourceId: null,
    initialAcls: null     // map principal_type -> Set<principal_id> según GET /acl/resource
};

async function _fetchPrincipalsCatalogue() {
    const [usersResp, deptsResp, rolesResp] = await Promise.all([
        API.getUsers({ limit: 500 }),
        fetch('/api/rbac/departments', { headers: { Authorization: 'Bearer ' + Utils.getToken() } }).then(r => r.json()),
        fetch('/api/rbac/roles',        { headers: { Authorization: 'Bearer ' + Utils.getToken() } }).then(r => r.json())
    ]);
    return {
        users: (usersResp.data && (usersResp.data.users || usersResp.data)) || [],
        departments: (deptsResp.data && deptsResp.data.departments) || [],
        roles: (rolesResp.data && rolesResp.data.roles) || []
    };
}

async function _fetchAclMap(resourceType, resourceId) {
    const r = await fetch(`/api/rbac/acl/resource/${resourceType}/${resourceId}`, {
        headers: { Authorization: 'Bearer ' + Utils.getToken() }
    });
    const j = await r.json();
    const acls = (j.data && j.data.acls) || [];
    const map = { user: new Map(), department: new Map(), role: new Map() };
    acls.forEach(a => map[a.principal_type] && map[a.principal_type].set(a.principal_id, a.id));
    return map;
}

function _setupAccessSubTabs(modalSelector, tabAttr) {
    const prefix = modalSelector === '#access-modal' ? 'access' : 'doc-access';
    const tabBtns   = document.querySelectorAll(`${modalSelector} [${tabAttr}]`);
    const tabBodies = document.querySelectorAll(`${modalSelector} > .modal-content > .modal-body > .tab-content`);
    tabBtns.forEach(btn => {
        btn.onclick = () => {
            tabBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            const id = btn.getAttribute(tabAttr);
            tabBodies.forEach(c => c.classList.remove('active'));
            const target = document.getElementById(`${prefix}-${id}-tab`);
            if (target) target.classList.add('active');
        };
    });
    // Reset al estado inicial: sub-tab "Usuarios" activa, las otras ocultas.
    // Sin esto, si el admin abre el modal por segunda vez (o si setupAdminTabs
    // borró el active al navegar tabs), el body queda vacío.
    tabBtns.forEach(b => b.classList.toggle('active', b.getAttribute(tabAttr) === 'users'));
    tabBodies.forEach(c => c.classList.toggle('active', c.id === `${prefix}-users-tab`));
}

function _renderCheckList(containerId, items, currentIds, klass) {
    const container = document.getElementById(containerId);
    if (!items || items.length === 0) {
        container.innerHTML = '<p class="empty">Sin elementos disponibles.</p>';
        return;
    }
    container.innerHTML = `
        <div style="display:grid; grid-template-columns:1fr 1fr; gap:8px;">
        ${items.map(it => {
            const checked = currentIds.has(it.id) ? 'checked' : '';
            return `
                <label class="checkbox-row" style="display:flex; align-items:center; gap:0.5rem; padding:0.6rem 0.75rem; border-radius:8px; background:rgba(255,255,255,0.04); cursor:pointer;">
                    <input type="checkbox" class="${klass}" value="${it.id}" ${checked}>
                    <span>${Utils.escapeHtml ? Utils.escapeHtml(it.label) : it.label}</span>
                </label>
            `;
        }).join('')}
        </div>
    `;
}

// MANAGE ACCESS MODAL — Reportes
async function showReportAccessModal(reportId, reportName) {
    document.getElementById('access-modal-title').innerText = `Accesos: ${reportName}`;
    document.getElementById('access-report-id').value = reportId;
    _accessState.resourceType = 'report';
    _accessState.resourceId = reportId;

    document.getElementById('user-list-checkboxes').innerHTML = '<div class="loading">Cargando...</div>';
    document.getElementById('dept-list-checkboxes').innerHTML = '<div class="loading">Cargando...</div>';
    document.getElementById('role-list-checkboxes').innerHTML = '<div class="loading">Cargando...</div>';
    document.getElementById('access-modal').classList.add('active');

    _setupAccessSubTabs('#access-modal', 'data-access-tab');

    try {
        const [{ users, departments, roles }, aclMap, matrixResp] = await Promise.all([
            _fetchPrincipalsCatalogue(),
            _fetchAclMap('report', reportId),
            API.getPermissionsMatrix()
        ]);

        // Usuarios: combinamos legacy (user_report_permissions) + ACL principal_type='user'.
        const matrix = (matrixResp.data && matrixResp.data.matrix) || [];
        const legacyUserIds = new Set();
        matrix.forEach(row => {
            const p = row.permissions[reportId];
            if (p && p.can_view) legacyUserIds.add(row.user.id);
        });
        const aclUserIds = new Set([...aclMap.user.keys()]);
        const allUserIds = new Set([...legacyUserIds, ...aclUserIds]);
        const userItems = users
            .filter(u => u.role !== 'admin')
            .map(u => ({ id: u.id, label: `${u.full_name} (@${u.username})` }));

        _renderCheckList('user-list-checkboxes', userItems, allUserIds, 'user-access-checkbox');
        _renderCheckList('dept-list-checkboxes',
            departments.map(d => ({ id: d.id, label: d.name })),
            new Set(aclMap.department.keys()), 'dept-access-checkbox');
        _renderCheckList('role-list-checkboxes',
            roles.map(r => ({ id: r.id, label: r.name + ' [' + r.code + ']' })),
            new Set(aclMap.role.keys()), 'role-access-checkbox');

        _accessState.initialAcls = aclMap;
        _accessState.legacyUsers = legacyUserIds;
    } catch (error) {
        console.error(error);
        document.getElementById('user-list-checkboxes').innerHTML = '<p class="error">Error cargando datos: ' + (error.message || error) + '</p>';
    }
}

async function _diffAclSave(resourceType, resourceId, principalType, currentMap, desiredIds) {
    const desired = new Set(desiredIds);
    const current = new Set(currentMap.keys());
    const toAdd = [...desired].filter(id => !current.has(id));
    const toRemove = [...current].filter(id => !desired.has(id));
    const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + Utils.getToken() };
    let added = 0, removed = 0;
    for (const id of toAdd) {
        const r = await fetch('/api/rbac/acl', {
            method: 'POST', headers,
            body: JSON.stringify({
                resource_type: resourceType,
                resource_id: resourceId,
                principal_type: principalType,
                principal_id: id,
                actions: ['view']
            })
        });
        if (r.ok) added++;
    }
    for (const id of toRemove) {
        const aclId = currentMap.get(id);
        const r = await fetch('/api/rbac/acl/' + aclId, { method: 'DELETE', headers });
        if (r.ok) removed++;
    }
    return { added, removed };
}

async function saveReportAccessAll() {
    const reportId = parseInt(document.getElementById('access-report-id').value, 10);
    const saveBtn = document.querySelector('#access-modal .btn-primary');
    const userIds = [...document.querySelectorAll('.user-access-checkbox')].filter(cb => cb.checked).map(cb => Number(cb.value));
    const deptIds = [...document.querySelectorAll('.dept-access-checkbox')].filter(cb => cb.checked).map(cb => Number(cb.value));
    const roleIds = [...document.querySelectorAll('.role-access-checkbox')].filter(cb => cb.checked).map(cb => Number(cb.value));

    saveBtn.disabled = true;
    const orig = saveBtn.innerText;
    saveBtn.innerText = 'Guardando...';
    try {
        // Users: legacy sync (atómico).
        const userResp = await API.syncReportPermissions(reportId, userIds);
        if (!userResp || !userResp.success) throw new Error(userResp && userResp.message || 'fallo guardando usuarios');

        // Dept / Role: diff vs initial state via ACL.
        const deptDiff = await _diffAclSave('report', reportId, 'department', _accessState.initialAcls.department, deptIds);
        const roleDiff = await _diffAclSave('report', reportId, 'role',       _accessState.initialAcls.role,       roleIds);

        Notification.success(
            `Guardado: ${userIds.length} user${userIds.length !== 1 ? 's' : ''} · ` +
            `+${deptDiff.added}/-${deptDiff.removed} depto · ` +
            `+${roleDiff.added}/-${roleDiff.removed} rol`
        );
        closeModal('access-modal');
        if (typeof loadAllReports === 'function') loadAllReports();
    } catch (error) {
        console.error('saveReportAccessAll:', error);
        Notification.error(error.message || 'Error al guardar accesos');
    } finally {
        saveBtn.disabled = false;
        saveBtn.innerText = orig || 'Guardar Accesos';
    }
}

// Compatibilidad con el wiring viejo en app.js.
window.savePermissions = saveReportAccessAll;
window.saveReportAccessAll = saveReportAccessAll;

// Placeholders
function showBulkAssignModal() { Notification.info('Asignación masiva en desarrollo'); }
function showClonePermissionsModal() { Notification.info('Clonación de permisos en desarrollo'); }

// ==========================================
// EDICIÓN DE USUARIOS
// ==========================================

// PR-0b: la columna plain_password fue eliminada del backend. El admin
// ya no puede leer la pass de otros users. Para resetearla:
//   - escribir una nueva en el form, o
//   - dejarla vacía y dar OK -> el backend genera una pass temporal y
//     la devuelve UNA SOLA VEZ, que mostramos al admin con copiarla.

// Mostrar la contraseña temporal devuelta por el backend.
// Es un alert nativo intencional: la UI definitiva (modal con copiar)
// llega en Fase 2 (design system). Lo importante es que el admin
// NUNCA pueda ver la pass de otra forma.
function showTempPassword(tempPass, username) {
    const msg =
`Contraseña temporal para ${username}:

  ${tempPass}

Cópiela y entrégueselo al usuario por canal seguro.
El sistema NO la mostrará otra vez.
El usuario debe cambiarla en su primer ingreso.`;
    window.alert(msg);
}

// Función para abrir el modal de edición con los datos del usuario
function editUser(userId) {
    // Buscar el usuario en la lista que ya tenemos cargada
    const user = currentUsers.find(u => u.id === userId);

    if (!user) {
        Notification.error('Usuario no encontrado');
        return;
    }

    // Llenar el formulario con los datos del usuario
    document.getElementById('edit-user-id').value = user.id;
    document.getElementById('edit-user-username').value = user.username;
    document.getElementById('edit-user-fullname').value = user.full_name;
    document.getElementById('edit-user-email').value = user.email;
    document.getElementById('edit-user-role').value = user.role;
    document.getElementById('edit-user-active').value = user.is_active ? '1' : '0';
    document.getElementById('edit-user-password').value = '';

    // El campo "contraseña actual" ya no existe en el modelo de seguridad;
    // si existe en el HTML legacy, lo neutralizamos visualmente.
    const legacyCurr = document.getElementById('edit-user-current-password');
    if (legacyCurr) {
        legacyCurr.value = '(oculto)';
        legacyCurr.type = 'text';
        legacyCurr.disabled = true;
    }

    // Mostrar el modal
    document.getElementById('edit-user-modal').classList.add('active');
}

// El botón del ojo legacy ahora no muestra nada: la pass es solo conocida
// por el usuario tras el cambio obligatorio en su primer login.
function togglePasswordVisibility() {
    Notification.info('Las contraseñas ya no se almacenan en claro. Para resetear, deja el campo vacío y guarda — recibirás una contraseña temporal de un solo uso.');
}

// Configurar el formulario de edición cuando la página carga
document.addEventListener('DOMContentLoaded', function() {
    const editUserForm = document.getElementById('edit-user-form');
    
    if (editUserForm) {
        editUserForm.addEventListener('submit', async function(e) {
            e.preventDefault();
            
            const id = document.getElementById('edit-user-id').value;
            
            // Recoger los datos del formulario
            const userData = {
                username: document.getElementById('edit-user-username').value,
                full_name: document.getElementById('edit-user-fullname').value,
                email: document.getElementById('edit-user-email').value,
                role: document.getElementById('edit-user-role').value,
                is_active: document.getElementById('edit-user-active').value === '1'
            };

            // Política de password (PR-0b):
            //   - newPassword vacío -> NO se toca la contraseña.
            //   - newPassword '*' (un asterisco) -> reset: el backend genera
            //     una pass temporal y la devuelve UNA sola vez.
            //   - newPassword >=6 chars -> se usa esa, must_change_password=1.
            const newPassword = document.getElementById('edit-user-password').value;
            if (newPassword === '*') {
                userData.password = '';  // backend genera temp
            } else if (newPassword && newPassword.length >= 6) {
                userData.password = newPassword;
            } else if (newPassword && newPassword.length > 0 && newPassword.length < 6) {
                Notification.error('La contraseña debe tener al menos 6 caracteres (o "*" para generar una temporal)');
                return;
            }

            try {
                const resp = await API.updateUser(id, userData);
                Notification.success('Usuario actualizado correctamente');
                if (resp && resp.data && resp.data.temp_password) {
                    showTempPassword(resp.data.temp_password, userData.username);
                }
                closeModal('edit-user-modal');
                loadUsers();
            } catch (error) {
                Notification.error('Error al actualizar: ' + error.message);
            }
        });
    }
});

// =============================================
// SETTINGS FUNCTIONS
// =============================================

// Load Settings
async function loadSettings() {
    try {
        const response = await fetch('/api/config', {
            headers: {
                'Authorization': `Bearer ${Utils.getToken()}`
            }
        });
        const data = await response.json();
        
        if (data.success) {
            const config = data.data;
            
            if (config.max_report_windows) {
                document.getElementById('max-windows').value = config.max_report_windows.value;
            }
        }
    } catch (error) {
        console.error('Error loading settings:', error);
    }
}

// Save Max Windows
async function saveMaxWindows() {
    const input = document.getElementById('max-windows');
    const value = parseInt(input.value);
    
    if (isNaN(value) || value < 1 || value > 10) {
        Notification.error('El valor debe estar entre 1 y 10');
        return;
    }
    
    try {
        const response = await fetch(`/api/config/max_report_windows`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${Utils.getToken()}`
            },
            body: JSON.stringify({ value: value.toString() })
        });
        
        const data = await response.json();
        
        if (data.success) {
            Notification.success('Configuración guardada correctamente');
            
            // Actualizar WindowManager si existe
            if (window.windowManager) {
                windowManager.setMaxWindows(value);
            }
        } else {
            Notification.error(data.message || 'Error al guardar');
        }
    } catch (error) {
        console.error('Error saving config:', error);
        Notification.error('Error al guardar configuración');
    }
}

// Export settings functions
window.loadSettings = loadSettings;
window.saveMaxWindows = saveMaxWindows;