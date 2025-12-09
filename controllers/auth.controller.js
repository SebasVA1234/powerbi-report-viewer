const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../config/database');

class AuthController {
    // Login de usuario
    static login(req, res) {
        try {
            const { username, password } = req.body;

            if (!username || !password) {
                return res.status(400).json({
                    success: false,
                    message: 'Usuario y contraseña son requeridos'
                });
            }

            // Buscar usuario por username o email
            const user = db.prepare(`
                SELECT id, username, email, password, full_name, role, is_active 
                FROM users 
                WHERE (username = ? OR email = ?) AND is_active = 1
            `).get(username, username);

            if (!user) {
                return res.status(401).json({
                    success: false,
                    message: 'Credenciales inválidas'
                });
            }

            // Verificar contraseña
            const isValidPassword = bcrypt.compareSync(password, user.password);
            if (!isValidPassword) {
                return res.status(401).json({
                    success: false,
                    message: 'Credenciales inválidas'
                });
            }

            // Generar token JWT
            const token = jwt.sign(
                {
                    id: user.id,
                    username: user.username,
                    email: user.email,
                    role: user.role,
                    full_name: user.full_name
                },
                process.env.JWT_SECRET,
                { expiresIn: process.env.JWT_EXPIRY || '24h' }
            );

            // Registrar acceso
            db.prepare(`
                INSERT INTO access_logs (user_id, action, ip_address, user_agent)
                VALUES (?, ?, ?, ?)
            `).run(
                user.id,
                'login',
                req.ip || 'unknown',
                req.headers['user-agent'] || 'unknown'
            );

            // Eliminar contraseña del objeto usuario
            delete user.password;

            res.json({
                success: true,
                message: 'Login exitoso',
                data: {
                    user,
                    token
                }
            });
        } catch (error) {
            console.error('Error en login:', error);
            res.status(500).json({
                success: false,
                message: 'Error al iniciar sesión'
            });
        }
    }

    // Verificar token actual
    static verify(req, res) {
        try {
            // El middleware ya verificó el token
            const user = db.prepare(`
                SELECT id, username, email, full_name, role, is_active 
                FROM users 
                WHERE id = ? AND is_active = 1
            `).get(req.user.id);

            if (!user) {
                return res.status(404).json({
                    success: false,
                    message: 'Usuario no encontrado'
                });
            }

            res.json({
                success: true,
                data: { user }
            });
        } catch (error) {
            console.error('Error al verificar token:', error);
            res.status(500).json({
                success: false,
                message: 'Error al verificar sesión'
            });
        }
    }

    // Cambiar contraseña - DESHABILITADO para usuarios normales
    // Solo el administrador puede cambiar contraseñas desde el panel de administración
    static changePassword(req, res) {
        return res.status(403).json({
            success: false,
            message: 'El cambio de contraseña está deshabilitado. Contacte al administrador.'
        });
    }

    // Logout (registrar en logs)
    static logout(req, res) {
        try {
            // Registrar logout
            db.prepare(`
                INSERT INTO access_logs (user_id, action, ip_address)
                VALUES (?, ?, ?)
            `).run(req.user.id, 'logout', req.ip || 'unknown');

            res.json({
                success: true,
                message: 'Sesión cerrada exitosamente'
            });
        } catch (error) {
            console.error('Error en logout:', error);
            res.status(500).json({
                success: false,
                message: 'Error al cerrar sesión'
            });
        }
    }
}

module.exports = AuthController;
