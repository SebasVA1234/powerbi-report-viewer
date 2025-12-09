const bcrypt = require('bcryptjs');
const db = require('../config/database');

class UserController {
    // Obtener todos los usuarios (solo admin)
    static getAllUsers(req, res) {
        try {
            const { page = 1, limit = 10, search = '' } = req.query;
            const offset = (page - 1) * limit;

            // Construir consulta con búsqueda
            let query = `
                SELECT id, username, email, full_name, role, is_active, plain_password, created_at, updated_at
                FROM users
            `;
            
            const params = [];
            if (search) {
                query += ` WHERE username LIKE ? OR email LIKE ? OR full_name LIKE ?`;
                const searchPattern = `%${search}%`;
                params.push(searchPattern, searchPattern, searchPattern);
            }

            // Obtener total de registros
            const countQuery = query.replace('SELECT id, username, email, full_name, role, is_active, plain_password, created_at, updated_at', 'SELECT COUNT(*) as total');
            const totalResult = db.prepare(countQuery).get(...params);
            const total = totalResult.total;

            // Añadir paginación
            query += ` ORDER BY created_at DESC LIMIT ? OFFSET ?`;
            params.push(parseInt(limit), parseInt(offset));

            const users = db.prepare(query).all(...params);

            // Obtener permisos de cada usuario
            const permissionsQuery = db.prepare(`
                SELECT report_id, can_view, can_export
                FROM user_report_permissions
                WHERE user_id = ?
            `);

            users.forEach(user => {
                user.permissions = permissionsQuery.all(user.id);
                
                // Proteger contraseñas de admins
                // - Usuarios con rol 'admin' → "🔒 Protegido"
                // - Usuarios con rol 'user' → mostrar contraseña real
                if (user.role === 'admin') {
                    user.plain_password = '🔒 Protegido';
                }
            });

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
            res.status(500).json({
                success: false,
                message: 'Error al obtener usuarios'
            });
        }
    }

    // Obtener un usuario por ID
    static getUserById(req, res) {
        try {
            const { id } = req.params;

            const user = db.prepare(`
                SELECT id, username, email, full_name, role, is_active, created_at, updated_at
                FROM users
                WHERE id = ?
            `).get(id);

            if (!user) {
                return res.status(404).json({
                    success: false,
                    message: 'Usuario no encontrado'
                });
            }

            // Obtener permisos del usuario
            user.permissions = db.prepare(`
                SELECT 
                    p.report_id,
                    r.name as report_name,
                    p.can_view,
                    p.can_export,
                    p.granted_at
                FROM user_report_permissions p
                JOIN reports r ON p.report_id = r.id
                WHERE p.user_id = ?
            `).all(id);

            res.json({
                success: true,
                data: { user }
            });
        } catch (error) {
            console.error('Error al obtener usuario:', error);
            res.status(500).json({
                success: false,
                message: 'Error al obtener usuario'
            });
        }
    }

    // Crear nuevo usuario
    static createUser(req, res) {
        try {
            const { username, email, password, full_name, role = 'user' } = req.body;

            // Validaciones
            if (!username || !email || !password || !full_name) {
                return res.status(400).json({
                    success: false,
                    message: 'Todos los campos son requeridos'
                });
            }

            if (password.length < 6) {
                return res.status(400).json({
                    success: false,
                    message: 'La contraseña debe tener al menos 6 caracteres'
                });
            }

            // Verificar si el usuario ya existe
            const existingUser = db.prepare(`
                SELECT id FROM users WHERE username = ? OR email = ?
            `).get(username, email);

            if (existingUser) {
                return res.status(409).json({
                    success: false,
                    message: 'El usuario o email ya existe'
                });
            }

            // Hashear contraseña
            const hashedPassword = bcrypt.hashSync(password, 10);

            // Insertar nuevo usuario
            const result = db.prepare(`
                INSERT INTO users (username, email, password, plain_password,full_name, role)
                VALUES (?, ?, ?, ?, ?, ?)
            `).run(username, email, hashedPassword, password,full_name, role);

            // Registrar acción
            db.prepare(`
                INSERT INTO access_logs (user_id, action, ip_address)
                VALUES (?, ?, ?)
            `).run(req.user.id, `created_user:${result.lastInsertRowid}`, req.ip || 'unknown');

            res.status(201).json({
                success: true,
                message: 'Usuario creado exitosamente',
                data: {
                    id: result.lastInsertRowid,
                    username,
                    email,
                    full_name,
                    role
                }
            });
        } catch (error) {
            console.error('Error al crear usuario:', error);
            res.status(500).json({
                success: false,
                message: 'Error al crear usuario'
            });
        }
    }

    // Actualizar usuario
    static updateUser(req, res) {
        try {
            const { id } = req.params;
            const { username, email, full_name, role, is_active, password } = req.body;

            //Proteger al usuario admin (id=1) de ser desactivado o cambiar su rol solo admin 1 puede modificarlo
            if(parseInt(id) === 1 && req.user.id !== 1) {
                return res.status(403).json({
                    success: false,
                    message: 'No tiene permiso para modificar el usuario administrador'
                });
            }

            // Verificar si el usuario existe
            const user = db.prepare('SELECT id FROM users WHERE id = ?').get(id);
            if (!user) {
                return res.status(404).json({
                    success: false,
                    message: 'Usuario no encontrado'
                });
            }

            // Construir consulta de actualización dinámica
            const updates = [];
            const values = [];

            if (username !== undefined) {
                updates.push('username = ?');
                values.push(username);
            }
            if (email !== undefined) {
                updates.push('email = ?');
                values.push(email);
            }
            if (full_name !== undefined) {
                updates.push('full_name = ?');
                values.push(full_name);
            }
            if (role !== undefined) {
                updates.push('role = ?');
                values.push(role);
            }
            if (is_active !== undefined) {
                updates.push('is_active = ?');
                values.push(is_active ? 1 : 0);
            }
            if (password !== undefined && password.length >= 6) {
                updates.push('password = ?');
                values.push(bcrypt.hashSync(password, 10));
                //También actualizar plain_password
                updates.push('plain_password = ?');
                values.push(password);
            }

            if (updates.length === 0) {
                return res.status(400).json({
                    success: false,
                    message: 'No hay campos para actualizar'
                });
            }

            values.push(id);
            const query = `UPDATE users SET ${updates.join(', ')} WHERE id = ?`;
            db.prepare(query).run(...values);

            // Registrar acción
            db.prepare(`
                INSERT INTO access_logs (user_id, action, ip_address)
                VALUES (?, ?, ?)
            `).run(req.user.id, `updated_user:${id}`, req.ip || 'unknown');

            res.json({
                success: true,
                message: 'Usuario actualizado exitosamente'
            });
        } catch (error) {
            console.error('Error al actualizar usuario:', error);
            res.status(500).json({
                success: false,
                message: 'Error al actualizar usuario'
            });
        }
    }

    // Eliminar usuario
    static deleteUser(req, res) {
        try {
            const { id } = req.params;

            // No permitir eliminar el propio usuario
            if (parseInt(id) === req.user.id) {
                return res.status(400).json({
                    success: false,
                    message: 'No puede eliminar su propio usuario'
                });
            }

            // Proteger al administrador principal (ID = 1)
            if (parseInt(id) === 1) {
                return res.status(403).json({
                    success: false,
                    message: 'No puede eliminar al administrador principal'
                });
            }

            // Verificar si el usuario existe
            const user = db.prepare('SELECT username FROM users WHERE id = ?').get(id);
            if (!user) {
                return res.status(404).json({
                    success: false,
                    message: 'Usuario no encontrado'
                });
            }

            // Eliminar usuario (los permisos se eliminarán en cascada)
            db.prepare('DELETE FROM users WHERE id = ?').run(id);

            // Registrar acción
            db.prepare(`
                INSERT INTO access_logs (user_id, action, ip_address)
                VALUES (?, ?, ?)
            `).run(req.user.id, `deleted_user:${user.username}`, req.ip || 'unknown');

            res.json({
                success: true,
                message: 'Usuario eliminado exitosamente'
            });
        } catch (error) {
            console.error('Error al eliminar usuario:', error);
            res.status(500).json({
                success: false,
                message: 'Error al eliminar usuario'
            });
        }
    }

    // Obtener perfil del usuario actual
    static getProfile(req, res) {
        try {
            const user = db.prepare(`
                SELECT id, username, email, full_name, role, created_at
                FROM users
                WHERE id = ?
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
            console.error('Error al obtener perfil:', error);
            res.status(500).json({
                success: false,
                message: 'Error al obtener perfil'
            });
        }
    }

    // Actualizar perfil del usuario actual
    // NOTA: Los usuarios normales SOLO pueden cambiar su nombre visible (full_name)
    // El username, email y contraseña solo pueden ser cambiados por un administrador
    static updateProfile(req, res) {
        try {
            const { full_name } = req.body;
            const userId = req.user.id;

            if (!full_name || full_name.trim().length === 0) {
                return res.status(400).json({
                    success: false,
                    message: 'El nombre es requerido'
                });
            }

            // Actualizar solo el nombre visible
            db.prepare(`UPDATE users SET full_name = ? WHERE id = ?`).run(full_name.trim(), userId);

            res.json({
                success: true,
                message: 'Perfil actualizado exitosamente'
            });
        } catch (error) {
            console.error('Error al actualizar perfil:', error);
            res.status(500).json({
                success: false,
                message: 'Error al actualizar perfil'
            });
        }
    }
}

module.exports = UserController;
