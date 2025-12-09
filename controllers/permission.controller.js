const db = require('../config/database');

class PermissionController {
    // Asignar permiso a un usuario para un reporte
    static assignPermission(req, res) {
        try {
            const { userId, reportId } = req.params;
            const { can_view = true, can_export = false } = req.body;
            const grantedBy = req.user.id;

            // Verificar que el usuario y el reporte existen
            const user = db.prepare('SELECT username FROM users WHERE id = ?').get(userId);
            const report = db.prepare('SELECT name FROM reports WHERE id = ?').get(reportId);

            if (!user || !report) {
                return res.status(404).json({
                    success: false,
                    message: 'Usuario o reporte no encontrado'
                });
            }

            // Verificar si ya existe el permiso
            const existingPermission = db.prepare(`
                SELECT id FROM user_report_permissions 
                WHERE user_id = ? AND report_id = ?
            `).get(userId, reportId);

            if (existingPermission) {
                // Actualizar permiso existente
                db.prepare(`
                    UPDATE user_report_permissions 
                    SET can_view = ?, can_export = ?, granted_by = ?, granted_at = CURRENT_TIMESTAMP
                    WHERE user_id = ? AND report_id = ?
                `).run(can_view ? 1 : 0, can_export ? 1 : 0, grantedBy, userId, reportId);

                // Registrar acción
                db.prepare(`
                    INSERT INTO access_logs (user_id, action, ip_address)
                    VALUES (?, ?, ?)
                `).run(grantedBy, `update_permission:${user.username}:${report.name}`, req.ip || 'unknown');

                res.json({
                    success: true,
                    message: 'Permisos actualizados exitosamente'
                });
            } else {
                // Crear nuevo permiso
                db.prepare(`
                    INSERT INTO user_report_permissions (user_id, report_id, can_view, can_export, granted_by)
                    VALUES (?, ?, ?, ?, ?)
                `).run(userId, reportId, can_view ? 1 : 0, can_export ? 1 : 0, grantedBy);

                // Registrar acción
                db.prepare(`
                    INSERT INTO access_logs (user_id, action, ip_address)
                    VALUES (?, ?, ?)
                `).run(grantedBy, `grant_permission:${user.username}:${report.name}`, req.ip || 'unknown');

                res.status(201).json({
                    success: true,
                    message: 'Permiso asignado exitosamente'
                });
            }
        } catch (error) {
            console.error('Error al asignar permiso:', error);
            res.status(500).json({
                success: false,
                message: 'Error al asignar permiso'
            });
        }
    }

    // Quitar permiso de un usuario para un reporte
    static removePermission(req, res) {
        try {
            const { userId, reportId } = req.params;
            const revokedBy = req.user.id;

            // Verificar que el permiso existe
            const permission = db.prepare(`
                SELECT u.username, r.name as report_name
                FROM user_report_permissions p
                JOIN users u ON p.user_id = u.id
                JOIN reports r ON p.report_id = r.id
                WHERE p.user_id = ? AND p.report_id = ?
            `).get(userId, reportId);

            if (!permission) {
                return res.status(404).json({
                    success: false,
                    message: 'Permiso no encontrado'
                });
            }

            // Eliminar permiso
            db.prepare(`
                DELETE FROM user_report_permissions 
                WHERE user_id = ? AND report_id = ?
            `).run(userId, reportId);

            // Registrar acción
            db.prepare(`
                INSERT INTO access_logs (user_id, action, ip_address)
                VALUES (?, ?, ?)
            `).run(revokedBy, `revoke_permission:${permission.username}:${permission.report_name}`, req.ip || 'unknown');

            res.json({
                success: true,
                message: 'Permiso revocado exitosamente'
            });
        } catch (error) {
            console.error('Error al quitar permiso:', error);
            res.status(500).json({
                success: false,
                message: 'Error al quitar permiso'
            });
        }
    }

    // Asignar permisos en masa
    static bulkAssignPermissions(req, res) {
        try {
            const { userIds = [], reportIds = [], can_view = true, can_export = false } = req.body;
            const grantedBy = req.user.id;

            if (!userIds.length || !reportIds.length) {
                return res.status(400).json({
                    success: false,
                    message: 'Se requieren IDs de usuarios y reportes'
                });
            }

            const stmt = db.prepare(`
                INSERT OR REPLACE INTO user_report_permissions (user_id, report_id, can_view, can_export, granted_by)
                VALUES (?, ?, ?, ?, ?)
            `);

            const transaction = db.transaction(() => {
                for (const userId of userIds) {
                    for (const reportId of reportIds) {
                        stmt.run(userId, reportId, can_view ? 1 : 0, can_export ? 1 : 0, grantedBy);
                    }
                }
            });

            transaction();

            // Registrar acción
            db.prepare(`
                INSERT INTO access_logs (user_id, action, ip_address)
                VALUES (?, ?, ?)
            `).run(grantedBy, `bulk_assign:${userIds.length}users:${reportIds.length}reports`, req.ip || 'unknown');

            res.json({
                success: true,
                message: `Permisos asignados exitosamente a ${userIds.length} usuarios para ${reportIds.length} reportes`
            });
        } catch (error) {
            console.error('Error en asignación masiva:', error);
            res.status(500).json({
                success: false,
                message: 'Error al asignar permisos en masa'
            });
        }
    }

    // Obtener matriz de permisos
    static getPermissionsMatrix(req, res) {
        try {
            // Obtener todos los usuarios y reportes activos
            const users = db.prepare(`
                SELECT id, username, full_name 
                FROM users 
                WHERE is_active = 1 
                ORDER BY username
            `).all();

            const reports = db.prepare(`
                SELECT id, name, category 
                FROM reports 
                WHERE is_active = 1 
                ORDER BY category, name
            `).all();

            // Obtener todos los permisos
            const permissions = db.prepare(`
                SELECT user_id, report_id, can_view, can_export 
                FROM user_report_permissions
            `).all();

            // Crear mapa de permisos para acceso rápido
            const permissionMap = {};
            permissions.forEach(p => {
                const key = `${p.user_id}-${p.report_id}`;
                permissionMap[key] = {
                    can_view: p.can_view,
                    can_export: p.can_export
                };
            });

            // Construir matriz
            const matrix = users.map(user => {
                const userPermissions = {};
                reports.forEach(report => {
                    const key = `${user.id}-${report.id}`;
                    userPermissions[report.id] = permissionMap[key] || { can_view: false, can_export: false };
                });

                return {
                    user,
                    permissions: userPermissions
                };
            });

            res.json({
                success: true,
                data: {
                    users,
                    reports,
                    matrix
                }
            });
        } catch (error) {
            console.error('Error al obtener matriz de permisos:', error);
            res.status(500).json({
                success: false,
                message: 'Error al obtener matriz de permisos'
            });
        }
    }

    // Clonar permisos de un usuario a otro
    static clonePermissions(req, res) {
        try {
            const { sourceUserId, targetUserId } = req.body;
            const grantedBy = req.user.id;

            if (!sourceUserId || !targetUserId) {
                return res.status(400).json({
                    success: false,
                    message: 'Se requieren IDs de usuario origen y destino'
                });
            }

            // Verificar que ambos usuarios existen
            const sourceUser = db.prepare('SELECT username FROM users WHERE id = ?').get(sourceUserId);
            const targetUser = db.prepare('SELECT username FROM users WHERE id = ?').get(targetUserId);

            if (!sourceUser || !targetUser) {
                return res.status(404).json({
                    success: false,
                    message: 'Usuario origen o destino no encontrado'
                });
            }

            // Obtener permisos del usuario origen
            const sourcePermissions = db.prepare(`
                SELECT report_id, can_view, can_export
                FROM user_report_permissions
                WHERE user_id = ?
            `).all(sourceUserId);

            if (sourcePermissions.length === 0) {
                return res.status(400).json({
                    success: false,
                    message: 'El usuario origen no tiene permisos para clonar'
                });
            }

            // Clonar permisos
            const stmt = db.prepare(`
                INSERT OR REPLACE INTO user_report_permissions (user_id, report_id, can_view, can_export, granted_by)
                VALUES (?, ?, ?, ?, ?)
            `);

            const transaction = db.transaction(() => {
                sourcePermissions.forEach(perm => {
                    stmt.run(targetUserId, perm.report_id, perm.can_view, perm.can_export, grantedBy);
                });
            });

            transaction();

            // Registrar acción
            db.prepare(`
                INSERT INTO access_logs (user_id, action, ip_address)
                VALUES (?, ?, ?)
            `).run(grantedBy, `clone_permissions:${sourceUser.username}to${targetUser.username}`, req.ip || 'unknown');

            res.json({
                success: true,
                message: `Permisos clonados exitosamente de ${sourceUser.username} a ${targetUser.username}`
            });
        } catch (error) {
            console.error('Error al clonar permisos:', error);
            res.status(500).json({
                success: false,
                message: 'Error al clonar permisos'
            });
        }
    }
}

module.exports = PermissionController;
