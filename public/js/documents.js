// ==========================================================================
// Documents Module - Visor seguro de PDFs (view-only)
// ==========================================================================
// Seguridad implementada:
//  - El PDF se descarga del servidor como ArrayBuffer autenticado por JWT.
//    Nunca se expone la URL del archivo directamente al DOM.
//  - Se renderiza con PDF.js en un <canvas>: no hay <embed>/<a href>/<iframe>
//    con el archivo, así que "guardar como" sólo guarda una imagen borrosa.
//  - Se desactiva click derecho, selección de texto, arrastrar y atajos
//    (Ctrl+S, Ctrl+P, Ctrl+C, F12, PrintScreen).
//  - Al perder foco la pestaña/ventana se oculta el contenido (blur) para
//    que PrintScreen del sistema no capture nada útil.
//  - Watermark diagonal con email + fecha del usuario. Si alguien logra
//    una captura, queda marcado quién la hizo.
// Nota: ningún sitio web puede bloquear 100% un screenshot del SO o móvil.
// Estas medidas son disuasivas y de trazabilidad, no absolutas.
// ==========================================================================

let currentDocuments = [];
let pdfState = {
    doc: null,
    currentPage: 1,
    totalPages: 0,
    scale: 1.25,
    rendering: false,
    pendingPage: null,
    bufferRef: null // referencia al ArrayBuffer para evitar GC
};

// ---------- Carga de lista de documentos del usuario ----------
async function loadMyDocuments() {
    const container = document.getElementById('documents-container');
    if (!container) return;

    try {
        container.innerHTML = `
            <div class="loading">
                <div class="spinner"></div>
                <div class="loading-text">Cargando documentos...</div>
            </div>
        `;

        const response = await API.getMyDocuments();

        if (response.success) {
            currentDocuments = response.data.documents || [];

            const statEl = document.getElementById('stat-documents');
            if (statEl) statEl.textContent = currentDocuments.length;

            if (currentDocuments.length === 0) {
                container.innerHTML = `
                    <div class="empty-state">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                            <polyline points="14 2 14 8 20 8"></polyline>
                        </svg>
                        <h3>No tiene documentos asignados</h3>
                        <p>Contacte al administrador para solicitar acceso a documentos.</p>
                    </div>
                `;
            } else {
                displayDocuments(currentDocuments);
            }
        }
    } catch (error) {
        console.error('Error loading documents:', error);
        container.innerHTML = `
            <div class="empty-state">
                <h3>Error al cargar documentos</h3>
                <p>${error.message || 'Ha ocurrido un error'}</p>
                <button class="btn btn-primary" onclick="loadMyDocuments()">Reintentar</button>
            </div>
        `;
    }
}

function displayDocuments(docs) {
    const container = document.getElementById('documents-container');

    const grouped = docs.reduce((acc, d) => {
        const cat = d.category || 'Sin categoría';
        if (!acc[cat]) acc[cat] = [];
        acc[cat].push(d);
        return acc;
    }, {});

    let html = '';
    for (const [cat, list] of Object.entries(grouped)) {
        html += `
            <div class="category-group">
                <div class="category-header">
                    <h3>${escapeHtml(cat)}</h3>
                    <span class="category-count">${list.length} documento${list.length !== 1 ? 's' : ''}</span>
                </div>
                <div class="reports-grid">
                    ${list.map(createDocumentCard).join('')}
                </div>
            </div>
        `;
    }
    container.innerHTML = html;
}

function createDocumentCard(doc) {
    const sizeKb = Math.round((doc.file_size || 0) / 1024);
    return `
        <div class="report-card document-card" data-document-id="${doc.id}">
            <div class="report-card-header">
                <div>
                    ${doc.category ? `<span class="report-category">${escapeHtml(doc.category)}</span>` : ''}
                    <h3>${escapeHtml(doc.name)}</h3>
                </div>
                <span class="document-icon" title="Documento PDF (solo lectura)">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="24" height="24">
                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                        <polyline points="14 2 14 8 20 8"></polyline>
                    </svg>
                </span>
            </div>
            <div class="report-card-body">
                <p class="report-description">${escapeHtml(doc.description || 'Sin descripción disponible')}</p>
                <div class="report-meta">
                    <div class="report-meta-item">
                        <span>${sizeKb} KB</span>
                    </div>
                    <div class="report-actions">
                        <button class="btn-view-report" onclick="openDocument(${doc.id})">Ver</button>
                    </div>
                </div>
            </div>
        </div>
    `;
}

function escapeHtml(s) {
    if (s === null || s === undefined) return '';
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

// ---------- Visor de PDF seguro ----------

async function openDocument(documentId) {
    try {
        if (!window['pdfjsLib']) {
            Notification.error('No se pudo cargar el visor. Revise su conexión a internet.');
            return;
        }

        // Metadata (para el título)
        const metaResp = await API.getDocument(documentId);
        const doc = metaResp.data && metaResp.data.document;
        if (!doc) throw new Error('Documento no encontrado');

        // Contenido del PDF (ArrayBuffer autenticado)
        const buffer = await API.fetchDocumentStream(documentId);
        pdfState.bufferRef = buffer;

        // Cargar en PDF.js
        const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(buffer) });
        pdfState.doc = await loadingTask.promise;
        pdfState.totalPages = pdfState.doc.numPages;
        pdfState.currentPage = 1;
        pdfState.scale = 1.25;

        // UI
        document.getElementById('pdf-viewer-title').textContent = doc.name;
        setWatermark();
        document.getElementById('pdf-viewer-modal').classList.add('active');
        document.body.classList.add('pdf-open');

        await renderPdfPage(1);
        attachSecurityGuards();
    } catch (error) {
        console.error('Error al abrir documento:', error);
        Notification.error(error.message || 'Error al abrir documento');
    }
}

async function renderPdfPage(num) {
    if (!pdfState.doc) return;
    if (pdfState.rendering) {
        pdfState.pendingPage = num;
        return;
    }
    pdfState.rendering = true;

    try {
        const page = await pdfState.doc.getPage(num);
        const viewport = page.getViewport({ scale: pdfState.scale });

        const container = document.getElementById('pdf-viewer-canvas-container');
        container.innerHTML = '';

        const canvas = document.createElement('canvas');
        canvas.className = 'pdf-canvas';
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        // Desactivar menú/arrastre sobre el canvas
        canvas.addEventListener('contextmenu', e => e.preventDefault());
        canvas.addEventListener('dragstart', e => e.preventDefault());

        container.appendChild(canvas);

        const ctx = canvas.getContext('2d');
        await page.render({ canvasContext: ctx, viewport }).promise;

        pdfState.currentPage = num;
        document.getElementById('pdf-page-info').textContent =
            `Página ${num} / ${pdfState.totalPages}`;
    } catch (e) {
        console.error('Error renderizando página:', e);
    } finally {
        pdfState.rendering = false;
        if (pdfState.pendingPage !== null) {
            const p = pdfState.pendingPage;
            pdfState.pendingPage = null;
            renderPdfPage(p);
        }
    }
}

function pdfNextPage() {
    if (!pdfState.doc) return;
    if (pdfState.currentPage < pdfState.totalPages) {
        renderPdfPage(pdfState.currentPage + 1);
    }
}
function pdfPrevPage() {
    if (!pdfState.doc) return;
    if (pdfState.currentPage > 1) {
        renderPdfPage(pdfState.currentPage - 1);
    }
}
function pdfZoomIn() {
    if (!pdfState.doc) return;
    pdfState.scale = Math.min(pdfState.scale + 0.25, 3);
    renderPdfPage(pdfState.currentPage);
}
function pdfZoomOut() {
    if (!pdfState.doc) return;
    pdfState.scale = Math.max(pdfState.scale - 0.25, 0.5);
    renderPdfPage(pdfState.currentPage);
}

function closePdfViewer() {
    document.getElementById('pdf-viewer-modal').classList.remove('active');
    document.body.classList.remove('pdf-open');
    const container = document.getElementById('pdf-viewer-canvas-container');
    if (container) container.innerHTML = '';
    pdfState.doc = null;
    pdfState.bufferRef = null;
    detachSecurityGuards();
}

function setWatermark() {
    const user = Auth.getCurrentUser ? Auth.getCurrentUser() : null;
    const email = (user && (user.email || user.username)) || '';
    const now = new Date();
    const stamp = now.toLocaleString('es-EC');
    const wm = document.getElementById('pdf-viewer-watermark');
    if (!wm) return;
    const text = `${email} · ${stamp}`;
    // Repetir texto en grilla diagonal — puro CSS + contenido.
    let inner = '';
    for (let i = 0; i < 80; i++) {
        inner += `<span class="pdf-watermark-text">${escapeHtml(text)}</span>`;
    }
    wm.innerHTML = inner;
}

// ---------- Guardas anti-captura / anti-descarga ----------
let _securityHandlers = null;

function attachSecurityGuards() {
    if (_securityHandlers) return;

    const onKey = (e) => {
        if (!document.getElementById('pdf-viewer-modal').classList.contains('active')) return;
        const k = (e.key || '').toLowerCase();
        const ctrl = e.ctrlKey || e.metaKey;

        // Bloquear atajos de guardar/imprimir/copiar/devtools/capture
        if (
            (ctrl && ['s', 'p', 'c', 'u'].includes(k)) ||
            k === 'f12' ||
            (ctrl && e.shiftKey && ['i', 'j', 'c'].includes(k)) ||
            k === 'printscreen'
        ) {
            e.preventDefault();
            e.stopPropagation();
            // Borroso breve si intentaron capturar
            if (k === 'printscreen') {
                flashBlur(1500);
                Notification.warning('No está permitido capturar este documento');
            }
        }

        // Navegación por teclado
        if (k === 'arrowright' || k === 'pagedown') pdfNextPage();
        if (k === 'arrowleft' || k === 'pageup') pdfPrevPage();
        if (k === 'escape') closePdfViewer();
    };

    const onContext = (e) => {
        if (document.getElementById('pdf-viewer-modal').classList.contains('active')) {
            e.preventDefault();
        }
    };

    const onBlur = () => {
        if (document.getElementById('pdf-viewer-modal').classList.contains('active')) {
            document.body.classList.add('pdf-blur');
        }
    };
    const onFocus = () => {
        document.body.classList.remove('pdf-blur');
    };
    const onVisibility = () => {
        if (document.hidden) onBlur(); else onFocus();
    };

    const onCopy = (e) => {
        if (document.getElementById('pdf-viewer-modal').classList.contains('active')) {
            e.preventDefault();
        }
    };

    document.addEventListener('keydown', onKey, true);
    document.addEventListener('contextmenu', onContext, true);
    window.addEventListener('blur', onBlur);
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);
    document.addEventListener('copy', onCopy, true);
    document.addEventListener('cut', onCopy, true);

    _securityHandlers = { onKey, onContext, onBlur, onFocus, onVisibility, onCopy };
}

function detachSecurityGuards() {
    if (!_securityHandlers) return;
    const { onKey, onContext, onBlur, onFocus, onVisibility, onCopy } = _securityHandlers;
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('contextmenu', onContext, true);
    window.removeEventListener('blur', onBlur);
    window.removeEventListener('focus', onFocus);
    document.removeEventListener('visibilitychange', onVisibility);
    document.removeEventListener('copy', onCopy, true);
    document.removeEventListener('cut', onCopy, true);
    _securityHandlers = null;
    document.body.classList.remove('pdf-blur');
}

function flashBlur(ms) {
    document.body.classList.add('pdf-blur');
    setTimeout(() => document.body.classList.remove('pdf-blur'), ms);
}

// ---------- ADMIN: Gestión de documentos ----------

async function loadAllDocumentsAdmin() {
    try {
        const response = await API.getAllDocuments();
        if (!response.success) return;
        const docs = response.data.documents || [];
        const tbody = document.getElementById('documents-table-body');
        if (!tbody) return;

        if (docs.length === 0) {
            tbody.innerHTML = `<tr><td colspan="7" style="text-align:center; padding:20px;">No hay documentos subidos</td></tr>`;
            return;
        }

        tbody.innerHTML = docs.map(d => {
            const sizeKb = Math.round((d.file_size || 0) / 1024);
            return `
                <tr>
                    <td>${escapeHtml(d.name)}</td>
                    <td>${escapeHtml(d.category || '-')}</td>
                    <td>${escapeHtml(d.file_name)}</td>
                    <td>${sizeKb} KB</td>
                    <td>${d.users_with_access || 0}</td>
                    <td><span class="badge ${d.is_active ? 'active' : 'inactive'}">${d.is_active ? 'Activo' : 'Inactivo'}</span></td>
                    <td>
                        <button class="btn-icon" title="Asignar accesos" onclick="showDocumentAccessModal(${d.id}, '${escapeJs(d.name)}')">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                        </button>
                        <button class="btn-icon" title="Editar" onclick="editDocument(${d.id})">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                        </button>
                        <button class="btn-icon danger" title="Eliminar" onclick="deleteDocument(${d.id})">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6"/></svg>
                        </button>
                    </td>
                </tr>
            `;
        }).join('');
    } catch (e) {
        console.error('Error cargando documentos (admin):', e);
    }
}

function escapeJs(s) {
    return String(s || '').replace(/'/g, "\\'").replace(/"/g, '\\"');
}

function showCreateDocumentModal() {
    const modal = document.getElementById('create-document-modal');
    const form = document.getElementById('create-document-form');
    if (form) form.reset();
    modal.classList.add('active');
}

async function submitCreateDocument(e) {
    e.preventDefault();
    const form = e.target;
    const formData = new FormData(form);
    try {
        await API.uploadDocument(formData);
        Notification.success('Documento subido correctamente');
        closeModal('create-document-modal');
        loadAllDocumentsAdmin();
    } catch (err) {
        Notification.error(err.message || 'Error al subir documento');
    }
}

async function editDocument(id) {
    try {
        const resp = await API.getDocument(id);
        const d = resp.data.document;
        document.getElementById('edit-document-id').value = d.id;
        document.getElementById('edit-document-name').value = d.name || '';
        document.getElementById('edit-document-description').value = d.description || '';
        document.getElementById('edit-document-category').value = d.category || '';
        document.getElementById('edit-document-active').value = d.is_active ? '1' : '0';
        document.getElementById('edit-document-modal').classList.add('active');
    } catch (err) {
        Notification.error(err.message || 'Error al cargar documento');
    }
}

async function submitEditDocument(e) {
    e.preventDefault();
    const id = document.getElementById('edit-document-id').value;
    const data = {
        name: document.getElementById('edit-document-name').value,
        description: document.getElementById('edit-document-description').value,
        category: document.getElementById('edit-document-category').value,
        is_active: document.getElementById('edit-document-active').value === '1'
    };
    try {
        await API.updateDocument(id, data);
        Notification.success('Documento actualizado');
        closeModal('edit-document-modal');
        loadAllDocumentsAdmin();
    } catch (err) {
        Notification.error(err.message || 'Error al actualizar documento');
    }
}

async function deleteDocument(id) {
    if (!confirm('¿Eliminar este documento? Esta acción no se puede deshacer.')) return;
    try {
        await API.deleteDocument(id);
        Notification.success('Documento eliminado');
        loadAllDocumentsAdmin();
    } catch (err) {
        Notification.error(err.message || 'Error al eliminar documento');
    }
}

// ---------- ADMIN: Permisos de documentos ----------

let _docAccessState = { documentId: null, users: [] };

async function showDocumentAccessModal(documentId, documentName) {
    try {
        const [usersResp, matrixResp] = await Promise.all([
            API.getUsers({ limit: 500 }),
            API.getDocumentsPermissionsMatrix()
        ]);
        const users = (usersResp.data && (usersResp.data.users || usersResp.data)) || [];
        const matrix = matrixResp.data.matrix || [];

        _docAccessState.documentId = documentId;
        _docAccessState.users = users;

        document.getElementById('doc-access-modal-title').textContent = `Accesos - ${documentName}`;
        document.getElementById('doc-access-document-id').value = documentId;

        const currentPerms = {};
        matrix.forEach(row => {
            const perm = row.permissions[documentId];
            if (perm && perm.can_view) currentPerms[row.user.id] = true;
        });

        const container = document.getElementById('doc-user-list-checkboxes');
        container.innerHTML = users.filter(u => u.role !== 'admin').map(u => `
            <label class="checkbox-row">
                <input type="checkbox" class="doc-user-check" data-user-id="${u.id}" ${currentPerms[u.id] ? 'checked' : ''}>
                <span>${escapeHtml(u.full_name || u.username)} <small>(${escapeHtml(u.username)})</small></span>
            </label>
        `).join('');

        document.getElementById('doc-access-modal').classList.add('active');
    } catch (err) {
        Notification.error(err.message || 'Error al cargar accesos');
    }
}

async function saveDocumentPermissions() {
    const documentId = parseInt(document.getElementById('doc-access-document-id').value, 10);
    const checks = document.querySelectorAll('.doc-user-check');
    const saveBtn = document.querySelector('#doc-access-modal .btn-primary');

    const userIds = [];
    checks.forEach(ch => {
        if (ch.checked) {
            const id = parseInt(ch.dataset.userId, 10);
            if (Number.isInteger(id) && id > 0) userIds.push(id);
        }
    });

    if (saveBtn) {
        saveBtn.disabled = true;
        saveBtn._origText = saveBtn.innerText;
        saveBtn.innerText = 'Guardando...';
    }

    try {
        // Sync atómico: define exactamente quién tiene acceso en una sola llamada.
        const resp = await API.syncDocumentPermissions(documentId, userIds);
        if (resp && resp.success) {
            Notification.success(`Accesos actualizados (${userIds.length} usuario${userIds.length !== 1 ? 's' : ''})`);
            closeModal('doc-access-modal');
            if (typeof loadAllDocumentsAdmin === 'function') loadAllDocumentsAdmin();
            if (typeof loadDocumentsPermissionsMatrix === 'function') loadDocumentsPermissionsMatrix();
        } else {
            Notification.error((resp && resp.message) || 'No se pudieron guardar los accesos');
        }
    } catch (err) {
        console.error('saveDocumentPermissions:', err);
        Notification.error(err.message || 'Error al guardar accesos');
    } finally {
        if (saveBtn) {
            saveBtn.disabled = false;
            saveBtn.innerText = saveBtn._origText || 'Guardar Accesos';
        }
    }
}

async function loadDocumentsPermissionsMatrix() {
    const container = document.getElementById('doc-permissions-matrix');
    if (!container) return;
    try {
        container.innerHTML = '<div class="loading"><div class="spinner"></div><div class="loading-text">Cargando...</div></div>';
        const resp = await API.getDocumentsPermissionsMatrix();
        const { users, documents, matrix } = resp.data;

        if (!documents.length) {
            container.innerHTML = '<p>No hay documentos para asignar permisos.</p>';
            return;
        }

        let html = '<div class="matrix-table-wrapper"><table class="matrix-table"><thead><tr><th>Usuario</th>';
        documents.forEach(d => {
            html += `<th title="${escapeHtml(d.name)}">${escapeHtml(d.name)}</th>`;
        });
        html += '</tr></thead><tbody>';

        matrix.forEach(row => {
            if (row.user.role === 'admin') return;
            html += `<tr><td class="matrix-user">${escapeHtml(row.user.full_name || row.user.username)}</td>`;
            documents.forEach(d => {
                const p = row.permissions[d.id];
                const checked = p && p.can_view ? 'checked' : '';
                html += `<td><input type="checkbox" ${checked} onchange="toggleDocPermissionCell(${row.user.id}, ${d.id}, this.checked)"></td>`;
            });
            html += '</tr>';
        });
        html += '</tbody></table></div>';
        container.innerHTML = html;
    } catch (err) {
        container.innerHTML = `<p>Error al cargar matriz: ${escapeHtml(err.message)}</p>`;
    }
}

async function toggleDocPermissionCell(userId, documentId, checked) {
    try {
        if (checked) {
            await API.assignDocumentPermission(userId, documentId, { can_view: true });
        } else {
            await API.removeDocumentPermission(userId, documentId);
        }
    } catch (err) {
        Notification.error(err.message || 'Error al actualizar permiso');
    }
}

// Hooks de formularios (se enlazan cuando el DOM está listo)
document.addEventListener('DOMContentLoaded', () => {
    const createForm = document.getElementById('create-document-form');
    if (createForm) createForm.addEventListener('submit', submitCreateDocument);
    const editForm = document.getElementById('edit-document-form');
    if (editForm) editForm.addEventListener('submit', submitEditDocument);
});

// Exponer globals
window.loadMyDocuments = loadMyDocuments;
window.openDocument = openDocument;
window.closePdfViewer = closePdfViewer;
window.pdfNextPage = pdfNextPage;
window.pdfPrevPage = pdfPrevPage;
window.pdfZoomIn = pdfZoomIn;
window.pdfZoomOut = pdfZoomOut;
window.loadAllDocumentsAdmin = loadAllDocumentsAdmin;
window.showCreateDocumentModal = showCreateDocumentModal;
window.editDocument = editDocument;
window.deleteDocument = deleteDocument;
window.showDocumentAccessModal = showDocumentAccessModal;
window.saveDocumentPermissions = saveDocumentPermissions;
window.loadDocumentsPermissionsMatrix = loadDocumentsPermissionsMatrix;
window.toggleDocPermissionCell = toggleDocPermissionCell;
