// API Module
const API = {
    // Base request function
    async request(endpoint, options = {}) {
        const token = Utils.getToken();
        const defaultHeaders = {
            'Content-Type': 'application/json'
        };

        if (token) {
            defaultHeaders['Authorization'] = `Bearer ${token}`;
        }

        const config = {
            ...options,
            headers: {
                ...defaultHeaders,
                ...options.headers
            }
        };

        try {
            const response = await fetch(`${CONFIG.API_BASE_URL}${endpoint}`, config);
            const data = await response.json();

            if (!response.ok) {
                throw new Error(data.message || 'Error en la petición');
            }

            return data;
        } catch (error) {
            console.error('API Error:', error);
            throw error;
        }
    },

    // Auth endpoints
    async login(username, password) {
        return this.request(API_ENDPOINTS.LOGIN, {
            method: 'POST',
            body: JSON.stringify({ username, password })
        });
    },

    async verify() {
        return this.request(API_ENDPOINTS.VERIFY);
    },

    async logout() {
        return this.request(API_ENDPOINTS.LOGOUT, {
            method: 'POST'
        });
    },

    async changePassword(currentPassword, newPassword) {
        // El backend usa snake_case (current_password / new_password) — antes
        // se mandaba camelCase y silenciosamente fallaba.
        return this.request(API_ENDPOINTS.CHANGE_PASSWORD, {
            method: 'POST',
            body: JSON.stringify({ current_password: currentPassword, new_password: newPassword })
        });
    },

    // User endpoints
    async getUsers(params = {}) {
        const query = new URLSearchParams(params).toString();
        return this.request(`${API_ENDPOINTS.USERS}?${query}`);
    },

    async getUser(id) {
        return this.request(`${API_ENDPOINTS.USERS}/${id}`);
    },

    async createUser(userData) {
        return this.request(API_ENDPOINTS.USERS, {
            method: 'POST',
            body: JSON.stringify(userData)
        });
    },

    async updateUser(id, userData) {
        return this.request(`${API_ENDPOINTS.USERS}/${id}`, {
            method: 'PUT',
            body: JSON.stringify(userData)
        });
    },

    async deleteUser(id) {
        return this.request(`${API_ENDPOINTS.USERS}/${id}`, {
            method: 'DELETE'
        });
    },

    async getProfile() {
        return this.request(API_ENDPOINTS.USER_PROFILE);
    },

    async updateProfile(profileData) {
        return this.request(API_ENDPOINTS.USER_PROFILE, {
            method: 'PUT',
            body: JSON.stringify(profileData)
        });
    },

    // Report endpoints
    async getMyReports() {
        return this.request(API_ENDPOINTS.MY_REPORTS);
    },

    async getAllReports(params = {}) {
        const query = new URLSearchParams(params).toString();
        return this.request(`${API_ENDPOINTS.REPORTS}?${query}`);
    },

    async getReport(id) {
        return this.request(`${API_ENDPOINTS.REPORTS}/${id}`);
    },

    async createReport(reportData) {
        return this.request(API_ENDPOINTS.REPORTS, {
            method: 'POST',
            body: JSON.stringify(reportData)
        });
    },

    async updateReport(id, reportData) {
        return this.request(`${API_ENDPOINTS.REPORTS}/${id}`, {
            method: 'PUT',
            body: JSON.stringify(reportData)
        });
    },

    async deleteReport(id) {
        return this.request(`${API_ENDPOINTS.REPORTS}/${id}`, {
            method: 'DELETE'
        });
    },

    async getReportStats(id) {
        return this.request(`${API_ENDPOINTS.REPORTS}/${id}/stats`);
    },

    // Permission endpoints (reportes)
    async assignPermission(userId, reportId, permissions) {
        return this.request(`${API_ENDPOINTS.PERMISSIONS}/users/${userId}/reports/${reportId}`, {
            method: 'POST',
            body: JSON.stringify(permissions)
        });
    },

    async removePermission(userId, reportId) {
        return this.request(`${API_ENDPOINTS.PERMISSIONS}/users/${userId}/reports/${reportId}`, {
            method: 'DELETE'
        });
    },

    async getPermissionsMatrix() {
        return this.request(API_ENDPOINTS.PERMISSIONS_MATRIX);
    },

    async bulkAssignPermissions(data) {
        return this.request(API_ENDPOINTS.BULK_ASSIGN, {
            method: 'POST',
            body: JSON.stringify(data)
        });
    },

    // Sincroniza la lista completa de usuarios con acceso a un reporte
    // en UNA sola llamada atómica. userIds = array de IDs que DEBEN tener permiso.
    async syncReportPermissions(reportId, userIds) {
        return this.request(`${API_ENDPOINTS.PERMISSIONS}/reports/${reportId}/sync`, {
            method: 'POST',
            body: JSON.stringify({ userIds })
        });
    },

    async clonePermissions(sourceUserId, targetUserId) {
        return this.request(API_ENDPOINTS.CLONE_PERMISSIONS, {
            method: 'POST',
            body: JSON.stringify({ sourceUserId, targetUserId })
        });
    },

    // ========= Documentos (PDFs) =========
    async getMyDocuments() {
        return this.request(API_ENDPOINTS.MY_DOCUMENTS);
    },

    async getAllDocuments(params = {}) {
        const query = new URLSearchParams(params).toString();
        return this.request(`${API_ENDPOINTS.DOCUMENTS}?${query}`);
    },

    async getDocument(id) {
        return this.request(`${API_ENDPOINTS.DOCUMENTS}/${id}`);
    },

    // Subida de PDF (multipart). No pasa por request() porque lleva FormData.
    async uploadDocument(formData) {
        const token = Utils.getToken();
        const headers = {};
        if (token) headers['Authorization'] = `Bearer ${token}`;

        const response = await fetch(`${CONFIG.API_BASE_URL}${API_ENDPOINTS.DOCUMENTS}`, {
            method: 'POST',
            headers,
            body: formData
        });
        const data = await response.json();
        if (!response.ok) {
            throw new Error(data.message || 'Error al subir el documento');
        }
        return data;
    },

    async updateDocument(id, documentData) {
        return this.request(`${API_ENDPOINTS.DOCUMENTS}/${id}`, {
            method: 'PUT',
            body: JSON.stringify(documentData)
        });
    },

    async deleteDocument(id) {
        return this.request(`${API_ENDPOINTS.DOCUMENTS}/${id}`, {
            method: 'DELETE'
        });
    },

    // Devuelve el PDF como ArrayBuffer autenticado (el blob NO se guarda en URL directa)
    async fetchDocumentStream(id) {
        const token = Utils.getToken();
        const headers = {};
        if (token) headers['Authorization'] = `Bearer ${token}`;

        const response = await fetch(`${CONFIG.API_BASE_URL}${API_ENDPOINTS.DOCUMENTS}/${id}/stream`, {
            headers,
            cache: 'no-store'
        });
        if (!response.ok) {
            let msg = 'Error al cargar documento';
            try { msg = (await response.json()).message || msg; } catch (_) {}
            throw new Error(msg);
        }
        return await response.arrayBuffer();
    },

    // F2: descarga el PDF ORIGINAL como blob autenticado + su nombre de archivo
    // (leído del header Content-Disposition). El caller dispara el "guardar como".
    async fetchDocumentDownload(id) {
        const token = Utils.getToken();
        const headers = {};
        if (token) headers['Authorization'] = `Bearer ${token}`;

        const response = await fetch(`${CONFIG.API_BASE_URL}${API_ENDPOINTS.DOCUMENTS}/${id}/download`, {
            headers,
            cache: 'no-store'
        });
        if (!response.ok) {
            let msg = 'No se pudo descargar el documento';
            try { msg = (await response.json()).message || msg; } catch (_) {}
            throw new Error(msg);
        }
        let filename = `documento-${id}.pdf`;
        const cd = response.headers.get('Content-Disposition') || '';
        const m = /filename="?([^"]+)"?/.exec(cd);
        if (m && m[1]) filename = m[1].trim();
        return { blob: await response.blob(), filename };
    },

    async getDocumentsPermissionsMatrix() {
        return this.request(API_ENDPOINTS.DOCUMENTS_PERMISSIONS_MATRIX);
    },

    async assignDocumentPermission(userId, documentId, permissions) {
        return this.request(`${API_ENDPOINTS.PERMISSIONS}/users/${userId}/documents/${documentId}`, {
            method: 'POST',
            body: JSON.stringify(permissions)
        });
    },

    async removeDocumentPermission(userId, documentId) {
        return this.request(`${API_ENDPOINTS.PERMISSIONS}/users/${userId}/documents/${documentId}`, {
            method: 'DELETE'
        });
    },

    async bulkAssignDocumentPermissions(data) {
        return this.request(API_ENDPOINTS.DOCUMENTS_BULK_ASSIGN, {
            method: 'POST',
            body: JSON.stringify(data)
        });
    },

    // Sincroniza lista completa de usuarios con acceso a un documento (atómico)
    async syncDocumentPermissions(documentId, userIds, downloadUserIds = []) {
        return this.request(`${API_ENDPOINTS.PERMISSIONS}/documents/${documentId}/sync`, {
            method: 'POST',
            body: JSON.stringify({ userIds, downloadUserIds })
        });
    },

    // ========= Cotizador Landed Cost · v2 =========
    // Catálogos (lectura — cualquier user con cotizador.use)
    async cotizadorListAirports()    { return this.request('/cotizador/airports'); },
    async cotizadorListAerolineas()  { return this.request('/cotizador/aerolineas'); },
    async cotizadorListCargueras()   { return this.request('/cotizador/cargueras'); },
    async cotizadorListTarifas()     { return this.request('/cotizador/tarifas'); },
    async cotizadorListTarifasPais() { return this.request('/cotizador/tarifas-pais'); },
    // Backwards-compat: la UI vieja llamaba a Destinos. Lo aliasamos a airports.
    async cotizadorListDestinos()    { return this.request('/cotizador/airports'); },

    // Cálculo y guardado (cotizador.use)
    async cotizadorCalcular(payload) {
        return this.request('/cotizador/cotizar', {
            method: 'POST', body: JSON.stringify(payload)
        });
    },
    async cotizadorGuardar(payload) {
        return this.request('/cotizador/cotizaciones', {
            method: 'POST', body: JSON.stringify(payload)
        });
    },
    async cotizadorHistorico(limit = 20) {
        return this.request(`/cotizador/cotizaciones?limit=${limit}`);
    },

    // CRUD tarifas (cotizador.tarifas.manage)
    async cotizadorCreateTarifa(payload) {
        return this.request('/cotizador/tarifas', { method: 'POST', body: JSON.stringify(payload) });
    },
    async cotizadorUpdateTarifa(id, payload) {
        return this.request(`/cotizador/tarifas/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
    },
    async cotizadorDeleteTarifa(id) {
        return this.request(`/cotizador/tarifas/${id}`, { method: 'DELETE' });
    },
    async cotizadorUpsertTarifaPais(payload) {
        return this.request('/cotizador/tarifas-pais', { method: 'POST', body: JSON.stringify(payload) });
    },

    // CRUD catálogos
    async cotizadorCreateAirport(p)    { return this.request('/cotizador/airports',    { method: 'POST',  body: JSON.stringify(p) }); },
    async cotizadorUpdateAirport(id,p) { return this.request(`/cotizador/airports/${id}`, { method: 'PUT', body: JSON.stringify(p) }); },
    async cotizadorDeleteAirport(id)   { return this.request(`/cotizador/airports/${id}`, { method: 'DELETE' }); },
    async cotizadorCreateAerolinea(p)    { return this.request('/cotizador/aerolineas', { method: 'POST',  body: JSON.stringify(p) }); },
    async cotizadorUpdateAerolinea(id,p) { return this.request(`/cotizador/aerolineas/${id}`, { method: 'PUT', body: JSON.stringify(p) }); },
    async cotizadorDeleteAerolinea(id)   { return this.request(`/cotizador/aerolineas/${id}`, { method: 'DELETE' }); },
    async cotizadorCreateCarguera(p)    { return this.request('/cotizador/cargueras', { method: 'POST',  body: JSON.stringify(p) }); },
    async cotizadorUpdateCarguera(id,p) { return this.request(`/cotizador/cargueras/${id}`, { method: 'PUT', body: JSON.stringify(p) }); },
    async cotizadorDeleteCarguera(id)   { return this.request(`/cotizador/cargueras/${id}`, { method: 'DELETE' }); },

    // Audit log
    async cotizadorAuditLog(limit = 100) {
        return this.request(`/cotizador/audit-log?limit=${limit}`);
    }
};

// Notification System
const Notification = {
    show(message, type = 'info', duration = 3000) {
        const container = document.getElementById('notification-container');
        const notification = document.createElement('div');
        notification.className = `notification ${type}`;

        const icon = this.getIcon(type);
        notification.innerHTML = `
            ${icon}
            <div class="notification-content">
                <div class="notification-message">${message}</div>
            </div>
            <button class="notification-close" onclick="this.parentElement.remove()">&times;</button>
        `;

        container.appendChild(notification);

        const autoClose = setTimeout(() => {
            if (notification.parentElement) {
                notification.style.animation = 'slideOutRight 0.3s ease-out forwards';
                setTimeout(() => notification.remove(), 300);
            }
        }, duration);

        notification.querySelector('.notification-close').addEventListener('click', () => {
            clearTimeout(autoClose);
        });
    },

    getIcon(type) {
        const icons = {
            success: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg>',
            error: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg>',
            warning: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>',
            info: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>'
        };
        return icons[type] || icons.info;
    },

    success(message) { this.show(message, 'success', 2500); },
    error(message) { this.show(message, 'error', 4000); },
    warning(message) { this.show(message, 'warning', 3000); },
    info(message) { this.show(message, 'info', 3000); }
};
