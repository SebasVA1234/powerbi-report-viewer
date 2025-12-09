// Auth Module
const Auth = {
    async login(username, password) {
        try {
            const response = await API.login(username, password);
            
            if (response.success) {
                Utils.setToken(response.data.token);
                Utils.setUser(response.data.user);
                return response;
            }
            
            throw new Error(response.message);
        } catch (error) {
            console.error('Login error:', error);
            throw error;
        }
    },
    
    async verify() {
        try {
            const response = await API.verify();
            if (response.success) {
                Utils.setUser(response.data.user);
                return true;
            }
            return false;
        } catch (error) {
            console.error('Verify error:', error);
            return false;
        }
    },
    
    async logout() {
        try {
            await API.logout();
        } catch (error) {
            console.error('Logout error:', error);
        } finally {
            Utils.removeToken();
            Utils.removeUser();
            window.location.reload();
        }
    },
    
    isAuthenticated() {
        return !!Utils.getToken();
    },
    
    getCurrentUser() {
        return Utils.getUser();
    },
    
    isAdmin() {
        const user = this.getCurrentUser();
        return user && user.role === 'admin';
    }
};

// Login Form Handler
document.addEventListener('DOMContentLoaded', () => {
    const loginForm = document.getElementById('login-form');
    if (loginForm) {
        loginForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            
            const username = document.getElementById('username').value;
            const password = document.getElementById('password').value;
            const submitBtn = loginForm.querySelector('button[type="submit"]');
            
            try {
                submitBtn.disabled = true;
                submitBtn.innerHTML = '<span>Iniciando sesión...</span>';
                
                await Auth.login(username, password);
                
                Notification.success('Inicio de sesión exitoso');
                
                // Redirigir al dashboard
                setTimeout(() => {
                    showPage('dashboard-page');
                    initializeDashboard();
                }, 500);
                
            } catch (error) {
                Notification.error(error.message || 'Error al iniciar sesión');
            } finally {
                submitBtn.disabled = false;
                submitBtn.innerHTML = '<span>Iniciar Sesión</span>';
            }
        });
    }
});

// Logout Function
async function logout() {
    if (confirm('¿Está seguro que desea cerrar sesión?')) {
        await Auth.logout();
    }
}

// Profile Forms Handlers
function setupProfileForms() {
    // Profile Update Form
    const profileForm = document.getElementById('profile-form');
    if (profileForm) {
        profileForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            
            const fullName = document.getElementById('profile-fullname').value;
            const email = document.getElementById('profile-email').value;
            
            try {
                await API.updateProfile({ full_name: fullName, email });
                
                // Update user data in localStorage
                const user = Utils.getUser();
                if (user) {
                    user.full_name = fullName;
                    user.email = email;
                    Utils.setUser(user);
                    updateUserDisplay();
                }
                
                Notification.success('Perfil actualizado exitosamente');
            } catch (error) {
                Notification.error(error.message || 'Error al actualizar perfil');
            }
        });
    }
    
    // Password Change Form
    const passwordForm = document.getElementById('password-form');
    if (passwordForm) {
        passwordForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            
            const currentPassword = document.getElementById('current-password').value;
            const newPassword = document.getElementById('new-password').value;
            const confirmPassword = document.getElementById('confirm-password').value;
            
            if (newPassword !== confirmPassword) {
                Notification.error('Las contraseñas no coinciden');
                return;
            }
            
            if (newPassword.length < 6) {
                Notification.error('La contraseña debe tener al menos 6 caracteres');
                return;
            }
            
            try {
                await API.changePassword(currentPassword, newPassword);
                
                Notification.success('Contraseña actualizada exitosamente');
                passwordForm.reset();
            } catch (error) {
                Notification.error(error.message || 'Error al cambiar contraseña');
            }
        });
    }
}

// Load Profile Data
async function loadProfileData() {
    try {
        const response = await API.getProfile();
        
        if (response.success) {
            const user = response.data.user;
            
            // Mostrar username
            const usernameField = document.getElementById('profile-username');
            if (usernameField) {
                usernameField.value = user.username || '';
            }
            
            // Mostrar email
            const emailField = document.getElementById('profile-email');
            if (emailField) {
                emailField.value = user.email || '';
            }
            
            // Nombre editable
            const fullnameField = document.getElementById('profile-fullname');
            if (fullnameField) {
                fullnameField.value = user.full_name || '';
            }
        }
    } catch (error) {
        console.error('Error loading profile:', error);
        Notification.error('Error al cargar datos del perfil');
    }
}

// Update User Display
function updateUserDisplay() {
    const user = Auth.getCurrentUser();
    if (user) {
        const userNameElement = document.getElementById('current-user-name');
        const userRoleElement = document.getElementById('current-user-role');
        
        if (userNameElement) userNameElement.textContent = user.full_name || user.username;
        if (userRoleElement) userRoleElement.textContent = user.role === 'admin' ? 'Administrador' : 'Usuario';
        
        // Show/hide admin menu
        const adminMenu = document.querySelector('.admin-only');
        if (adminMenu) {
            adminMenu.style.display = user.role === 'admin' ? 'flex' : 'none';
        }
    }
}
