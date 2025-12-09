// Configuration
const CONFIG = {
    API_BASE_URL: '/api',
    TOKEN_KEY: 'powerbi_token',
    USER_KEY: 'powerbi_user',
    DEFAULT_TIMEOUT: 30000,
    NOTIFICATION_DURATION: 5000
};

// API Endpoints
const API_ENDPOINTS = {
    // Auth
    LOGIN: '/auth/login',
    VERIFY: '/auth/verify',
    LOGOUT: '/auth/logout',
    CHANGE_PASSWORD: '/auth/change-password',
    
    // Users
    USERS: '/users',
    USER_PROFILE: '/users/profile',
    
    // Reports
    MY_REPORTS: '/reports/my-reports',
    REPORTS: '/reports',
    
    // Permissions
    PERMISSIONS: '/permissions',
    PERMISSIONS_MATRIX: '/permissions/matrix',
    BULK_ASSIGN: '/permissions/bulk-assign',
    CLONE_PERMISSIONS: '/permissions/clone'
};

// Utility Functions
const Utils = {
    getToken() {
        return localStorage.getItem(CONFIG.TOKEN_KEY);
    },
    
    setToken(token) {
        localStorage.setItem(CONFIG.TOKEN_KEY, token);
    },
    
    removeToken() {
        localStorage.removeItem(CONFIG.TOKEN_KEY);
    },
    
    getUser() {
        const user = localStorage.getItem(CONFIG.USER_KEY);
        return user ? JSON.parse(user) : null;
    },
    
    setUser(user) {
        localStorage.setItem(CONFIG.USER_KEY, JSON.stringify(user));
    },
    
    removeUser() {
        localStorage.removeItem(CONFIG.USER_KEY);
    },
    
    formatDate(dateString) {
        const options = { 
            year: 'numeric', 
            month: 'short', 
            day: 'numeric', 
            hour: '2-digit', 
            minute: '2-digit' 
        };
        return new Date(dateString).toLocaleDateString('es-ES', options);
    },
    
    debounce(func, wait) {
        let timeout;
        return function executedFunction(...args) {
            const later = () => {
                clearTimeout(timeout);
                func(...args);
            };
            clearTimeout(timeout);
            timeout = setTimeout(later, wait);
        };
    }
};
