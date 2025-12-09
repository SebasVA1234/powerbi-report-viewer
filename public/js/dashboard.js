// Dashboard Module
let currentReports = [];
let reportViewer = null;

// Initialize Dashboard
async function initializeDashboard() {
    updateUserDisplay();
    setupProfileForms();
    await loadMyReports();
    updateWelcomeSection();

    // Setup search functionality
    const searchInput = document.getElementById('search-reports');
    if (searchInput) {
        searchInput.addEventListener('input', Utils.debounce((e) => {
            filterReports(e.target.value);
        }, 300));
    }
}

// Update welcome section with user name and report count
function updateWelcomeSection() {
    const user = Auth.getCurrentUser();
    if (user) {
        // Update welcome name with full_name from profile
        const welcomeName = document.getElementById('welcome-name');
        if (welcomeName) {
            welcomeName.textContent = user.full_name || user.username;
        }
        
        // Update user avatar initial
        const userAvatar = document.getElementById('user-avatar');
        if (userAvatar) {
            const name = user.full_name || user.username;
            userAvatar.textContent = name.charAt(0).toUpperCase();
        }
        
        // Update report count
        const statReports = document.getElementById('stat-reports');
        if (statReports) {
            statReports.textContent = currentReports.length;
        }
    }
}

// Load My Reports
async function loadMyReports() {
    const container = document.getElementById('reports-container');
    
    try {
        container.innerHTML = `
            <div class="loading">
                <div class="spinner"></div>
                <div class="loading-text">Cargando reportes...</div>
            </div>
        `;
        
        const response = await API.getMyReports();
        
        if (response.success) {
            let rawReports = response.data.reports;

            // --- FILTRO ANTI-DUPLICADOS ---
            // Usamos un Map para asegurar que solo haya un reporte por ID
            const uniqueReportsMap = new Map();
            rawReports.forEach(r => uniqueReportsMap.set(r.id, r));
            currentReports = Array.from(uniqueReportsMap.values());
            // ------------------------------
            
            if (currentReports.length === 0) {
                container.innerHTML = `
                    <div class="empty-state">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><line x1="9" y1="9" x2="15" y2="9"></line><line x1="9" y1="15" x2="15" y2="15"></line></svg>
                        <h3>No hay reportes disponibles</h3>
                        <p>No tiene acceso a ningún reporte en este momento.</p>
                        ${Auth.isAdmin() ? '<button class="btn btn-primary" onclick="showSection(\'admin\')">Ir a Administración</button>' : ''}
                    </div>
                `;
            } else {
                displayReports(currentReports);
            }
        }
    } catch (error) {
        console.error('Error loading reports:', error);
        container.innerHTML = `
            <div class="empty-state">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg>
                <h3>Error al cargar reportes</h3>
                <p>${error.message || 'Ha ocurrido un error al cargar los reportes'}</p>
                <button class="btn btn-primary" onclick="loadMyReports()">Reintentar</button>
            </div>
        `;
    }
}

// Display Reports
function displayReports(reports) {
    const container = document.getElementById('reports-container');
    
    // Group reports by category
    const grouped = reports.reduce((acc, report) => {
        const category = report.category || 'Sin categoría';
        if (!acc[category]) {
            acc[category] = [];
        }
        acc[category].push(report);
        return acc;
    }, {});
    
    let html = '';
    
    for (const [category, categoryReports] of Object.entries(grouped)) {
        html += `
            <div class="category-group">
                <div class="category-header">
                    <div class="category-icon">${getCategoryIcon(category)}</div>
                    <h3>${category}</h3>
                    <span class="category-count">${categoryReports.length} reporte${categoryReports.length !== 1 ? 's' : ''}</span>
                </div>
                <div class="reports-grid">
                    ${categoryReports.map(report => createReportCard(report)).join('')}
                </div>
            </div>
        `;
    }
    
    container.innerHTML = html;
}

// Create Report Card
function createReportCard(report) {
    const canExport = report.can_export || Auth.isAdmin();
    
    return `
        <div class="report-card" data-report-id="${report.id}">
            <div class="report-card-header">
                <div>
                    ${report.category ? `<span class="report-category">${report.category}</span>` : ''}
                    <h3>${report.name}</h3>
                </div>
                <span class="report-favorite" title="Marcar como favorito">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon>
                    </svg>
                </span>
            </div>
            <div class="report-card-body">
                <p class="report-description">${report.description || 'Sin descripción disponible'}</p>
                <div class="report-meta">
                    <div class="report-meta-item">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line></svg>
                        <span>${Utils.formatDate(report.created_at)}</span>
                    </div>
                    <div class="report-actions">
                        <button class="btn-view-report" onclick="openReport(${report.id})">Ver</button>
                        ${canExport ? `<button class="btn-export" onclick="exportReport(${report.id})">Exportar</button>` : ''}
                    </div>
                </div>
            </div>
        </div>
    `;
}

// Get Category Icon
function getCategoryIcon(category) {
    const icons = {
        'Ventas': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="1" x2="12" y2="23"></line><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"></path></svg>',
        'Finanzas': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3v18h18"></path><path d="M18.7 8l-5.1 5.2-2.8-2.7L7 14.3"></path></svg>',
        'Operaciones': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"></circle><path d="M12 1v6m0 6v6m4.22-13.22l4.24 4.24M1.54 9.54l4.24 4.24"></path></svg>',
        'Marketing': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 16V8l-11 4V2L2 8v10l9-4v8l11-6z"></path></svg>',
        'RRHH': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path></svg>'
    };
    return icons[category] || '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><line x1="9" y1="9" x2="15" y2="9"></line><line x1="9" y1="15" x2="15" y2="15"></line></svg>';
}

// Filter Reports
function filterReports(searchTerm) {
    const filtered = currentReports.filter(report => {
        const term = searchTerm.toLowerCase();
        return report.name.toLowerCase().includes(term) ||
               (report.description && report.description.toLowerCase().includes(term)) ||
               (report.category && report.category.toLowerCase().includes(term));
    });
    displayReports(filtered);
}

// Open Report - Usa el sistema de ventanas múltiples
async function openReport(reportId) {
    try {
        const response = await API.getReport(reportId);
        if (response.success) {
            const report = response.data.report;
            // Usar WindowManager para abrir en ventana
            if (window.windowManager) {
                windowManager.openWindow(reportId, report.name, report.embed_url);
            } else {
                // Fallback al modal antiguo si windowManager no está disponible
                const modal = document.getElementById('report-viewer');
                const iframe = document.getElementById('report-iframe');
                const title = document.getElementById('report-viewer-title');
                
                title.textContent = report.name;
                iframe.src = report.embed_url;
                modal.classList.add('active');
            }
        }
    } catch (error) {
        Notification.error('Error al abrir el reporte');
    }
}

// Close Report Viewer
function closeReportViewer() {
    const modal = document.getElementById('report-viewer');
    const iframe = document.getElementById('report-iframe');
    modal.classList.remove('active');
    setTimeout(() => { iframe.src = ''; }, 300);
}

// Export Report
function exportReport(reportId) {
    const report = currentReports.find(r => r.id === reportId);
    if (report && report.can_export) {
        Notification.info('Función de exportación en desarrollo');
    } else {
        Notification.warning('No tiene permisos para exportar este reporte');
    }
}

// Show Section
function showSection(sectionName) {
    document.querySelectorAll('.content-section').forEach(section => {
        section.classList.remove('active');
    });
    const section = document.getElementById(`${sectionName}-section`);
    if (section) {
        section.classList.add('active');
        document.querySelectorAll('.nav-link').forEach(link => {
            link.classList.remove('active');
        });
        const activeLink = document.querySelector(`.nav-link[data-section="${sectionName}"]`);
        if (activeLink) {
            activeLink.classList.add('active');
        }
        switch (sectionName) {
            case 'reports': loadMyReports(); break;
            case 'profile': loadProfileData(); break;
            case 'admin': if (Auth.isAdmin()) initializeAdminSection(); break;
        }
    }
}

// Setup Navigation
document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('.nav-link').forEach(link => {
        link.addEventListener('click', () => {
            const section = link.dataset.section;
            showSection(section);
        });
    });
    document.querySelectorAll('.modal').forEach(modal => {
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                modal.classList.remove('active');
            }
        });
    });
});