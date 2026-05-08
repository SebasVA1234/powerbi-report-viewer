/**
 * RBAC Controller (PR-1a, foundation)
 *
 * Expone endpoints para gestionar roles, permisos, departamentos y la
 * asignación user ↔ rol y user ↔ departamento. NO toca el sistema viejo
 * (user_report_permissions / user_document_permissions): sigue funcionando
 * en paralelo. La integración del nuevo modelo con auth de reportes/docs
 * llega en PR-1b.
 *
 * Diseño:
 *   - Helper getUserContext(userId) calcula roles + departments + el set
 *     completo de permission codes del user. Usable como middleware o
 *     desde otros controllers en futuras PRs.
 *   - Las acciones de escritura requieren permiso 'system.admin' o el
 *     role admin_sistema. La excepción: `users/:id/departments` también
 *     puede setearlo el user con permiso 'departments.manage' (RRHH).
 *   - Defensa en profundidad: el endpoint chequea el JWT (authMiddleware
 *     antes en el router) y el rol admin O el permiso explícito (acá).
 */
const db = require('../config/db');

// Devuelve { roles: [...], departments: [...], permissions: Set<code>, isAdmin: bool }
// para un user dado. Caching simple por request: si req se pasa, se cachea
// en req._userContext_<userId>.
async function getUserContext(userId, req = null) {
    if (req && req[`_userContext_${userId}`]) return req[`_userContext_${userId}`];

    const roles = await db.query(`
        SELECT r.id, r.code, r.name, r.level, r.is_system
        FROM roles r
        INNER JOIN user_roles ur ON ur.role_id = r.id
        WHERE ur.user_id = ?
        ORDER BY r.level DESC
    `, [userId]);

    const departments = await db.query(`
        SELECT d.id, d.code, d.name, ud.is_head
        FROM departments d
        INNER JOIN user_departments ud ON ud.department_id = d.id
        WHERE ud.user_id = ? AND d.is_active = 1
        ORDER BY d.name
    `, [userId]);

    const permRows = await db.query(`
        SELECT DISTINCT p.code
        FROM permissions p
        INNER JOIN role_permissions rp ON rp.permission_id = p.id
        INNER JOIN user_roles ur ON ur.role_id = rp.role_id
        WHERE ur.user_id = ?
    `, [userId]);
    const permissions = new Set(permRows.map(r => r.code));

    // Hotfix: respetar el rol legacy users.role='admin'. Antes de PR-1a,
    // ese era el único mecanismo de admin del sistema. Users con
    // users.role='admin' que no tienen el rol RBAC admin_sistema
    // asignado deben seguir teniendo acceso completo (mismo comportamiento
    // que tenían antes del merge), hasta que el admin del nuevo modelo
    // les asigne explícitamente un rol RBAC.
    const userRow = await db.queryOne(
        'SELECT role FROM users WHERE id = ?',
        [userId]
    );
    const isLegacyAdmin = !!(userRow && userRow.role === 'admin');

    const ctx = {
        roles,
        departments,
        permissions,
        isAdmin: permissions.has('system.admin')
              || roles.some(r => r.code === 'admin_sistema')
              || isLegacyAdmin
    };
    if (req) req[`_userContext_${userId}`] = ctx;
    return ctx;
}

// Middleware factory: exige que req.user (puesto por authMiddleware) tenga
// el permiso indicado. Si no, 403 code:'PERMISSION_DENIED'.
function requirePermission(permCode) {
    return async (req, res, next) => {
        try {
            const ctx = await getUserContext(req.user.id, req);
            if (!ctx.permissions.has(permCode) && !ctx.isAdmin) {
                return res.status(403).json({
                    success: false,
                    code: 'PERMISSION_DENIED',
                    message: `Falta permiso: ${permCode}`
                });
            }
            next();
        } catch (err) {
            console.error('Error en requirePermission:', err);
            res.status(500).json({ success: false, message: 'Error de autorización' });
        }
    };
}

class RbacController {
    // -------- Roles --------
    static async listRoles(req, res) {
        try {
            const roles = await db.query(`
                SELECT id, code, name, description, level, is_system, created_at
                FROM roles ORDER BY level DESC, name
            `);
            res.json({ success: true, data: { roles } });
        } catch (err) {
            console.error('listRoles:', err);
            res.status(500).json({ success: false, message: 'Error al listar roles' });
        }
    }

    // -------- Permisos --------
    static async listPermissions(req, res) {
        try {
            const permissions = await db.query(`
                SELECT id, code, resource_type, action, description
                FROM permissions ORDER BY code
            `);
            res.json({ success: true, data: { permissions } });
        } catch (err) {
            console.error('listPermissions:', err);
            res.status(500).json({ success: false, message: 'Error al listar permisos' });
        }
    }

    // -------- Departamentos --------
    static async listDepartments(req, res) {
        try {
            const { include_archived } = req.query;
            const where = include_archived === '1' ? '' : 'WHERE is_active = 1';
            const departments = await db.query(`
                SELECT d.id, d.code, d.name, d.description, d.parent_id,
                       d.is_active, d.created_at, d.updated_at,
                       (SELECT COUNT(*) FROM user_departments ud WHERE ud.department_id = d.id) AS member_count
                FROM departments d
                ${where}
                ORDER BY d.name
            `);
            res.json({ success: true, data: { departments } });
        } catch (err) {
            console.error('listDepartments:', err);
            res.status(500).json({ success: false, message: 'Error al listar departamentos' });
        }
    }

    static async createDepartment(req, res) {
        try {
            const { code, name, description, parent_id } = req.body;
            if (!code || !name) {
                return res.status(400).json({ success: false, message: 'code y name son requeridos' });
            }
            if (!/^[a-z][a-z0-9_]{1,31}$/.test(code)) {
                return res.status(400).json({
                    success: false,
                    message: 'code debe ser snake_case (a-z, 0-9, _) y empezar con letra'
                });
            }
            const exists = await db.queryOne('SELECT id FROM departments WHERE code = ?', [code]);
            if (exists) {
                return res.status(409).json({ success: false, message: 'Ya existe un departamento con ese code' });
            }
            const r = await db.execute(
                'INSERT INTO departments (code, name, description, parent_id) VALUES (?, ?, ?, ?)',
                [code, name, description || null, parent_id || null]
            );
            res.status(201).json({ success: true, data: { id: r.lastInsertId, code, name } });
        } catch (err) {
            console.error('createDepartment:', err);
            res.status(500).json({ success: false, message: 'Error al crear departamento' });
        }
    }

    static async updateDepartment(req, res) {
        try {
            const { id } = req.params;
            const { name, description, parent_id, is_active } = req.body;
            const dept = await db.queryOne('SELECT id FROM departments WHERE id = ?', [id]);
            if (!dept) {
                return res.status(404).json({ success: false, message: 'Departamento no encontrado' });
            }
            const updates = [];
            const values = [];
            if (name !== undefined)        { updates.push('name = ?');        values.push(name); }
            if (description !== undefined) { updates.push('description = ?'); values.push(description); }
            if (parent_id !== undefined)   { updates.push('parent_id = ?');   values.push(parent_id || null); }
            if (is_active !== undefined)   { updates.push('is_active = ?');   values.push(is_active ? 1 : 0); }
            if (updates.length === 0) {
                return res.status(400).json({ success: false, message: 'No hay campos para actualizar' });
            }
            updates.push('updated_at = CURRENT_TIMESTAMP');
            values.push(id);
            await db.execute(`UPDATE departments SET ${updates.join(', ')} WHERE id = ?`, values);
            res.json({ success: true, message: 'Departamento actualizado' });
        } catch (err) {
            console.error('updateDepartment:', err);
            res.status(500).json({ success: false, message: 'Error al actualizar departamento' });
        }
    }

    static async archiveDepartment(req, res) {
        try {
            const { id } = req.params;
            const dept = await db.queryOne('SELECT id, code FROM departments WHERE id = ?', [id]);
            if (!dept) {
                return res.status(404).json({ success: false, message: 'Departamento no encontrado' });
            }
            await db.execute(
                'UPDATE departments SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
                [id]
            );
            res.json({ success: true, message: 'Departamento archivado' });
        } catch (err) {
            console.error('archiveDepartment:', err);
            res.status(500).json({ success: false, message: 'Error al archivar departamento' });
        }
    }

    // -------- Asignaciones user ↔ rol --------
    static async assignRoleToUser(req, res) {
        try {
            const { userId, roleCode } = req.params;
            const user = await db.queryOne('SELECT id FROM users WHERE id = ?', [userId]);
            if (!user) return res.status(404).json({ success: false, message: 'Usuario no encontrado' });
            const role = await db.queryOne('SELECT id FROM roles WHERE code = ?', [roleCode]);
            if (!role) return res.status(404).json({ success: false, message: 'Rol no encontrado' });

            const onConflict = db.driver === 'sqlite'
                ? 'INSERT OR IGNORE INTO user_roles (user_id, role_id, granted_by) VALUES (?, ?, ?)'
                : 'INSERT INTO user_roles (user_id, role_id, granted_by) VALUES (?, ?, ?) ON CONFLICT (user_id, role_id) DO NOTHING';
            await db.execute(onConflict, [user.id, role.id, req.user.id]);
            res.json({ success: true, message: 'Rol asignado' });
        } catch (err) {
            console.error('assignRoleToUser:', err);
            res.status(500).json({ success: false, message: 'Error al asignar rol' });
        }
    }

    static async removeRoleFromUser(req, res) {
        try {
            const { userId, roleCode } = req.params;
            const role = await db.queryOne('SELECT id FROM roles WHERE code = ?', [roleCode]);
            if (!role) return res.status(404).json({ success: false, message: 'Rol no encontrado' });
            await db.execute('DELETE FROM user_roles WHERE user_id = ? AND role_id = ?', [userId, role.id]);
            res.json({ success: true, message: 'Rol removido' });
        } catch (err) {
            console.error('removeRoleFromUser:', err);
            res.status(500).json({ success: false, message: 'Error al remover rol' });
        }
    }

    // -------- Asignaciones user ↔ departamento --------
    static async assignUserToDepartment(req, res) {
        try {
            const { userId, deptId } = req.params;
            const { is_head } = req.body || {};
            const user = await db.queryOne('SELECT id FROM users WHERE id = ?', [userId]);
            if (!user) return res.status(404).json({ success: false, message: 'Usuario no encontrado' });
            const dept = await db.queryOne('SELECT id FROM departments WHERE id = ? AND is_active = 1', [deptId]);
            if (!dept) return res.status(404).json({ success: false, message: 'Departamento no encontrado o archivado' });

            const onConflict = db.driver === 'sqlite'
                ? 'INSERT OR IGNORE INTO user_departments (user_id, department_id, is_head, granted_by) VALUES (?, ?, ?, ?)'
                : 'INSERT INTO user_departments (user_id, department_id, is_head, granted_by) VALUES (?, ?, ?, ?) ON CONFLICT (user_id, department_id) DO NOTHING';
            await db.execute(onConflict, [user.id, dept.id, is_head ? 1 : 0, req.user.id]);

            // Si se pasó is_head=true, actualizamos en caso de fila pre-existente.
            if (is_head) {
                await db.execute(
                    'UPDATE user_departments SET is_head = 1 WHERE user_id = ? AND department_id = ?',
                    [user.id, dept.id]
                );
            }
            res.json({ success: true, message: 'Usuario asignado al departamento' });
        } catch (err) {
            console.error('assignUserToDepartment:', err);
            res.status(500).json({ success: false, message: 'Error al asignar departamento' });
        }
    }

    static async removeUserFromDepartment(req, res) {
        try {
            const { userId, deptId } = req.params;
            await db.execute(
                'DELETE FROM user_departments WHERE user_id = ? AND department_id = ?',
                [userId, deptId]
            );
            res.json({ success: true, message: 'Usuario removido del departamento' });
        } catch (err) {
            console.error('removeUserFromDepartment:', err);
            res.status(500).json({ success: false, message: 'Error al remover del departamento' });
        }
    }

    // -------- Contexto del user actual --------
    // Útil para que el frontend sepa qué puede hacer sin tener que
    // golpear cada endpoint y leer el 403.
    static async myContext(req, res) {
        try {
            const ctx = await getUserContext(req.user.id, req);
            res.json({
                success: true,
                data: {
                    roles: ctx.roles,
                    departments: ctx.departments,
                    permissions: Array.from(ctx.permissions),
                    isAdmin: ctx.isAdmin
                }
            });
        } catch (err) {
            console.error('myContext:', err);
            res.status(500).json({ success: false, message: 'Error al cargar contexto' });
        }
    }

    // Contexto de OTRO user (admin only).
    static async getUserContextById(req, res) {
        try {
            const { id } = req.params;
            const user = await db.queryOne('SELECT id, username, email, full_name FROM users WHERE id = ?', [id]);
            if (!user) return res.status(404).json({ success: false, message: 'Usuario no encontrado' });
            const ctx = await getUserContext(user.id);
            res.json({
                success: true,
                data: {
                    user,
                    roles: ctx.roles,
                    departments: ctx.departments,
                    permissions: Array.from(ctx.permissions)
                }
            });
        } catch (err) {
            console.error('getUserContextById:', err);
            res.status(500).json({ success: false, message: 'Error al cargar contexto del usuario' });
        }
    }

    // -------- Resource ACL (PR-1b) --------
    // Crear/actualizar una entrada ACL.
    // Body: { resource_type, resource_id, principal_type, principal_id, actions? }
    // actions default = ['view'].
    static async createAcl(req, res) {
        try {
            const { resource_type, resource_id, principal_type, principal_id } = req.body;
            let { actions } = req.body;

            if (!['report','document','category'].includes(resource_type)) {
                return res.status(400).json({ success: false, message: 'resource_type inválido' });
            }
            if (!['user','department','role'].includes(principal_type)) {
                return res.status(400).json({ success: false, message: 'principal_type inválido' });
            }
            if (!resource_id || !principal_id) {
                return res.status(400).json({ success: false, message: 'resource_id y principal_id requeridos' });
            }
            if (!Array.isArray(actions) || actions.length === 0) actions = ['view'];
            actions = actions.filter(a => ['view','export','edit'].includes(a));
            if (actions.length === 0) actions = ['view'];

            const actionsJson = JSON.stringify(actions);

            const upsertSql = db.driver === 'sqlite'
                ? `INSERT INTO resource_acl (resource_type, resource_id, principal_type, principal_id, actions, granted_by)
                   VALUES (?, ?, ?, ?, ?, ?)
                   ON CONFLICT(resource_type, resource_id, principal_type, principal_id)
                   DO UPDATE SET actions = excluded.actions, granted_by = excluded.granted_by, granted_at = CURRENT_TIMESTAMP`
                : `INSERT INTO resource_acl (resource_type, resource_id, principal_type, principal_id, actions, granted_by)
                   VALUES (?, ?, ?, ?, ?, ?)
                   ON CONFLICT(resource_type, resource_id, principal_type, principal_id)
                   DO UPDATE SET actions = EXCLUDED.actions, granted_by = EXCLUDED.granted_by, granted_at = CURRENT_TIMESTAMP`;

            await db.execute(upsertSql, [
                resource_type, resource_id, principal_type, principal_id, actionsJson, req.user.id
            ]);

            res.status(201).json({ success: true, message: 'ACL creada/actualizada' });
        } catch (err) {
            console.error('createAcl:', err);
            res.status(500).json({ success: false, message: 'Error al crear ACL' });
        }
    }

    static async deleteAcl(req, res) {
        try {
            const { id } = req.params;
            const r = await db.queryOne('SELECT id FROM resource_acl WHERE id = ?', [id]);
            if (!r) return res.status(404).json({ success: false, message: 'ACL no encontrada' });
            await db.execute('DELETE FROM resource_acl WHERE id = ?', [id]);
            res.json({ success: true, message: 'ACL eliminada' });
        } catch (err) {
            console.error('deleteAcl:', err);
            res.status(500).json({ success: false, message: 'Error al eliminar ACL' });
        }
    }

    // Lista las ACL de un recurso (Vista A: "¿quién tiene acceso a este reporte?").
    static async listAclsForResource(req, res) {
        try {
            const { type, id } = req.params;
            if (!['report','document','category'].includes(type)) {
                return res.status(400).json({ success: false, message: 'type inválido' });
            }
            const rows = await db.query(`
                SELECT
                    a.id, a.resource_type, a.resource_id, a.principal_type, a.principal_id,
                    a.actions, a.granted_at,
                    CASE
                        WHEN a.principal_type = 'user'       THEN u.username
                        WHEN a.principal_type = 'department' THEN d.name
                        WHEN a.principal_type = 'role'       THEN r.name
                    END AS principal_name
                FROM resource_acl a
                LEFT JOIN users u       ON a.principal_type = 'user'       AND u.id = a.principal_id
                LEFT JOIN departments d ON a.principal_type = 'department' AND d.id = a.principal_id
                LEFT JOIN roles r       ON a.principal_type = 'role'       AND r.id = a.principal_id
                WHERE a.resource_type = ? AND a.resource_id = ?
                ORDER BY a.principal_type, a.principal_id
            `, [type, id]);
            res.json({ success: true, data: { acls: rows } });
        } catch (err) {
            console.error('listAclsForResource:', err);
            res.status(500).json({ success: false, message: 'Error al listar ACLs' });
        }
    }

    // -------- Categorías (PR-1c) --------
    static async listCategories(req, res) {
        try {
            const { type, include_archived } = req.query;
            const conditions = [];
            const params = [];
            if (type && ['report', 'document'].includes(type)) {
                conditions.push('type = ?');
                params.push(type);
            }
            if (include_archived !== '1') conditions.push('is_active = 1');
            const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

            const rows = await db.query(`
                SELECT id, type, code, name, description, parent_id,
                       is_active, created_at, updated_at
                FROM categories
                ${where}
                ORDER BY type, name
            `, params);
            res.json({ success: true, data: { categories: rows } });
        } catch (err) {
            console.error('listCategories:', err);
            res.status(500).json({ success: false, message: 'Error al listar categorías' });
        }
    }

    static async createCategory(req, res) {
        try {
            const { type, code, name, description, parent_id } = req.body;
            if (!['report', 'document'].includes(type)) {
                return res.status(400).json({ success: false, message: 'type debe ser report o document' });
            }
            if (!code || !name) {
                return res.status(400).json({ success: false, message: 'code y name son requeridos' });
            }
            if (!/^[a-z][a-z0-9_]{1,31}$/.test(code)) {
                return res.status(400).json({
                    success: false,
                    message: 'code debe ser snake_case (a-z, 0-9, _) y empezar con letra'
                });
            }
            const exists = await db.queryOne(
                'SELECT id FROM categories WHERE type = ? AND code = ?',
                [type, code]
            );
            if (exists) {
                return res.status(409).json({ success: false, message: 'Ya existe una categoría con ese type+code' });
            }
            const r = await db.execute(
                'INSERT INTO categories (type, code, name, description, parent_id) VALUES (?, ?, ?, ?, ?)',
                [type, code, name, description || null, parent_id || null]
            );
            res.status(201).json({ success: true, data: { id: r.lastInsertId, type, code, name } });
        } catch (err) {
            console.error('createCategory:', err);
            res.status(500).json({ success: false, message: 'Error al crear categoría' });
        }
    }

    static async updateCategory(req, res) {
        try {
            const { id } = req.params;
            const { name, description, parent_id, is_active } = req.body;
            const cat = await db.queryOne('SELECT id FROM categories WHERE id = ?', [id]);
            if (!cat) {
                return res.status(404).json({ success: false, message: 'Categoría no encontrada' });
            }
            const updates = [];
            const values = [];
            if (name !== undefined)        { updates.push('name = ?');        values.push(name); }
            if (description !== undefined) { updates.push('description = ?'); values.push(description); }
            if (parent_id !== undefined)   { updates.push('parent_id = ?');   values.push(parent_id || null); }
            if (is_active !== undefined)   { updates.push('is_active = ?');   values.push(is_active ? 1 : 0); }
            if (updates.length === 0) {
                return res.status(400).json({ success: false, message: 'No hay campos para actualizar' });
            }
            updates.push('updated_at = CURRENT_TIMESTAMP');
            values.push(id);
            await db.execute(`UPDATE categories SET ${updates.join(', ')} WHERE id = ?`, values);
            res.json({ success: true, message: 'Categoría actualizada' });
        } catch (err) {
            console.error('updateCategory:', err);
            res.status(500).json({ success: false, message: 'Error al actualizar categoría' });
        }
    }

    static async archiveCategory(req, res) {
        try {
            const { id } = req.params;
            const cat = await db.queryOne('SELECT id FROM categories WHERE id = ?', [id]);
            if (!cat) {
                return res.status(404).json({ success: false, message: 'Categoría no encontrada' });
            }
            await db.execute(
                'UPDATE categories SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
                [id]
            );
            res.json({ success: true, message: 'Categoría archivada' });
        } catch (err) {
            console.error('archiveCategory:', err);
            res.status(500).json({ success: false, message: 'Error al archivar categoría' });
        }
    }

    // Lista los recursos visibles para un principal (Vista B/C).
    static async listAclsForPrincipal(req, res) {
        try {
            const { type, id } = req.params;
            if (!['user','department','role'].includes(type)) {
                return res.status(400).json({ success: false, message: 'type inválido' });
            }
            const rows = await db.query(`
                SELECT id, resource_type, resource_id, principal_type, principal_id,
                       actions, granted_at
                FROM resource_acl
                WHERE principal_type = ? AND principal_id = ?
                ORDER BY resource_type, resource_id
            `, [type, id]);
            res.json({ success: true, data: { acls: rows } });
        } catch (err) {
            console.error('listAclsForPrincipal:', err);
            res.status(500).json({ success: false, message: 'Error al listar ACLs' });
        }
    }
}

module.exports = { RbacController, getUserContext, requirePermission };
