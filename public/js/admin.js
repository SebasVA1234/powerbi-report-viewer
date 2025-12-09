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
function setupAdminTabs() {
    document.querySelectorAll('.tab-btn').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.tab-btn').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
            
            tab.classList.add('active');
            const tabContent = document.getElementById(`${tab.dataset.tab}-tab`);
            if (tabContent) {
                tabContent.classList.add('active');
                switch (tab.dataset.tab) {
                    case 'users': loadUsers(); break;
                    case 'reports': loadAllReports(); break;
                    case 'permissions': loadPermissionsMatrix(); break;
                    case 'settings': loadSettings(); break;
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
function showCreateUserModal() {
    document.getElementById('create-user-modal').classList.add('active');
    document.getElementById('create-user-form').reset();
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
    const createUserForm = document.getElementById('create-user-form');
    if (createUserForm) {
        createUserForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const formData = new FormData(createUserForm);
            try {
                await API.createUser(Object.fromEntries(formData));
                Notification.success('Usuario creado exitosamente');
                closeModal('create-user-modal');
                loadUsers();
            } catch (error) {
                Notification.error(error.message || 'Error al crear usuario');
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
    if (!confirm('¿Está seguro de eliminar este usuario?')) return;
    try {
        await API.deleteUser(userId);
        Notification.success('Usuario eliminado');
        loadUsers();
    } catch (error) {
        Notification.error(error.message);
    }
}
async function deleteReport(reportId) {
    if (!confirm('¿Está seguro de eliminar este reporte?')) return;
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

// MANAGE ACCESS MODAL (NUEVO)
async function showReportAccessModal(reportId, reportName) {
    document.getElementById('access-modal-title').innerText = `Accesos: ${reportName}`;
    document.getElementById('access-report-id').value = reportId;
    
    const container = document.getElementById('user-list-checkboxes');
    container.innerHTML = '<div class="loading">Cargando usuarios...</div>';
    
    document.getElementById('access-modal').classList.add('active');

    try {
        // Obtenemos usuarios y permisos actuales
        const [usersResponse, matrixResponse] = await Promise.all([
            API.getUsers(),
            API.getPermissionsMatrix()
        ]);

        if (usersResponse.success && matrixResponse.success) {
            const users = usersResponse.data.users;
            const matrix = matrixResponse.data.matrix;
            
            let html = '<div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">';
            
            users.forEach(user => {
                if (user.role === 'admin') return; // Opcional: Ocultar admins

                // Verificar si ya tiene permiso
                const userRow = matrix.find(row => row.user.id === user.id);
                const hasAccess = userRow && userRow.permissions[reportId] && userRow.permissions[reportId].can_view;

                html += `
                    <label style="display: flex; align-items: center; justify-content: space-between; padding: 10px; background: #f8f9fa; border-radius: 4px; cursor: pointer; border: 1px solid #dee2e6;">
                        <span style="font-weight: 500;">${user.full_name}</span>
                        <input type="checkbox" class="user-access-checkbox" value="${user.id}" ${hasAccess ? 'checked' : ''} style="width: 18px; height: 18px;">
                    </label>
                `;
            });
            html += '</div>';
            
            if (users.length === 0) html = '<p>No hay usuarios disponibles.</p>';
            
            container.innerHTML = html;
        }
    } catch (error) {
        container.innerHTML = '<p class="error">Error al cargar datos</p>';
    }
}

// SAVE PERMISSIONS (NUEVO)
async function savePermissions() {
    const reportId = document.getElementById('access-report-id').value;
    const checkboxes = document.querySelectorAll('.user-access-checkbox');
    const promises = [];
    const saveBtn = document.querySelector('#access-modal .btn-primary');
    
    saveBtn.disabled = true;
    saveBtn.innerText = 'Guardando...';

    checkboxes.forEach(cb => {
        const userId = cb.value;
        const shouldHaveAccess = cb.checked;
        
        // Asignamos o Removemos según el estado del checkbox
        if (shouldHaveAccess) {
            promises.push(API.assignPermission(userId, reportId, { can_view: true }));
        } else {
            promises.push(API.removePermission(userId, reportId));
        }
    });

    try {
        await Promise.all(promises);
        Notification.success('Accesos actualizados correctamente');
        closeModal('access-modal');
        loadAllReports(); // Actualizar contador de usuarios
    } catch (error) {
        Notification.error('Error al guardar algunos permisos');
    } finally {
        saveBtn.disabled = false;
        saveBtn.innerText = 'Guardar Accesos';
    }
}

// Placeholders
function showBulkAssignModal() { Notification.info('Asignación masiva en desarrollo'); }
function showClonePermissionsModal() { Notification.info('Clonación de permisos en desarrollo'); }

// ==========================================
// EDICIÓN DE USUARIOS
// ==========================================

// Variable para guardar la contraseña actual del usuario que se edita
let currentEditingUserPassword = '';

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
    document.getElementById('edit-user-password').value = ''; // Limpiar campo de nueva contraseña

    // Guardar la contraseña actual para mostrarla con el botón del ojo
    currentEditingUserPassword = user.plain_password || '(no disponible)';
    document.getElementById('edit-user-current-password').value = '••••••••';
    document.getElementById('edit-user-current-password').type = 'password';

    // Mostrar el modal
    document.getElementById('edit-user-modal').classList.add('active');
}

// Función para mostrar/ocultar la contraseña actual
function togglePasswordVisibility() {
    const input = document.getElementById('edit-user-current-password');
    const eyeIcon = document.getElementById('eye-icon');
    
    if (input.type === 'password') {
        // Mostrar contraseña
        input.type = 'text';
        input.value = currentEditingUserPassword;
        // Cambiar ícono a "ojo tachado"
        eyeIcon.innerHTML = '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line>';
    } else {
        // Ocultar contraseña
        input.type = 'password';
        input.value = '••••••••';
        // Cambiar ícono a "ojo normal"
        eyeIcon.innerHTML = '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle>';
    }
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

            // Solo incluir contraseña si se escribió una nueva
            const newPassword = document.getElementById('edit-user-password').value;
            if (newPassword && newPassword.length >= 6) {
                userData.password = newPassword;
            } else if (newPassword && newPassword.length > 0 && newPassword.length < 6) {
                Notification.error('La contraseña debe tener al menos 6 caracteres');
                return;
            }

            try {
                // Enviar los datos al servidor
                await API.updateUser(id, userData);
                Notification.success('Usuario actualizado correctamente');
                closeModal('edit-user-modal');
                loadUsers(); // Recargar la lista de usuarios
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