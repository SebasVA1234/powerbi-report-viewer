const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const db = require('../config/db');

// Genera una contraseña temporal de 12 chars sin caracteres ambiguos
// (sin 0/O, 1/l/I). Suficiente entropía para single-use; el usuario
// está obligado a cambiarla en el primer login (must_change_password).
function generateTempPassword() {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
    const buf = crypto.randomBytes(12);
    let out = '';
    for (let i = 0; i < 12; i++) {
        out += alphabet[buf[i] % alphabet.length];
    }
    return out;
}

class UserController {
    // Obtener todos los usuarios (solo admin)
    static async getAllUsers(req, res) {
        try {
            const { page = 1, limit = 10, search = '' } = req.query;
            const offset = (page - 1) * limit;

            // plain_password fue eliminada en PR-0b: el admin ya no puede
            // leer la pass de otros users. Para resetearla usa updateUser
            // con password (nueva) o sin password (genera una temporal y
            // la devuelve UNA sola vez).
            let baseQuery = `
                SELECT id, username, email, full_name, role, is_active,
                       must_change_password, created_at, updated_at
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
    //
    // Si se pasa `password` en el body, se usa esa (validada).
    // Si no, el sistema genera una contraseña temporal aleatoria.
    // En cualquiera de los dos casos:
    //   - el user queda con must_change_password=1
    //   - la respuesta incluye temp_password con el valor en claro UNA SOLA VEZ
    //     para que el admin pueda comunicárselo al usuario. No queda guardada.
    static async createUser(req, res) {
        try {
            const { username, email, password, full_name, role = 'user' } = req.body;

            if (!username || !email || !full_name) {
                return res.status(400).json({ success: false, message: 'Usuario, email y nombre son requeridos' });
            }
            if (password !== undefined && password.length < 6) {
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

            const tempPassword = password || generateTempPassword();
            const hashedPassword = bcrypt.hashSync(tempPassword, 10);
            const result = await db.execute(
                `INSERT INTO users (username, email, password, full_name, role, must_change_password)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [username, email, hashedPassword, full_name, role, 1]
            );

            await db.execute(
                'INSERT INTO access_logs (user_id, action, ip_address) VALUES (?, ?, ?)',
                [req.user.id, `created_user:${result.lastInsertId}`, req.ip || 'unknown']
            );

            res.status(201).json({
                success: true,
                message: 'Usuario creado exitosamente. La contraseña temporal solo se muestra una vez.',
                data: {
                    id: result.lastInsertId,
                    username, email, full_name, role,
                    temp_password: tempPassword,
                    must_change_password: true
                }
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
            let tempPasswordIssued = null;

            if (username !== undefined) { updates.push('username = ?'); values.push(username); }
            if (email !== undefined)    { updates.push('email = ?');    values.push(email); }
            if (full_name !== undefined){ updates.push('full_name = ?');values.push(full_name); }
            if (role !== undefined)     { updates.push('role = ?');     values.push(role); }
            if (is_active !== undefined){ updates.push('is_active = ?'); values.push(is_active ? 1 : 0); }

            // Reset de pass por admin:
            //   - Si admin manda password explícito >=6 chars, se usa ese.
            //   - Si admin manda password = "" (string vacio), generamos una pass temporal.
            //   - En ambos casos, must_change_password=1 y la temp_password
            //     vuelve UNA SOLA VEZ en la respuesta.
            const wantsResetPassword = password !== undefined;
            if (wantsResetPassword) {
                let newPass;
                if (typeof password === 'string' && password.length >= 6) {
                    newPass = password;
                } else if (password === '' || password === null) {
                    newPass = generateTempPassword();
                } else {
                    return res.status(400).json({
                        success: false,
                        message: 'La contraseña debe tener al menos 6 caracteres (o vacía para generar una temporal)'
                    });
                }
                updates.push('password = ?');
                values.push(bcrypt.hashSync(newPass, 10));
                updates.push('must_change_password = ?');
                values.push(1);
                tempPasswordIssued = newPass;
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

            const responseBody = { success: true, message: 'Usuario actualizado exitosamente' };
            if (tempPasswordIssued) {
                responseBody.message = 'Usuario actualizado. La contraseña temporal solo se muestra una vez.';
                responseBody.data = {
                    temp_password: tempPasswordIssued,
                    must_change_password: true
                };
            }
            res.json(responseBody);
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
