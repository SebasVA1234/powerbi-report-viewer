const bcrypt = require('bcryptjs');
const db = require('../config/db');

class UserController {
    // Obtener todos los usuarios (solo admin)
    static async getAllUsers(req, res) {
        try {
            const { page = 1, limit = 10, search = '' } = req.query;
            const offset = (page - 1) * limit;

            let baseQuery = `
                SELECT id, username, email, full_name, role, is_active, plain_password, created_at, updated_at
                FROM users
            `;
            let where = '';
            const params = [];
            if (search) {
                where = ' WHERE username LIKE ? OR email LIKE ? OR full_name LIKE ?';
                const p = `%${search}%`;
                params.push(p, p, p);
            }

            // Total para paginación
            const totalRow = await db.queryOne(
                `SELECT COUNT(*) as total FROM users${where}`,
                params
            );
            const total = Number(totalRow.total);

            // Página actual
            const listSql = baseQuery + where + ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
            const users = await db.query(
                listSql,
                [...params, parseInt(limit), parseInt(offset)]
            );

            // Permisos por usuario (una query por usuario, mismo patrón que el legacy)
            for (const user of users) {
                user.permissions = await db.query(
                    `SELECT report_id, can_view, can_export
                     FROM user_report_permissions
                     WHERE user_id = ?`,
                    [user.id]
                );
                if (user.role === 'admin') {
                    user.plain_password = '🔒 Protegido';
                }
            }

            res.json({
                success: true,
                data: {
                    users,
                    pagination: {
                        page: parseInt(page),
                        limit: parseInt(limit),
                        total,
                        totalPages: Math.ceil(total / limit)
                    }
                }
            });
        } catch (error) {
            console.error('Error al obtener usuarios:', error);
            res.status(500).json({ success: false, message: 'Error al obtener usuarios' });
        }
    }

    // Obtener un usuario por ID
    static async getUserById(req, res) {
        try {
            const { id } = req.params;

            const user = await db.queryOne(
                `SELECT id, username, email, full_name, role, is_active, created_at, updated_at
                 FROM users WHERE id = ?`,
                [id]
            );
            if (!user) {
                return res.status(404).json({ success: false, message: 'Usuario no encontrado' });
            }

            user.permissions = await db.query(
                `SELECT p.report_id, r.name as report_name, p.can_view, p.can_export, p.granted_at
                 FROM user_report_permissions p
                 JOIN reports r ON p.report_id = r.id
                 WHERE p.user_id = ?`,
                [id]
            );

            res.json({ success: true, data: { user } });
        } catch (error) {
            console.error('Error al obtener usuario:', error);
            res.status(500).json({ success: false, message: 'Error al obtener usuario' });
        }
    }

    // Crear nuevo usuario
    static async createUser(req, res) {
        try {
            const { username, email, password, full_name, role = 'user' } = req.body;

            if (!username || !email || !password || !full_name) {
                return res.status(400).json({ success: false, message: 'Todos los campos son requeridos' });
            }
            if (password.length < 6) {
                return res.status(400).json({
                    success: false,
                    message: 'La contraseña debe tener al menos 6 caracteres'
                });
            }

            const existingUser = await db.queryOne(
                'SELECT id FROM users WHERE username = ? OR email = ?',
                [username, email]
            );
            if (existingUser) {
                return res.status(409).json({ success: false, message: 'El usuario o email ya existe' });
            }

            const hashedPassword = bcrypt.hashSync(password, 10);
            const result = await db.execute(
                `INSERT INTO users (username, email, password, plain_password, full_name, role)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [username, email, hashedPassword, password, full_name, role]
            );

            await db.execute(
                'INSERT INTO access_logs (user_id, action, ip_address) VALUES (?, ?, ?)',
                [req.user.id, `created_user:${result.lastInsertId}`, req.ip || 'unknown']
            );

            res.status(201).json({
                success: true,
                message: 'Usuario creado exitosamente',
                data: { id: result.lastInsertId, username, email, full_name, role }
            });
        } catch (error) {
            console.error('Error al crear usuario:', error);
            res.status(500).json({ success: false, message: 'Error al crear usuario' });
        }
    }

    // Actualizar usuario
    static async updateUser(req, res) {
        try {
            const { id } = req.params;
            const { username, email, full_name, role, is_active, password } = req.body;

            if (parseInt(id) === 1 && req.user.id !== 1) {
                return res.status(403).json({
                    success: false,
                    message: 'No tiene permiso para modificar el usuario administrador'
                });
            }

            const user = await db.queryOne('SELECT id FROM users WHERE id = ?', [id]);
            if (!user) {
                return res.status(404).json({ success: false, message: 'Usuario no encontrado' });
            }

            const updates = [];
            const values = [];

            if (username !== undefined) { updates.push('username = ?'); values.push(username); }
            if (email !== undefined)    { updates.push('email = ?');    values.push(email); }
            if (full_name !== undefined){ updates.push('full_name = ?');values.push(full_name); }
            if (role !== undefined)     { updates.push('role = ?');     values.push(role); }
            if (is_active !== undefined){ updates.push('is_active = ?'); values.push(is_active ? 1 : 0); }
            if (password !== undefined && password.length >= 6) {
                updates.push('password = ?');        values.push(bcrypt.hashSync(password, 10));
                updates.push('plain_password = ?');  values.push(password);
            }

            if (updates.length === 0) {
                return res.status(400).json({ success: false, message: 'No hay campos para actualizar' });
            }

            values.push(id);
            await db.execute(
                `UPDATE users SET ${updates.join(', ')} WHERE id = ?`,
                values
            );

            await db.execute(
                'INSERT INTO access_logs (user_id, action, ip_address) VALUES (?, ?, ?)',
                [req.user.id, `updated_user:${id}`, req.ip || 'unknown']
            );

            res.json({ success: true, message: 'Usuario actualizado exitosamente' });
        } catch (error) {
            console.error('Error al actualizar usuario:', error);
            res.status(500).json({ success: false, message: 'Error al actualizar usuario' });
        }
    }

    // Eliminar usuario
    static async deleteUser(req, res) {
        try {
            const { id } = req.params;

            if (parseInt(id) === req.user.id) {
                return res.status(400).json({ success: false, message: 'No puede eliminar su propio usuario' });
            }
            if (parseInt(id) === 1) {
                return res.status(403).json({
                    success: false,
                    message: 'No puede eliminar al administrador principal'
                });
            }

            const user = await db.queryOne('SELECT username FROM users WHERE id = ?', [id]);
            if (!user) {
                return res.status(404).json({ success: false, message: 'Usuario no encontrado' });
            }

            await db.execute('DELETE FROM users WHERE id = ?', [id]);

            await db.execute(
                'INSERT INTO access_logs (user_id, action, ip_address) VALUES (?, ?, ?)',
                [req.user.id, `deleted_user:${user.username}`, req.ip || 'unknown']
            );

            res.json({ success: true, message: 'Usuario eliminado exitosamente' });
        } catch (error) {
            console.error('Error al eliminar usuario:', error);
            res.status(500).json({ success: false, message: 'Error al eliminar usuario' });
        }
    }

    // Obtener perfil del usuario actual
    static async getProfile(req, res) {
        try {
            const user = await db.queryOne(
                `SELECT id, username, email, full_name, role, created_at
                 FROM users WHERE id = ?`,
                [req.user.id]
            );

            if (!user) {
                return res.status(404).json({ success: false, message: 'Usuario no encontrado' });
            }

            res.json({ success: true, data: { user } });
        } catch (error) {
            console.error('Error al obtener perfil:', error);
            res.status(500).json({ success: false, message: 'Error al obtener perfil' });
        }
    }

    // Actualizar perfil del usuario actual
    // NOTA: Los usuarios normales SOLO pueden cambiar su nombre visible (full_name)
    static async updateProfile(req, res) {
        try {
            const { full_name } = req.body;
            const userId = req.user.id;

            if (!full_name || full_name.trim().length === 0) {
                return res.status(400).json({ success: false, message: 'El nombre es requerido' });
            }

            await db.execute(
                'UPDATE users SET full_name = ? WHERE id = ?',
                [full_name.trim(), userId]
            );

            res.json({ success: true, message: 'Perfil actualizado exitosamente' });
        } catch (error) {
            console.error('Error al actualizar perfil:', error);
            res.status(500).json({ success: false, message: 'Error al actualizar perfil' });
        }
    }
}

module.exports = UserController;
