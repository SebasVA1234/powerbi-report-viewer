const db = require('../config/db');

// Helper: ON CONFLICT...DO UPDATE funciona en SQLite 3.24+ y PostgreSQL.
// Lo usamos como reemplazo portable de "INSERT OR REPLACE" (SQLite-only).

class PermissionController {
    // Asignar permiso a un usuario para un reporte
    static async assignPermission(req, res) {
        try {
            const { userId, reportId } = req.params;
            const { can_view = true, can_export = false } = req.body;
            const grantedBy = req.user.id;

            const user = await db.queryOne('SELECT username FROM users WHERE id = ?', [userId]);
            const report = await db.queryOne('SELECT name FROM reports WHERE id = ?', [reportId]);

            if (!user || !report) {
                return res.status(404).json({
                    success: false,
                    message: 'Usuario o reporte no encontrado'
                });
            }

            const existing = await db.queryOne(
                `SELECT id FROM user_report_permissions
                 WHERE user_id = ? AND report_id = ?`,
                [userId, reportId]
            );

            if (existing) {
                await db.execute(
                    `UPDATE user_report_permissions
                     SET can_view = ?, can_export = ?, granted_by = ?, granted_at = CURRENT_TIMESTAMP
                     WHERE user_id = ? AND report_id = ?`,
                    [can_view ? 1 : 0, can_export ? 1 : 0, grantedBy, userId, reportId]
                );
                await db.execute(
                    'INSERT INTO access_logs (user_id, action, ip_address) VALUES (?, ?, ?)',
                    [grantedBy, `update_permission:${user.username}:${report.name}`, req.ip || 'unknown']
                );
                res.json({ success: true, message: 'Permisos actualizados exitosamente' });
            } else {
                await db.execute(
                    `INSERT INTO user_report_permissions (user_id, report_id, can_view, can_export, granted_by)
                     VALUES (?, ?, ?, ?, ?)`,
                    [userId, reportId, can_view ? 1 : 0, can_export ? 1 : 0, grantedBy]
                );
                await db.execute(
                    'INSERT INTO access_logs (user_id, action, ip_address) VALUES (?, ?, ?)',
                    [grantedBy, `grant_permission:${user.username}:${report.name}`, req.ip || 'unknown']
                );
                res.status(201).json({ success: true, message: 'Permiso asignado exitosamente' });
            }
        } catch (error) {
            console.error('Error al asignar permiso:', error);
            res.status(500).json({ success: false, message: 'Error al asignar permiso' });
        }
    }

    // Quitar permiso (idempotente)
    static async removePermission(req, res) {
        try {
            const { userId, reportId } = req.params;
            const revokedBy = req.user.id;

            const permission = await db.queryOne(`
                SELECT u.username, r.name as report_name
                FROM user_report_permissions p
                JOIN users u ON p.user_id = u.id
                JOIN reports r ON p.report_id = r.id
                WHERE p.user_id = ? AND p.report_id = ?
            `, [userId, reportId]);

            if (!permission) {
                return res.json({
                    success: true,
                    message: 'El usuario ya no tenía permiso',
                    alreadyAbsent: true
                });
            }

            await db.execute(
                'DELETE FROM user_report_permissions WHERE user_id = ? AND report_id = ?',
                [userId, reportId]
            );
            await db.execute(
                'INSERT INTO access_logs (user_id, action, ip_address) VALUES (?, ?, ?)',
                [revokedBy, `revoke_permission:${permission.username}:${permission.report_name}`, req.ip || 'unknown']
            );

            res.json({ success: true, message: 'Permiso revocado exitosamente' });
        } catch (error) {
            console.error('Error al quitar permiso:', error);
            res.status(500).json({ success: false, message: 'Error al quitar permiso' });
        }
    }

    // Sincronizar lista completa de usuarios con acceso a un reporte (atómico)
    static async syncReportPermissions(req, res) {
        try {
            const { reportId } = req.params;
            const { userIds = [] } = req.body;
            const grantedBy = req.user.id;

            const report = await db.queryOne('SELECT name FROM reports WHERE id = ?', [reportId]);
            if (!report) {
                return res.status(404).json({ success: false, message: 'Reporte no encontrado' });
            }

            const targetIds = [...new Set(
                (Array.isArray(userIds) ? userIds : [])
                    .map(n => parseInt(n, 10))
                    .filter(n => Number.isInteger(n) && n > 0)
            )];

            if (targetIds.length > 0) {
                const placeholders = targetIds.map(() => '?').join(',');
                const found = await db.query(
                    `SELECT id FROM users WHERE id IN (${placeholders})`,
                    targetIds
                );
                if (found.length !== targetIds.length) {
                    return res.status(400).json({
                        success: false,
                        message: 'Uno o más usuarios no existen'
                    });
                }
            }

            await db.transaction(async tx => {
                if (targetIds.length > 0) {
                    const ph = targetIds.map(() => '?').join(',');
                    await tx.execute(
                        `DELETE FROM user_report_permissions
                         WHERE report_id = ? AND user_id NOT IN (${ph})`,
                        [reportId, ...targetIds]
                    );
                } else {
                    await tx.execute(
                        'DELETE FROM user_report_permissions WHERE report_id = ?',
                        [reportId]
                    );
                }
                for (const userId of targetIds) {
                    await tx.execute(
                        `INSERT INTO user_report_permissions (user_id, report_id, can_view, can_export, granted_by)
                         VALUES (?, ?, 1, 0, ?)
                         ON CONFLICT(user_id, report_id) DO UPDATE SET
                             can_view = 1,
                             granted_by = excluded.granted_by,
                             granted_at = CURRENT_TIMESTAMP`,
                        [userId, reportId, grantedBy]
                    );
                }
            });

            await db.execute(
                'INSERT INTO access_logs (user_id, action, ip_address) VALUES (?, ?, ?)',
                [grantedBy, `sync_permissions:${report.name}:${targetIds.length}users`, req.ip || 'unknown']
            );

            res.json({
                success: true,
                message: `Accesos sincronizados: ${targetIds.length} usuarios con permiso`,
                data: { userIds: targetIds }
            });
        } catch (error) {
            console.error('Error al sincronizar permisos:', error);
            res.status(500).json({ success: false, message: 'Error al sincronizar permisos' });
        }
    }

    // Asignar permisos en masa
    static async bulkAssignPermissions(req, res) {
        try {
            const { userIds = [], reportIds = [], can_view = true, can_export = false } = req.body;
            const grantedBy = req.user.id;

            if (!userIds.length || !reportIds.length) {
                return res.status(400).json({
                    success: false,
                    message: 'Se requieren IDs de usuarios y reportes'
                });
            }

            await db.transaction(async tx => {
                for (const userId of userIds) {
                    for (const reportId of reportIds) {
                        await tx.execute(
                            `INSERT INTO user_report_permissions (user_id, report_id, can_view, can_export, granted_by)
                             VALUES (?, ?, ?, ?, ?)
                             ON CONFLICT(user_id, report_id) DO UPDATE SET
                                 can_view = excluded.can_view,
                                 can_export = excluded.can_export,
                                 granted_by = excluded.granted_by,
                                 granted_at = CURRENT_TIMESTAMP`,
                            [userId, reportId, can_view ? 1 : 0, can_export ? 1 : 0, grantedBy]
                        );
                    }
                }
            });

            await db.execute(
                'INSERT INTO access_logs (user_id, action, ip_address) VALUES (?, ?, ?)',
                [grantedBy, `bulk_assign:${userIds.length}users:${reportIds.length}reports`, req.ip || 'unknown']
            );

            res.json({
                success: true,
                message: `Permisos asignados exitosamente a ${userIds.length} usuarios para ${reportIds.length} reportes`
            });
        } catch (error) {
            console.error('Error en asignación masiva:', error);
            res.status(500).json({ success: false, message: 'Error al asignar permisos en masa' });
        }
    }

    // Matriz de permisos
    static async getPermissionsMatrix(req, res) {
        try {
            const users = await db.query(
                `SELECT id, username, full_name, role
                 FROM users WHERE is_active = 1 ORDER BY username`
            );
            const reports = await db.query(
                `SELECT id, name, category
                 FROM reports WHERE is_active = 1 ORDER BY category, name`
            );
            const permissions = await db.query(
                'SELECT user_id, report_id, can_view, can_export FROM user_report_permissions'
            );

            const permissionMap = {};
            permissions.forEach(p => {
                permissionMap[`${p.user_id}-${p.report_id}`] = {
                    can_view: p.can_view,
                    can_export: p.can_export
                };
            });

            const matrix = users.map(user => {
                const userPermissions = {};
                reports.forEach(report => {
                    userPermissions[report.id] = permissionMap[`${user.id}-${report.id}`]
                        || { can_view: false, can_export: false };
                });
                return { user, permissions: userPermissions };
            });

            res.json({ success: true, data: { users, reports, matrix } });
        } catch (error) {
            console.error('Error al obtener matriz de permisos:', error);
            res.status(500).json({ success: false, message: 'Error al obtener matriz de permisos' });
        }
    }

    // ============== PERMISOS DE DOCUMENTOS ==============

    static async assignDocumentPermission(req, res) {
        try {
            const { userId, documentId } = req.params;
            const { can_view = true } = req.body;
            const grantedBy = req.user.id;

            const user = await db.queryOne('SELECT username FROM users WHERE id = ?', [userId]);
            const doc = await db.queryOne('SELECT name FROM documents WHERE id = ?', [documentId]);

            if (!user || !doc) {
                return res.status(404).json({
                    success: false,
                    message: 'Usuario o documento no encontrado'
                });
            }

            const existing = await db.queryOne(
                'SELECT id FROM user_document_permissions WHERE user_id = ? AND document_id = ?',
                [userId, documentId]
            );

            if (existing) {
                await db.execute(
                    `UPDATE user_document_permissions
                     SET can_view = ?, granted_by = ?, granted_at = CURRENT_TIMESTAMP
                     WHERE user_id = ? AND document_id = ?`,
                    [can_view ? 1 : 0, grantedBy, userId, documentId]
                );
            } else {
                await db.execute(
                    `INSERT INTO user_document_permissions (user_id, document_id, can_view, granted_by)
                     VALUES (?, ?, ?, ?)`,
                    [userId, documentId, can_view ? 1 : 0, grantedBy]
                );
            }

            await db.execute(
                'INSERT INTO access_logs (user_id, action, ip_address) VALUES (?, ?, ?)',
                [grantedBy, `assign_doc_permission:${user.username}:${doc.name}`, req.ip || 'unknown']
            );

            res.json({ success: true, message: 'Permiso de documento asignado exitosamente' });
        } catch (error) {
            console.error('Error al asignar permiso de documento:', error);
            res.status(500).json({ success: false, message: 'Error al asignar permiso de documento' });
        }
    }

    static async removeDocumentPermission(req, res) {
        try {
            const { userId, documentId } = req.params;
            const revokedBy = req.user.id;

            const permission = await db.queryOne(`
                SELECT u.username, d.name as document_name
                FROM user_document_permissions p
                JOIN users u ON p.user_id = u.id
                JOIN documents d ON p.document_id = d.id
                WHERE p.user_id = ? AND p.document_id = ?
            `, [userId, documentId]);

            if (!permission) {
                return res.json({
                    success: true,
                    message: 'El usuario ya no tenía permiso',
                    alreadyAbsent: true
                });
            }

            await db.execute(
                'DELETE FROM user_document_permissions WHERE user_id = ? AND document_id = ?',
                [userId, documentId]
            );
            await db.execute(
                'INSERT INTO access_logs (user_id, action, ip_address) VALUES (?, ?, ?)',
                [revokedBy, `revoke_doc_permission:${permission.username}:${permission.document_name}`, req.ip || 'unknown']
            );

            res.json({ success: true, message: 'Permiso de documento revocado exitosamente' });
        } catch (error) {
            console.error('Error al quitar permiso de documento:', error);
            res.status(500).json({ success: false, message: 'Error al quitar permiso de documento' });
        }
    }

    static async bulkAssignDocumentPermissions(req, res) {
        try {
            const { userIds = [], documentIds = [], can_view = true } = req.body;
            const grantedBy = req.user.id;

            if (!userIds.length || !documentIds.length) {
                return res.status(400).json({
                    success: false,
                    message: 'Se requieren IDs de usuarios y documentos'
                });
            }

            await db.transaction(async tx => {
                for (const userId of userIds) {
                    for (const documentId of documentIds) {
                        await tx.execute(
                            `INSERT INTO user_document_permissions (user_id, document_id, can_view, granted_by)
                             VALUES (?, ?, ?, ?)
                             ON CONFLICT(user_id, document_id) DO UPDATE SET
                                 can_view = excluded.can_view,
                                 granted_by = excluded.granted_by,
                                 granted_at = CURRENT_TIMESTAMP`,
                            [userId, documentId, can_view ? 1 : 0, grantedBy]
                        );
                    }
                }
            });

            await db.execute(
                'INSERT INTO access_logs (user_id, action, ip_address) VALUES (?, ?, ?)',
                [grantedBy, `bulk_doc_assign:${userIds.length}users:${documentIds.length}docs`, req.ip || 'unknown']
            );

            res.json({
                success: true,
                message: `Permisos asignados a ${userIds.length} usuarios para ${documentIds.length} documentos`
            });
        } catch (error) {
            console.error('Error en asignación masiva de documentos:', error);
            res.status(500).json({ success: false, message: 'Error al asignar permisos de documentos en masa' });
        }
    }

    static async getDocumentsPermissionsMatrix(req, res) {
        try {
            const users = await db.query(
                `SELECT id, username, full_name, role
                 FROM users WHERE is_active = 1 ORDER BY username`
            );
            const documents = await db.query(
                `SELECT id, name, category
                 FROM documents WHERE is_active = 1 ORDER BY category, name`
            );
            const permissions = await db.query(
                'SELECT user_id, document_id, can_view FROM user_document_permissions'
            );

            const permissionMap = {};
            permissions.forEach(p => {
                permissionMap[`${p.user_id}-${p.document_id}`] = { can_view: p.can_view };
            });

            const matrix = users.map(user => {
                const userPermissions = {};
                documents.forEach(doc => {
                    userPermissions[doc.id] = permissionMap[`${user.id}-${doc.id}`]
                        || { can_view: false };
                });
                return { user, permissions: userPermissions };
            });

            res.json({ success: true, data: { users, documents, matrix } });
        } catch (error) {
            console.error('Error al obtener matriz de permisos de documentos:', error);
            res.status(500).json({ success: false, message: 'Error al obtener matriz de permisos de documentos' });
        }
    }

    static async syncDocumentPermissions(req, res) {
        try {
            const { documentId } = req.params;
            const { userIds = [] } = req.body;
            const grantedBy = req.user.id;

            const doc = await db.queryOne('SELECT name FROM documents WHERE id = ?', [documentId]);
            if (!doc) {
                return res.status(404).json({ success: false, message: 'Documento no encontrado' });
            }

            const targetIds = [...new Set(
                (Array.isArray(userIds) ? userIds : [])
                    .map(n => parseInt(n, 10))
                    .filter(n => Number.isInteger(n) && n > 0)
            )];

            if (targetIds.length > 0) {
                const placeholders = targetIds.map(() => '?').join(',');
                const found = await db.query(
                    `SELECT id FROM users WHERE id IN (${placeholders})`,
                    targetIds
                );
                if (found.length !== targetIds.length) {
                    return res.status(400).json({
                        success: false,
                        message: 'Uno o más usuarios no existen'
                    });
                }
            }

            await db.transaction(async tx => {
                if (targetIds.length > 0) {
                    const ph = targetIds.map(() => '?').join(',');
                    await tx.execute(
                        `DELETE FROM user_document_permissions
                         WHERE document_id = ? AND user_id NOT IN (${ph})`,
                        [documentId, ...targetIds]
                    );
                } else {
                    await tx.execute(
                        'DELETE FROM user_document_permissions WHERE document_id = ?',
                        [documentId]
                    );
                }
                for (const userId of targetIds) {
                    await tx.execute(
                        `INSERT INTO user_document_permissions (user_id, document_id, can_view, granted_by)
                         VALUES (?, ?, 1, ?)
                         ON CONFLICT(user_id, document_id) DO UPDATE SET
                             can_view = 1,
                             granted_by = excluded.granted_by,
                             granted_at = CURRENT_TIMESTAMP`,
                        [userId, documentId, grantedBy]
                    );
                }
            });

            await db.execute(
                'INSERT INTO access_logs (user_id, action, ip_address) VALUES (?, ?, ?)',
                [grantedBy, `sync_doc_permissions:${doc.name}:${targetIds.length}users`, req.ip || 'unknown']
            );

            res.json({
                success: true,
                message: `Accesos sincronizados: ${targetIds.length} usuarios con permiso`,
                data: { userIds: targetIds }
            });
        } catch (error) {
            console.error('Error al sincronizar permisos de documento:', error);
            res.status(500).json({ success: false, message: 'Error al sincronizar permisos de documento' });
        }
    }

    // Clonar permisos de un usuario a otro
    static async clonePermissions(req, res) {
        try {
            const { sourceUserId, targetUserId } = req.body;
            const grantedBy = req.user.id;

            if (!sourceUserId || !targetUserId) {
                return res.status(400).json({
                    success: false,
                    message: 'Se requieren IDs de usuario origen y destino'
                });
            }

            const sourceUser = await db.queryOne('SELECT username FROM users WHERE id = ?', [sourceUserId]);
            const targetUser = await db.queryOne('SELECT username FROM users WHERE id = ?', [targetUserId]);

            if (!sourceUser || !targetUser) {
                return res.status(404).json({
                    success: false,
                    message: 'Usuario origen o destino no encontrado'
                });
            }

            const sourcePermissions = await db.query(
                `SELECT report_id, can_view, can_export
                 FROM user_report_permissions WHERE user_id = ?`,
                [sourceUserId]
            );

            if (sourcePermissions.length === 0) {
                return res.status(400).json({
                    success: false,
                    message: 'El usuario origen no tiene permisos para clonar'
                });
            }

            await db.transaction(async tx => {
                for (const perm of sourcePermissions) {
                    await tx.execute(
                        `INSERT INTO user_report_permissions (user_id, report_id, can_view, can_export, granted_by)
                         VALUES (?, ?, ?, ?, ?)
                         ON CONFLICT(user_id, report_id) DO UPDATE SET
                             can_view = excluded.can_view,
                             can_export = excluded.can_export,
                             granted_by = excluded.granted_by,
                             granted_at = CURRENT_TIMESTAMP`,
                        [targetUserId, perm.report_id, perm.can_view, perm.can_export, grantedBy]
                    );
                }
            });

            await db.execute(
                'INSERT INTO access_logs (user_id, action, ip_address) VALUES (?, ?, ?)',
                [grantedBy, `clone_permissions:${sourceUser.username}to${targetUser.username}`, req.ip || 'unknown']
            );

            res.json({
                success: true,
                message: `Permisos clonados exitosamente de ${sourceUser.username} a ${targetUser.username}`
            });
        } catch (error) {
            console.error('Error al clonar permisos:', error);
            res.status(500).json({ success: false, message: 'Error al clonar permisos' });
        }
    }
}

module.exports = PermissionController;
