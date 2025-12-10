const db = require('../config/database');

class ReportController {
    // Obtener reportes disponibles para el usuario actual
    static getMyReports(req, res) {
        try {
            const userId = req.user.id;
            const isAdmin = req.user.role === 'admin';

            let reports;

            if (isAdmin) {
                // Los admins pueden ver todos los reportes
                reports = db.prepare(`
                    SELECT 
                        r.id,
                        r.name,
                        r.description,
                        r.embed_url,
                        r.category,
                        r.is_active,
                        r.created_at,
                        r.updated_at,
                        1 as can_view,
                        1 as can_export
                    FROM reports r
                    WHERE r.is_active = 1
                    ORDER BY r.category, r.name
                `).all();
            } else {
                // Los usuarios solo ven los reportes a los que tienen acceso
                reports = db.prepare(`
                    SELECT 
                        r.id,
                        r.name,
                        r.description,
                        r.embed_url,
                        r.category,
                        r.is_active,
                        r.created_at,
                        p.can_view,
                        p.can_export,
                        p.granted_at
                    FROM reports r
                    INNER JOIN user_report_permissions p ON r.id = p.report_id
                    WHERE p.user_id = ? AND r.is_active = 1 AND p.can_view = 1
                    ORDER BY r.category, r.name
                `).all(userId);
            }

            // Agrupar por categoría
            const groupedReports = reports.reduce((acc, report) => {
                const category = report.category || 'Sin categoría';
                if (!acc[category]) {
                    acc[category] = [];
                }
                acc[category].push(report);
                return acc;
            }, {});

            // Registrar acceso
            db.prepare(`
                INSERT INTO access_logs (user_id, action, ip_address)
                VALUES (?, ?, ?)
            `).run(userId, 'view_reports_list', req.ip || 'unknown');

            res.json({
                success: true,
                data: {
                    reports,
                    groupedReports,
                    total: reports.length
                }
            });
        } catch (error) {
            console.error('Error al obtener reportes:', error);
            res.status(500).json({
                success: false,
                message: 'Error al obtener reportes'
            });
        }
    }

    // Obtener todos los reportes (solo admin)
    static getAllReports(req, res) {
        try {
            const { page = 1, limit = 10, search = '', category = '' } = req.query;
            const offset = (page - 1) * limit;

            // Construir consulta
            let query = `
                SELECT 
                    r.id,
                    r.name,
                    r.description,
                    r.embed_url,
                    r.category,
                    r.is_active,
                    r.created_at,
                    r.updated_at,
                    COUNT(p.user_id) as users_with_access
                FROM reports r
                LEFT JOIN user_report_permissions p ON r.id = p.report_id
            `;

            const conditions = [];
            const params = [];

            if (search) {
                conditions.push('(r.name LIKE ? OR r.description LIKE ?)');
                const searchPattern = `%${search}%`;
                params.push(searchPattern, searchPattern);
            }

            if (category) {
                conditions.push('r.category = ?');
                params.push(category);
            }

            if (conditions.length > 0) {
                query += ' WHERE ' + conditions.join(' AND ');
            }

            query += ' GROUP BY r.id';

            // Obtener total
            const countQuery = `SELECT COUNT(*) as total FROM (${query})`;
            const totalResult = db.prepare(countQuery).get(...params);
            const total = totalResult.total;

            // Añadir paginación
            query += ' ORDER BY r.created_at DESC LIMIT ? OFFSET ?';
            params.push(parseInt(limit), parseInt(offset));

            const reports = db.prepare(query).all(...params);

            // Obtener categorías únicas
            const categories = db.prepare(`
                SELECT DISTINCT category FROM reports WHERE category IS NOT NULL ORDER BY category
            `).all().map(row => row.category);

            res.json({
                success: true,
                data: {
                    reports,
                    categories,
                    pagination: {
                        page: parseInt(page),
                        limit: parseInt(limit),
                        total,
                        totalPages: Math.ceil(total / limit)
                    }
                }
            });
        } catch (error) {
            console.error('Error al obtener todos los reportes:', error);
            res.status(500).json({
                success: false,
                message: 'Error al obtener reportes'
            });
        }
    }

    // Obtener un reporte específico
    static getReportById(req, res) {
        try {
            const { id } = req.params;
            const userId = req.user.id;
            const isAdmin = req.user.role === 'admin';

            let report;

            if (isAdmin) {
                report = db.prepare(`
                    SELECT * FROM reports WHERE id = ?
                `).get(id);
            } else {
                // Verificar permisos
                report = db.prepare(`
                    SELECT r.*, p.can_view, p.can_export
                    FROM reports r
                    INNER JOIN user_report_permissions p ON r.id = p.report_id
                    WHERE r.id = ? AND p.user_id = ? AND p.can_view = 1
                `).get(id, userId);
            }

            if (!report) {
                return res.status(404).json({
                    success: false,
                    message: 'Reporte no encontrado o sin permisos'
                });
            }

            // Registrar acceso
            db.prepare(`
                INSERT INTO access_logs (user_id, report_id, action, ip_address)
                VALUES (?, ?, ?, ?)
            `).run(userId, id, 'view_report', req.ip || 'unknown');

            // Obtener usuarios con acceso (solo para admin)
            if (isAdmin) {
                report.users_with_access = db.prepare(`
                    SELECT 
                        u.id,
                        u.username,
                        u.full_name,
                        p.can_view,
                        p.can_export,
                        p.granted_at
                    FROM user_report_permissions p
                    JOIN users u ON p.user_id = u.id
                    WHERE p.report_id = ?
                `).all(id);
            }

            res.json({
                success: true,
                data: { report }
            });
        } catch (error) {
            console.error('Error al obtener reporte:', error);
            res.status(500).json({
                success: false,
                message: 'Error al obtener reporte'
            });
        }
    }

    // Crear nuevo reporte
    static createReport(req, res) {
        try {
            const { name, description, embed_url, category } = req.body;

            if (!name || !embed_url) {
                return res.status(400).json({
                    success: false,
                    message: 'Nombre y URL de inserción son requeridos'
                });
            }

            // Validar formato de URL
            if (!embed_url.includes('powerbi.com')) {
                return res.status(400).json({
                    success: false,
                    message: 'La URL debe ser una URL válida de Power BI'
                });
            }

            // Verificar si ya existe un reporte con el mismo nombre
            const existingReport = db.prepare('SELECT id FROM reports WHERE name = ?').get(name);
            if (existingReport) {
                return res.status(409).json({
                    success: false,
                    message: 'Ya existe un reporte con ese nombre'
                });
            }

            const result = db.prepare(`
                INSERT INTO reports (name, description, embed_url, category)
                VALUES (?, ?, ?, ?)
            `).run(name, description || '', embed_url, category || null);

            // Registrar acción
            db.prepare(`
                INSERT INTO access_logs (user_id, report_id, action, ip_address)
                VALUES (?, ?, ?, ?)
            `).run(req.user.id, result.lastInsertRowid, 'create_report', req.ip || 'unknown');

            res.status(201).json({
                success: true,
                message: 'Reporte creado exitosamente',
                data: {
                    id: result.lastInsertRowid,
                    name,
                    description,
                    embed_url,
                    category
                }
            });
        } catch (error) {
            console.error('Error al crear reporte:', error);
            res.status(500).json({
                success: false,
                message: 'Error al crear reporte'
            });
        }
    }

    // Actualizar reporte
    static updateReport(req, res) {
        try {
            const { id } = req.params;
            const { name, description, embed_url, category, is_active } = req.body;

            // Verificar si el reporte existe
            const report = db.prepare('SELECT id FROM reports WHERE id = ?').get(id);
            if (!report) {
                return res.status(404).json({
                    success: false,
                    message: 'Reporte no encontrado'
                });
            }

            // Construir actualización dinámica
            const updates = [];
            const values = [];

            if (name !== undefined) {
                updates.push('name = ?');
                values.push(name);
            }
            if (description !== undefined) {
                updates.push('description = ?');
                values.push(description);
            }
            if (embed_url !== undefined) {
                updates.push('embed_url = ?');
                values.push(embed_url);
            }
            if (category !== undefined) {
                updates.push('category = ?');
                values.push(category);
            }
            if (is_active !== undefined) {
                updates.push('is_active = ?');
                values.push(is_active ? 1 : 0);
            }

            if (updates.length === 0) {
                return res.status(400).json({
                    success: false,
                    message: 'No hay campos para actualizar'
                });
            }

            values.push(id);
            db.prepare(`UPDATE reports SET ${updates.join(', ')} WHERE id = ?`).run(...values);

            // Registrar acción
            db.prepare(`
                INSERT INTO access_logs (user_id, report_id, action, ip_address)
                VALUES (?, ?, ?, ?)
            `).run(req.user.id, id, 'update_report', req.ip || 'unknown');

            res.json({
                success: true,
                message: 'Reporte actualizado exitosamente'
            });
        } catch (error) {
            console.error('Error al actualizar reporte:', error);
            res.status(500).json({
                success: false,
                message: 'Error al actualizar reporte'
            });
        }
    }

    // Eliminar reporte
    static deleteReport(req, res) {
        try {
            const { id } = req.params;

            // Verificar si el reporte existe
            const report = db.prepare('SELECT name FROM reports WHERE id = ?').get(id);
            if (!report) {
                return res.status(404).json({
                    success: false,
                    message: 'Reporte no encontrado'
                });
            }

            // Eliminar reporte (los permisos se eliminarán en cascada)
            db.prepare('DELETE FROM reports WHERE id = ?').run(id);

            // Registrar acción
            db.prepare(`
                INSERT INTO access_logs (user_id, action, ip_address)
                VALUES (?, ?, ?)
            `).run(req.user.id, `delete_report:${report.name}`, req.ip || 'unknown');

            res.json({
                success: true,
                message: 'Reporte eliminado exitosamente'
            });
        } catch (error) {
            console.error('Error al eliminar reporte:', error);
            res.status(500).json({
                success: false,
                message: 'Error al eliminar reporte'
            });
        }
    }

    // Obtener estadísticas de acceso
    static getReportStats(req, res) {
        try {
            const { id } = req.params;

            // Verificar si el reporte existe
            const report = db.prepare('SELECT name FROM reports WHERE id = ?').get(id);
            if (!report) {
                return res.status(404).json({
                    success: false,
                    message: 'Reporte no encontrado'
                });
            }

            // Obtener estadísticas
            const stats = db.prepare(`
                SELECT 
                    COUNT(DISTINCT user_id) as unique_users,
                    COUNT(*) as total_views,
                    MAX(timestamp) as last_accessed
                FROM access_logs
                WHERE report_id = ? AND action = 'view_report'
            `).get(id);

            // Obtener accesos recientes
            const recentAccess = db.prepare(`
                SELECT 
                    u.username,
                    u.full_name,
                    l.timestamp
                FROM access_logs l
                JOIN users u ON l.user_id = u.id
                WHERE l.report_id = ? AND l.action = 'view_report'
                ORDER BY l.timestamp DESC
                LIMIT 10
            `).all(id);

            res.json({
                success: true,
                data: {
                    report_name: report.name,
                    stats,
                    recentAccess
                }
            });
        } catch (error) {
            console.error('Error al obtener estadísticas:', error);
            res.status(500).json({
                success: false,
                message: 'Error al obtener estadísticas'
            });
        }
    }
}

module.exports = ReportController;
