const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { authenticator } = require('otplib');
const QRCode = require('qrcode');
const db = require('../config/db');

// PR-0b.1: configuración global de TOTP. window=1 tolera ±30s de
// desfase de reloj entre el servidor y la app del user, que es lo que
// recomienda RFC 6238 sin sacrificar mucha seguridad.
authenticator.options = { window: 1 };

const TOTP_ISSUER = process.env.TOTP_ISSUER || 'Helper Ecualand';

// Genera el JWT real (post-login completo). Reutilizado por login() y
// por verifyTotp() así no duplicamos los claims.
function signSessionToken(user) {
    return jwt.sign(
        {
            id: user.id,
            username: user.username,
            email: user.email,
            role: user.role,
            full_name: user.full_name,
            must_change_password: !!Number(user.must_change_password)
        },
        process.env.JWT_SECRET,
        { expiresIn: process.env.JWT_EXPIRY || '24h' }
    );
}

// JWT temporal de 5 min entre login (pass OK) y verifyTotp (código OK).
// El claim totp_pending=true bloquea cualquier ruta que no sea
// /auth/totp/verify ni /auth/logout (ver auth.middleware.js).
function signTotpPendingToken(userId) {
    return jwt.sign(
        { id: userId, totp_pending: true },
        process.env.JWT_SECRET,
        { expiresIn: '5m' }
    );
}

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
                       must_change_password, totp_enabled
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

            // PR-0b.1: si el user tiene 2FA habilitado, NO entregamos el
            // JWT real todavía. Devolvemos un token temporal de 5 min con
            // claim totp_pending=true y le pedimos al cliente que llame a
            // /auth/totp/verify con el código del autenticador. Solo
            // entonces se entrega el JWT completo.
            if (Number(user.totp_enabled)) {
                await db.execute(`
                    INSERT INTO access_logs (user_id, action, ip_address, user_agent)
                    VALUES (?, ?, ?, ?)
                `, [user.id, 'login_totp_pending', req.ip || 'unknown', req.headers['user-agent'] || 'unknown']);
                return res.json({
                    success: true,
                    message: 'Código TOTP requerido',
                    data: {
                        needs_totp: true,
                        totp_token: signTotpPendingToken(user.id)
                    }
                });
            }

            const mustChangePassword = !!Number(user.must_change_password);
            const token = signSessionToken(user);

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

    // PR-0b.1: 2do paso del login cuando el user tiene 2FA habilitado.
    // Recibe el totp_token (con claim totp_pending) + code (6 dígitos).
    // Si el código es válido contra users.totp_secret, devuelve el JWT real.
    static async verifyTotp(req, res) {
        try {
            const { code } = req.body;
            if (!code || typeof code !== 'string' || !/^\d{6}$/.test(code)) {
                return res.status(400).json({
                    success: false,
                    message: 'Código TOTP inválido (deben ser 6 dígitos)'
                });
            }
            // El middleware ya validó el JWT y puso req.user con totp_pending=true.
            const dbUser = await db.queryOne(`
                SELECT id, username, email, password, full_name, role, is_active,
                       must_change_password, totp_secret, totp_enabled
                FROM users WHERE id = ? AND is_active = 1
            `, [req.user.id]);
            if (!dbUser || !dbUser.totp_secret || !Number(dbUser.totp_enabled)) {
                return res.status(400).json({
                    success: false,
                    message: '2FA no está activo para este usuario'
                });
            }

            const ok = authenticator.check(code, dbUser.totp_secret);
            if (!ok) {
                await db.execute(
                    'INSERT INTO access_logs (user_id, action, ip_address) VALUES (?, ?, ?)',
                    [dbUser.id, 'login_totp_invalid', req.ip || 'unknown']
                );
                return res.status(401).json({ success: false, message: 'Código TOTP incorrecto' });
            }

            const token = signSessionToken(dbUser);
            await db.execute(`
                INSERT INTO access_logs (user_id, action, ip_address, user_agent)
                VALUES (?, ?, ?, ?)
            `, [dbUser.id, 'login_totp_ok', req.ip || 'unknown', req.headers['user-agent'] || 'unknown']);

            delete dbUser.password;
            delete dbUser.totp_secret;
            dbUser.must_change_password = !!Number(dbUser.must_change_password);

            res.json({
                success: true,
                message: 'Login exitoso',
                data: { user: dbUser, token }
            });
        } catch (error) {
            console.error('Error en totp/verify:', error);
            res.status(500).json({ success: false, message: 'Error al verificar código' });
        }
    }

    // PR-0b.1: paso 1 del setup 2FA. Genera un secret y lo persiste en DB
    // pero todavía NO activa 2FA (totp_enabled queda en 0). El user debe
    // confirmar el setup llamando a /totp/enable con un código del
    // autenticador. Esto evita que un user quede afuera por sincronizar
    // mal el secret.
    // Devuelve la otpauth URL y un QR como data URL (PNG en base64).
    static async setupTotp(req, res) {
        try {
            const dbUser = await db.queryOne(
                'SELECT id, username, email, totp_enabled FROM users WHERE id = ?',
                [req.user.id]
            );
            if (!dbUser) {
                return res.status(404).json({ success: false, message: 'Usuario no encontrado' });
            }
            if (Number(dbUser.totp_enabled)) {
                return res.status(409).json({
                    success: false,
                    message: '2FA ya está activo. Desactívelo primero para reconfigurarlo.'
                });
            }

            const secret = authenticator.generateSecret();
            const otpauthUrl = authenticator.keyuri(dbUser.email || dbUser.username, TOTP_ISSUER, secret);
            const qrDataUrl = await QRCode.toDataURL(otpauthUrl);

            await db.execute(
                'UPDATE users SET totp_secret = ?, totp_enabled = 0 WHERE id = ?',
                [secret, dbUser.id]
            );

            res.json({
                success: true,
                message: 'Escanea el QR con tu app autenticadora y confirma con un código',
                data: { secret, otpauthUrl, qrDataUrl }
            });
        } catch (error) {
            console.error('Error en totp/setup:', error);
            res.status(500).json({ success: false, message: 'Error al configurar 2FA' });
        }
    }

    // PR-0b.1: paso 2 del setup 2FA. Recibe un código TOTP. Si coincide
    // con el secret guardado, activa 2FA (totp_enabled=1).
    static async enableTotp(req, res) {
        try {
            const { code } = req.body;
            if (!code || !/^\d{6}$/.test(code)) {
                return res.status(400).json({ success: false, message: 'Código de 6 dígitos requerido' });
            }
            const dbUser = await db.queryOne(
                'SELECT id, totp_secret, totp_enabled FROM users WHERE id = ?',
                [req.user.id]
            );
            if (!dbUser || !dbUser.totp_secret) {
                return res.status(400).json({
                    success: false,
                    message: 'Primero llamá a /totp/setup para generar un secret'
                });
            }
            if (!authenticator.check(code, dbUser.totp_secret)) {
                return res.status(401).json({ success: false, message: 'Código TOTP incorrecto' });
            }

            await db.execute('UPDATE users SET totp_enabled = 1 WHERE id = ?', [dbUser.id]);
            await db.execute(
                'INSERT INTO access_logs (user_id, action, ip_address) VALUES (?, ?, ?)',
                [dbUser.id, 'totp_enabled', req.ip || 'unknown']
            );

            res.json({ success: true, message: '2FA activado correctamente' });
        } catch (error) {
            console.error('Error en totp/enable:', error);
            res.status(500).json({ success: false, message: 'Error al activar 2FA' });
        }
    }

    // PR-0b.1: desactivar 2FA. Requiere password actual del user
    // (defensa: si te roban la sesión, el atacante no puede apagarte
    // el 2FA sin tu password también).
    static async disableTotp(req, res) {
        try {
            const { password } = req.body;
            if (!password) {
                return res.status(400).json({ success: false, message: 'Contraseña requerida' });
            }
            const dbUser = await db.queryOne(
                'SELECT id, password, totp_enabled FROM users WHERE id = ?',
                [req.user.id]
            );
            if (!dbUser) {
                return res.status(404).json({ success: false, message: 'Usuario no encontrado' });
            }
            if (!Number(dbUser.totp_enabled)) {
                return res.status(400).json({ success: false, message: '2FA no está activo' });
            }
            if (!bcrypt.compareSync(password, dbUser.password)) {
                return res.status(401).json({ success: false, message: 'Contraseña incorrecta' });
            }

            await db.execute(
                'UPDATE users SET totp_secret = NULL, totp_enabled = 0 WHERE id = ?',
                [dbUser.id]
            );
            await db.execute(
                'INSERT INTO access_logs (user_id, action, ip_address) VALUES (?, ?, ?)',
                [dbUser.id, 'totp_disabled', req.ip || 'unknown']
            );

            res.json({ success: true, message: '2FA desactivado' });
        } catch (error) {
            console.error('Error en totp/disable:', error);
            res.status(500).json({ success: false, message: 'Error al desactivar 2FA' });
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
