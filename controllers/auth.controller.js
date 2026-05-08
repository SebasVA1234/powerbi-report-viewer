const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../config/db');

class AuthController {
    // Login de usuario
    static async login(req, res) {
        try {
            const { username, password } = req.body;

            if (!username || !password) {
                return res.status(400).json({
                    success: false,
                    message: 'Usuario y contraseña son requeridos'
                });
            }

            // Buscar usuario por username o email
            const user = await db.queryOne(`
                SELECT id, username, email, password, full_name, role, is_active,
                       must_change_password
                FROM users
                WHERE (username = ? OR email = ?) AND is_active = 1
            `, [username, username]);

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

            const mustChangePassword = !!Number(user.must_change_password);

            // Generar token JWT — incluye must_change_password para que el
            // middleware bloquee acciones sensibles hasta que el user cambie
            // su pass (excepto el endpoint /auth/change-my-password y /logout).
            const token = jwt.sign(
                {
                    id: user.id,
                    username: user.username,
                    email: user.email,
                    role: user.role,
                    full_name: user.full_name,
                    must_change_password: mustChangePassword
                },
                process.env.JWT_SECRET,
                { expiresIn: process.env.JWT_EXPIRY || '24h' }
            );

            // Registrar acceso
            await db.execute(`
                INSERT INTO access_logs (user_id, action, ip_address, user_agent)
                VALUES (?, ?, ?, ?)
            `, [
                user.id,
                'login',
                req.ip || 'unknown',
                req.headers['user-agent'] || 'unknown'
            ]);

            // Eliminar contraseña del objeto usuario
            delete user.password;
            user.must_change_password = mustChangePassword;

            res.json({
                success: true,
                message: 'Login exitoso',
                data: { user, token }
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
    static async verify(req, res) {
        try {
            const user = await db.queryOne(`
                SELECT id, username, email, full_name, role, is_active
                FROM users
                WHERE id = ? AND is_active = 1
            `, [req.user.id]);

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
    // (deja la URL existente respondiendo 403 para no romper clientes que
    // pudieran llamarla; el flujo nuevo es /auth/change-my-password)
    static changePassword(req, res) {
        return res.status(403).json({
            success: false,
            message: 'El cambio de contraseña libre está deshabilitado. Use change-my-password si tiene must_change_password=1.'
        });
    }

    // Cambio obligatorio de password en el primer login (must_change_password=1).
    // El user debe estar logueado (JWT válido). No requiere current_password
    // porque el flujo es exclusivamente para el caso forzado.
    static async changeMyPassword(req, res) {
        try {
            const { new_password } = req.body;

            if (!new_password || typeof new_password !== 'string' || new_password.length < 8) {
                return res.status(400).json({
                    success: false,
                    message: 'La nueva contraseña debe tener al menos 8 caracteres'
                });
            }

            // Verificar que el user realmente esté en estado must_change_password.
            // Si no lo está, este endpoint no aplica — usar el flujo regular
            // (que hoy está deshabilitado y se reabrirá en una PR futura).
            const dbUser = await db.queryOne(
                'SELECT id, must_change_password FROM users WHERE id = ?',
                [req.user.id]
            );
            if (!dbUser) {
                return res.status(404).json({ success: false, message: 'Usuario no encontrado' });
            }
            if (!Number(dbUser.must_change_password)) {
                return res.status(400).json({
                    success: false,
                    message: 'No se requiere cambio de contraseña para este usuario'
                });
            }

            const hashed = bcrypt.hashSync(new_password, 10);
            await db.execute(
                'UPDATE users SET password = ?, must_change_password = 0 WHERE id = ?',
                [hashed, req.user.id]
            );

            await db.execute(
                'INSERT INTO access_logs (user_id, action, ip_address, user_agent) VALUES (?, ?, ?, ?)',
                [req.user.id, 'forced_password_change', req.ip || 'unknown', req.headers['user-agent'] || 'unknown']
            );

            // El JWT actual ya no debería usarse — su claim must_change_password=1
            // es viejo. El cliente debe re-loguearse para obtener uno nuevo.
            res.json({
                success: true,
                message: 'Contraseña actualizada. Vuelva a iniciar sesión con la nueva contraseña.',
                data: { relogin_required: true }
            });
        } catch (error) {
            console.error('Error en change-my-password:', error);
            res.status(500).json({ success: false, message: 'Error al cambiar contraseña' });
        }
    }

    // Logout (registrar en logs)
    static async logout(req, res) {
        try {
            await db.execute(`
                INSERT INTO access_logs (user_id, action, ip_address)
                VALUES (?, ?, ?)
            `, [req.user.id, 'logout', req.ip || 'unknown']);

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
