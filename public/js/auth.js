// Auth Module
const Auth = {
    async login(username, password) {
        try {
            const response = await API.login(username, password);

            if (response.success) {
                // PR-0b.1: si el backend pide TOTP, NO guardamos sesión todavía.
                // Devolvemos el response al caller para que maneje el 2do paso.
                if (response.data && response.data.needs_totp) {
                    return response;
                }
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

// Forzado de cambio de password en el primer login.
// Si el backend devuelve must_change_password=true, pedimos una nueva
// pass con prompt() y llamamos al endpoint /auth/change-my-password.
// La UI definitiva (modal con confirmación, validación, etc.) llega en
// Fase 2; este flujo es deliberadamente austero para no extender PR-0b
// más allá del scope de seguridad.
async function handleForcedPasswordChange(username) {
    while (true) {
        const newPass = window.prompt(
            'Debes cambiar tu contraseña antes de continuar.\n\n' +
            'Mínimo 8 caracteres.'
        );
        if (newPass === null) {
            // El usuario canceló el prompt — cerramos sesión.
            await Auth.logout();
            return false;
        }
        if (typeof newPass !== 'string' || newPass.length < 8) {
            window.alert('La contraseña debe tener al menos 8 caracteres.');
            continue;
        }
        try {
            const resp = await fetch('/api/auth/change-my-password', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${Utils.getToken()}`
                },
                body: JSON.stringify({ new_password: newPass })
            });
            const data = await resp.json();
            if (resp.ok && data.success) {
                window.alert('Contraseña actualizada. Volvé a iniciar sesión con la nueva.');
                Utils.removeToken();
                Utils.removeUser();
                window.location.reload();
                return true;
            }
            window.alert(data.message || 'No se pudo cambiar la contraseña.');
        } catch (err) {
            window.alert('Error de red al cambiar la contraseña.');
        }
    }
}

// PR-0b.1: si el login devuelve needs_totp, pedimos el código de la app
// autenticadora con prompt() y llamamos /auth/totp/verify usando el
// totp_token (JWT temporal de 5 min) como Authorization. Si el código
// es correcto, recibimos el JWT real y guardamos la sesión.
// UI definitiva (modal con autofocus, retry pulido, recovery codes)
// llega en Fase 2.
async function handleTotpRequired(totpToken) {
    while (true) {
        const code = window.prompt('Ingresá el código de 6 dígitos de tu app autenticadora (Google Authenticator, Authy, etc.)');
        if (code === null) {
            // Cancelado → volvemos al login limpio
            return false;
        }
        if (!/^\d{6}$/.test(code)) {
            window.alert('Debe ser un código de 6 dígitos.');
            continue;
        }
        try {
            const resp = await fetch('/api/auth/totp/verify', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${totpToken}`
                },
                body: JSON.stringify({ code })
            });
            const data = await resp.json();
            if (resp.ok && data.success) {
                Utils.setToken(data.data.token);
                Utils.setUser(data.data.user);
                return true;
            }
            window.alert(data.message || 'Código incorrecto.');
        } catch (err) {
            window.alert('Error de red al verificar el código.');
        }
    }
}

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

                const resp = await Auth.login(username, password);

                // PR-0b.1: 2FA pendiente
                if (resp && resp.data && resp.data.needs_totp) {
                    Notification.info('Verificación 2FA requerida');
                    const ok = await handleTotpRequired(resp.data.totp_token);
                    if (!ok) {
                        Notification.error('Verificación 2FA cancelada');
                        return;
                    }
                    Notification.success('Inicio de sesión exitoso');
                    setTimeout(() => {
                        showPage('dashboard-page');
                        initializeDashboard();
                    }, 500);
                    return;
                }

                if (resp && resp.data && resp.data.user && resp.data.user.must_change_password) {
                    Notification.info('Cambio de contraseña obligatorio');
                    await handleForcedPasswordChange(username);
                    return;  // handleForcedPasswordChange recarga la página tras éxito
                }

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
    
    // Password Change Form (sección Mi Perfil)
    const passwordForm = document.getElementById('change-password-form');
    if (passwordForm) {
        passwordForm.addEventListener('submit', async (e) => {
            e.preventDefault();

            const currentPassword = document.getElementById('profile-current-password').value;
            const newPassword     = document.getElementById('profile-new-password').value;
            const confirmPassword = document.getElementById('profile-new-password-2').value;

            if (newPassword !== confirmPassword) {
                Notification.error('Las contraseñas nuevas no coinciden');
                return;
            }
            if (newPassword.length < 8) {
                Notification.error('La nueva contraseña debe tener al menos 8 caracteres');
                return;
            }
            if (newPassword === currentPassword) {
                Notification.error('La nueva contraseña no puede ser igual a la actual');
                return;
            }

            const submitBtn = passwordForm.querySelector('button[type="submit"]');
            if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Cambiando...'; }
            try {
                await API.changePassword(currentPassword, newPassword);
                Notification.success('Contraseña actualizada. La próxima vez que entres usá la nueva.');
                passwordForm.reset();
            } catch (error) {
                Notification.error(error.message || 'Error al cambiar contraseña');
            } finally {
                if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Cambiar contraseña'; }
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
