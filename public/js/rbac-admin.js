/**
 * RBAC Admin UI (PR-1d)
 *
 * Controller del frontend para los tabs nuevos:
 *   - Departamentos (CRUD)
 *   - Categorías (CRUD, filtro por type)
 *   - Permisos RBAC con 3 vistas:
 *       A · Por Recurso     (¿quién accede a este reporte/doc/categoría?)
 *       B · Por Usuario      (roles, depts, ACLs y permisos efectivos)
 *       C · Por Departamento (miembros + ACLs heredables)
 *
 * UI deliberadamente austera: tablas, prompts y selects nativos. La
 * versión definitiva con modales del design system antigravity llega
 * en Fase 2. Acá lo importante es que TODO el modelo nuevo de Fase 1
 * (PRs 1a/1b/1c) sea operable desde el navegador.
 */

const rbacAdmin = (function () {
    function token() { return Utils.getToken(); }
    function authHeader() { return { 'Authorization': 'Bearer ' + token() }; }

    async function api(method, url, body) {
        const opts = { method, headers: { ...authHeader() } };
        if (body !== undefined) {
            opts.headers['Content-Type'] = 'application/json';
            opts.body = JSON.stringify(body);
        }
        const r = await fetch(url, opts);
        let data = null;
        try { data = await r.json(); } catch { data = null; }
        if (!r.ok) {
            const msg = (data && data.message) || ('HTTP ' + r.status);
            throw new Error(msg);
        }
        return data;
    }

    function escapeHtml(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    // ------------------------------------------------------------
    // Departamentos (CRUD)
    // ------------------------------------------------------------
    async function loadDepartments() {
        const tbody = document.getElementById('departments-tbody');
        if (!tbody) return;
        tbody.innerHTML = '<tr><td colspan="5" class="loading">Cargando...</td></tr>';
        try {
            const resp = await api('GET', '/api/rbac/departments?include_archived=1');
            const depts = resp.data.departments || [];
            if (depts.length === 0) {
                tbody.innerHTML = '<tr><td colspan="5" class="empty">Sin departamentos.</td></tr>';
                return;
            }
            tbody.innerHTML = depts.map(d => `
                <tr ${d.is_active ? '' : 'class="archived"'}>
                    <td><code>${escapeHtml(d.code)}</code></td>
                    <td>${escapeHtml(d.name)}</td>
                    <td>${d.member_count || 0}</td>
                    <td><span class="badge ${d.is_active ? 'badge-success' : 'badge-danger'}">${d.is_active ? 'Activo' : 'Archivado'}</span></td>
                    <td>
                        <button class="btn-edit"   onclick="rbacAdmin.editDepartment(${d.id}, '${escapeHtml(d.name).replace(/'/g, "\\'")}', ${d.is_active})">Editar</button>
                        ${d.is_active ? `<button class="btn-delete" onclick="rbacAdmin.archiveDepartment(${d.id})">Archivar</button>` : ''}
                    </td>
                </tr>
            `).join('');
        } catch (err) {
            tbody.innerHTML = `<tr><td colspan="5" class="error">Error: ${escapeHtml(err.message)}</td></tr>`;
        }
    }

    async function openCreateDepartment() {
        const code = window.prompt('Code (snake_case, ej: logistica):');
        if (!code) return;
        const name = window.prompt('Nombre (ej: Logística):');
        if (!name) return;
        try {
            await api('POST', '/api/rbac/departments', { code, name });
            Notification.success('Departamento creado');
            loadDepartments();
        } catch (err) {
            Notification.error('No se pudo crear: ' + err.message);
        }
    }

    async function editDepartment(id, currentName, currentActive) {
        const newName = window.prompt('Nuevo nombre:', currentName);
        if (newName === null) return;
        try {
            await api('PUT', `/api/rbac/departments/${id}`, { name: newName });
            Notification.success('Departamento actualizado');
            loadDepartments();
        } catch (err) {
            Notification.error('No se pudo actualizar: ' + err.message);
        }
    }

    async function archiveDepartment(id) {
        if (!window.confirm('¿Archivar este departamento? Sus miembros y ACLs históricas se preservan.')) return;
        try {
            await api('POST', `/api/rbac/departments/${id}/archive`);
            Notification.success('Departamento archivado');
            loadDepartments();
        } catch (err) {
            Notification.error('No se pudo archivar: ' + err.message);
        }
    }

    // ------------------------------------------------------------
    // Categorías (CRUD)
    // ------------------------------------------------------------
    async function loadCategories() {
        const tbody = document.getElementById('categories-tbody');
        if (!tbody) return;
        const typeFilter = document.getElementById('categories-type-filter')?.value || '';
        const url = typeFilter
            ? `/api/rbac/categories?type=${encodeURIComponent(typeFilter)}&include_archived=1`
            : '/api/rbac/categories?include_archived=1';
        tbody.innerHTML = '<tr><td colspan="5" class="loading">Cargando...</td></tr>';
        try {
            const resp = await api('GET', url);
            const cats = resp.data.categories || [];
            if (cats.length === 0) {
                tbody.innerHTML = '<tr><td colspan="5" class="empty">Sin categorías.</td></tr>';
                return;
            }
            tbody.innerHTML = cats.map(c => `
                <tr ${c.is_active ? '' : 'class="archived"'}>
                    <td><span class="badge badge-info">${escapeHtml(c.type)}</span></td>
                    <td><code>${escapeHtml(c.code)}</code></td>
                    <td>${escapeHtml(c.name)}</td>
                    <td><span class="badge ${c.is_active ? 'badge-success' : 'badge-danger'}">${c.is_active ? 'Activa' : 'Archivada'}</span></td>
                    <td>
                        <button class="btn-edit" onclick="rbacAdmin.editCategory(${c.id}, '${escapeHtml(c.name).replace(/'/g, "\\'")}', ${c.is_active})">Editar</button>
                        ${c.is_active ? `<button class="btn-delete" onclick="rbacAdmin.archiveCategory(${c.id})">Archivar</button>` : ''}
                    </td>
                </tr>
            `).join('');
        } catch (err) {
            tbody.innerHTML = `<tr><td colspan="5" class="error">Error: ${escapeHtml(err.message)}</td></tr>`;
        }
    }

    async function openCreateCategory() {
        const type = window.prompt('Tipo (report o document):', 'report');
        if (!type || !['report', 'document'].includes(type)) return;
        const code = window.prompt('Code (snake_case, ej: finanzas):');
        if (!code) return;
        const name = window.prompt('Nombre (ej: Finanzas):');
        if (!name) return;
        try {
            await api('POST', '/api/rbac/categories', { type, code, name });
            Notification.success('Categoría creada');
            loadCategories();
        } catch (err) {
            Notification.error('No se pudo crear: ' + err.message);
        }
    }

    async function editCategory(id, currentName, currentActive) {
        const newName = window.prompt('Nuevo nombre:', currentName);
        if (newName === null) return;
        try {
            await api('PUT', `/api/rbac/categories/${id}`, { name: newName });
            Notification.success('Categoría actualizada');
            loadCategories();
        } catch (err) {
            Notification.error('No se pudo actualizar: ' + err.message);
        }
    }

    async function archiveCategory(id) {
        if (!window.confirm('¿Archivar esta categoría?')) return;
        try {
            await api('POST', `/api/rbac/categories/${id}/archive`);
            Notification.success('Categoría archivada');
            loadCategories();
        } catch (err) {
            Notification.error('No se pudo archivar: ' + err.message);
        }
    }

    // ------------------------------------------------------------
    // Permisos RBAC — 3 vistas
    // ------------------------------------------------------------
    function switchView(view) {
        document.querySelectorAll('.rbac-view-btn').forEach(b => {
            b.classList.toggle('active', b.dataset.view === view);
        });
        document.querySelectorAll('.rbac-view').forEach(d => {
            d.classList.toggle('active', d.id === 'rbac-view-' + view);
        });
        if (view === 'resource') loadResourcePicker();
        if (view === 'user')     loadUserPicker();
        if (view === 'department') loadDepartmentPicker();
    }

    // ----- Vista A: por recurso -----
    async function loadResourcePicker() {
        const type = document.getElementById('rbac-resource-type').value;
        const sel = document.getElementById('rbac-resource-id');
        sel.innerHTML = '<option value="">— Cargando —</option>';
        try {
            let items = [];
            if (type === 'report') {
                const r = await api('GET', '/api/reports?limit=200');
                items = (r.data.reports || []).map(x => ({ id: x.id, label: x.name }));
            } else if (type === 'document') {
                const r = await api('GET', '/api/documents?limit=200');
                items = (r.data.documents || []).map(x => ({ id: x.id, label: x.name }));
            } else if (type === 'category') {
                const r = await api('GET', '/api/rbac/categories');
                items = (r.data.categories || []).map(x => ({ id: x.id, label: `[${x.type}] ${x.name}` }));
            }
            sel.innerHTML = '<option value="">— Seleccioná —</option>'
                + items.map(i => `<option value="${i.id}">${escapeHtml(i.label)}</option>`).join('');
            document.getElementById('rbac-resource-acls-tbody').innerHTML =
                '<tr><td colspan="5" class="empty">Seleccioná un recurso arriba.</td></tr>';
        } catch (err) {
            sel.innerHTML = '<option value="">— Error —</option>';
            Notification.error('No se pudo cargar la lista: ' + err.message);
        }
    }

    async function loadAclsForResource() {
        const type = document.getElementById('rbac-resource-type').value;
        const id = document.getElementById('rbac-resource-id').value;
        const tbody = document.getElementById('rbac-resource-acls-tbody');
        if (!id) {
            tbody.innerHTML = '<tr><td colspan="5" class="empty">Seleccioná un recurso arriba.</td></tr>';
            return;
        }
        tbody.innerHTML = '<tr><td colspan="5" class="loading">Cargando...</td></tr>';
        try {
            const r = await api('GET', `/api/rbac/acl/resource/${type}/${id}`);
            const acls = r.data.acls || [];
            if (acls.length === 0) {
                tbody.innerHTML = '<tr><td colspan="5" class="empty">Sin ACLs. Solo admin/gerencia accede.</td></tr>';
                return;
            }
            tbody.innerHTML = acls.map(a => `
                <tr>
                    <td><span class="badge badge-info">${escapeHtml(a.principal_type)}</span></td>
                    <td>${escapeHtml(a.principal_name || '#' + a.principal_id)}</td>
                    <td><code>${escapeHtml(a.actions)}</code></td>
                    <td>${escapeHtml(a.granted_at || '')}</td>
                    <td><button class="btn-delete" onclick="rbacAdmin.deleteAcl(${a.id})">Quitar</button></td>
                </tr>
            `).join('');
        } catch (err) {
            tbody.innerHTML = `<tr><td colspan="5" class="error">Error: ${escapeHtml(err.message)}</td></tr>`;
        }
    }

    async function openAddAcl() {
        const type = document.getElementById('rbac-resource-type').value;
        const id = document.getElementById('rbac-resource-id').value;
        if (!id) {
            Notification.error('Primero seleccioná un recurso.');
            return;
        }
        const principalType = window.prompt('Asignar a (user / department / role):', 'department');
        if (!principalType || !['user', 'department', 'role'].includes(principalType)) return;
        const principalId = window.prompt('ID del ' + principalType + ' (numérico):');
        if (!principalId || isNaN(Number(principalId))) return;
        const actionsStr = window.prompt('Acciones separadas por coma (view, export):', 'view');
        const actions = (actionsStr || 'view').split(',').map(s => s.trim()).filter(Boolean);
        try {
            await api('POST', '/api/rbac/acl', {
                resource_type: type,
                resource_id: Number(id),
                principal_type: principalType,
                principal_id: Number(principalId),
                actions
            });
            Notification.success('ACL creada');
            loadAclsForResource();
        } catch (err) {
            Notification.error('No se pudo crear: ' + err.message);
        }
    }

    async function deleteAcl(id) {
        if (!window.confirm('¿Quitar este acceso?')) return;
        try {
            await api('DELETE', `/api/rbac/acl/${id}`);
            Notification.success('ACL eliminada');
            loadAclsForResource();
        } catch (err) {
            Notification.error('No se pudo quitar: ' + err.message);
        }
    }

    // ----- Vista B: por usuario -----
    async function loadUserPicker() {
        const sel = document.getElementById('rbac-user-id');
        sel.innerHTML = '<option value="">— Cargando —</option>';
        try {
            const r = await api('GET', '/api/users?limit=500');
            const users = r.data.users || [];
            sel.innerHTML = '<option value="">— Seleccioná —</option>'
                + users.map(u => `<option value="${u.id}">${escapeHtml(u.username)} · ${escapeHtml(u.full_name)}</option>`).join('');
            document.getElementById('rbac-user-context').innerHTML = '';
        } catch (err) {
            sel.innerHTML = '<option value="">— Error —</option>';
        }
    }

    async function loadUserContext() {
        const id = document.getElementById('rbac-user-id').value;
        const box = document.getElementById('rbac-user-context');
        if (!id) { box.innerHTML = ''; return; }
        box.innerHTML = '<p class="loading">Cargando...</p>';
        try {
            const r = await api('GET', `/api/rbac/users/${id}/context`);
            const d = r.data;
            box.innerHTML = `
                <div class="rbac-card-section">
                    <h4>${escapeHtml(d.user.full_name)} <small>@${escapeHtml(d.user.username)}</small></h4>
                </div>
                <div class="rbac-card-section">
                    <h5>Roles</h5>
                    ${d.roles.length === 0 ? '<p class="empty-inline">Sin roles asignados.</p>' :
                        d.roles.map(r => `<span class="chip">${escapeHtml(r.name)}</span>`).join('')}
                </div>
                <div class="rbac-card-section">
                    <h5>Departamentos</h5>
                    ${d.departments.length === 0 ? '<p class="empty-inline">Sin departamentos.</p>' :
                        d.departments.map(x => `<span class="chip">${escapeHtml(x.name)}${x.is_head ? ' (jefe)' : ''}</span>`).join('')}
                </div>
                <div class="rbac-card-section">
                    <h5>Permisos efectivos (${d.permissions.length})</h5>
                    ${d.permissions.length === 0 ? '<p class="empty-inline">Sin permisos.</p>' :
                        d.permissions.sort().map(p => `<code class="chip-code">${escapeHtml(p)}</code>`).join(' ')}
                </div>
            `;
        } catch (err) {
            box.innerHTML = `<p class="error">${escapeHtml(err.message)}</p>`;
        }
    }

    // ----- Vista C: por departamento -----
    async function loadDepartmentPicker() {
        const sel = document.getElementById('rbac-dept-id');
        sel.innerHTML = '<option value="">— Cargando —</option>';
        try {
            const r = await api('GET', '/api/rbac/departments');
            const depts = r.data.departments || [];
            sel.innerHTML = '<option value="">— Seleccioná —</option>'
                + depts.map(d => `<option value="${d.id}">${escapeHtml(d.name)}</option>`).join('');
            document.getElementById('rbac-dept-context').innerHTML = '';
        } catch (err) {
            sel.innerHTML = '<option value="">— Error —</option>';
        }
    }

    async function loadDepartmentContext() {
        const id = document.getElementById('rbac-dept-id').value;
        const box = document.getElementById('rbac-dept-context');
        if (!id) { box.innerHTML = ''; return; }
        box.innerHTML = '<p class="loading">Cargando...</p>';
        try {
            const r = await api('GET', `/api/rbac/acl/principal/department/${id}`);
            const acls = r.data.acls || [];
            const byType = acls.reduce((acc, a) => {
                acc[a.resource_type] = acc[a.resource_type] || [];
                acc[a.resource_type].push(a);
                return acc;
            }, {});
            const sections = ['report', 'document', 'category'].map(t => `
                <div class="rbac-card-section">
                    <h5>${t === 'report' ? 'Reportes' : t === 'document' ? 'Documentos' : 'Categorías'} accesibles
                        (${(byType[t] || []).length})</h5>
                    ${(byType[t] || []).length === 0 ? '<p class="empty-inline">Sin asignaciones.</p>' :
                        (byType[t] || []).map(a => `
                            <div class="rbac-acl-row">
                                <span>${t} #${a.resource_id}</span>
                                <code>${escapeHtml(a.actions)}</code>
                                <button class="btn-delete btn-xs" onclick="rbacAdmin.deleteAclAndReload(${a.id}, 'department')">Quitar</button>
                            </div>
                        `).join('')}
                </div>
            `).join('');
            box.innerHTML = sections;
        } catch (err) {
            box.innerHTML = `<p class="error">${escapeHtml(err.message)}</p>`;
        }
    }

    async function deleteAclAndReload(id, viewName) {
        if (!window.confirm('¿Quitar este acceso?')) return;
        try {
            await api('DELETE', `/api/rbac/acl/${id}`);
            Notification.success('ACL eliminada');
            if (viewName === 'department') loadDepartmentContext();
            else if (viewName === 'user') loadUserContext();
            else loadAclsForResource();
        } catch (err) {
            Notification.error('No se pudo quitar: ' + err.message);
        }
    }

    return {
        // Departamentos
        loadDepartments, openCreateDepartment, editDepartment, archiveDepartment,
        // Categorías
        loadCategories, openCreateCategory, editCategory, archiveCategory,
        // Permisos
        switchView,
        loadResourcePicker, loadAclsForResource, openAddAcl, deleteAcl,
        loadUserPicker, loadUserContext,
        loadDepartmentPicker, loadDepartmentContext, deleteAclAndReload
    };
})();
