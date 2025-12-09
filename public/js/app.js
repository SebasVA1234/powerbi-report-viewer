// Main Application Module
const App = {
    init() {
        // Check authentication on load
        this.checkAuth();
        
        // Setup global event listeners
        this.setupEventListeners();
    },
    
    async checkAuth() {
        const token = Utils.getToken();
        
        if (!token) {
            this.showLoginPage();
            return;
        }
        
        // Verify token with server
        const isValid = await Auth.verify();
        
        if (isValid) {
            this.showDashboard();
        } else {
            Utils.removeToken();
            Utils.removeUser();
            this.showLoginPage();
        }
    },
    
    showLoginPage() {
        showPage('login-page');
        document.getElementById('username').focus();
    },
    
    showDashboard() {
        showPage('dashboard-page');
        initializeDashboard();
    },
    
    setupEventListeners() {
        // Handle browser back button
        window.addEventListener('popstate', (e) => {
            if (e.state && e.state.page) {
                showPage(e.state.page);
            }
        });
        
        // Handle session timeout
        let timeout;
        const resetTimeout = () => {
            clearTimeout(timeout);
            timeout = setTimeout(() => {
                if (Auth.isAuthenticated()) {
                    Notification.warning('Su sesión ha expirado');
                    Auth.logout();
                }
            }, 60 * 60 * 1000); // 1 hour
        };
        
        ['mousedown', 'keydown', 'scroll', 'touchstart'].forEach(event => {
            document.addEventListener(event, resetTimeout);
        });
        
        resetTimeout();
        
        // Handle network errors
        window.addEventListener('online', () => {
            Notification.success('Conexión restaurada');
        });
        
        window.addEventListener('offline', () => {
            Notification.error('Sin conexión a internet');
        });
    }
};

// Page Navigation
function showPage(pageId) {
    // Hide all pages
    document.querySelectorAll('.page').forEach(page => {
        page.classList.remove('active');
    });
    
    // Show selected page
    const page = document.getElementById(pageId);
    if (page) {
        page.classList.add('active');
        
        // Update browser history
        history.pushState({ page: pageId }, '', `#${pageId}`);
    }
}

// Global Error Handler - SILENCIADO para no mostrar errores molestos
window.addEventListener('error', (e) => {
    console.error('Global error:', e.error);
    // Solo mostrar errores críticos, no todos
    // Notification.error('Ha ocurrido un error inesperado');
});

// Handle unhandled promise rejections
window.addEventListener('unhandledrejection', (e) => {
    console.error('Unhandled promise rejection:', e.reason);
    // Notification.error('Error en la aplicación');
});

// Initialize app when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    App.init();
});

// Export functions for global access
window.showPage = showPage;
window.showSection = showSection;
window.logout = logout;
window.openReport = openReport;
window.closeReportViewer = closeReportViewer;
window.exportReport = exportReport;
window.loadMyReports = loadMyReports;
window.showCreateUserModal = showCreateUserModal;
window.showCreateReportModal = showCreateReportModal;
window.closeModal = closeModal;
window.deleteUser = deleteUser;
window.deleteReport = deleteReport;
window.editUser = editUser;
window.editReport = editReport;
window.showReportAccessModal = showReportAccessModal;
window.togglePermission = togglePermission;
window.showBulkAssignModal = showBulkAssignModal;
window.showClonePermissionsModal = showClonePermissionsModal;
window.togglePasswordVisibility = togglePasswordVisibility;
window.savePermissions = savePermissions;

// Service Worker Registration (for PWA capabilities)
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js').then(
            (registration) => {
                console.log('ServiceWorker registration successful');
            },
            (err) => {
                // Silently fail - SW is optional
                console.log('ServiceWorker registration failed: ', err);
            }
        );
    });
}

/* =============================================
   SIDEBAR TOGGLE - Agregar al final de cualquier archivo JS
   o crear como archivo separado y agregarlo al HTML
   ============================================= */

// Función para colapsar/expandir el sidebar
function toggleSidebar() {
    const sidebar = document.getElementById('sidebar');
    const mainWrapper = document.querySelector('.main-wrapper');
    
    if (sidebar) {
        sidebar.classList.toggle('collapsed');
    }
    if (mainWrapper) {
        mainWrapper.classList.toggle('expanded');
    }
}

// Conectar el botón del menú cuando cargue la página
document.addEventListener('DOMContentLoaded', function() {
    const menuToggle = document.getElementById('menu-toggle');
    
    if (menuToggle) {
        menuToggle.addEventListener('click', toggleSidebar);
    }
});

// Exportar la función globalmente
window.toggleSidebar = toggleSidebar;