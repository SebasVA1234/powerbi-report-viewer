const db = require('../config/db');

class ReportController {
    // Obtener reportes disponibles para el usuario actual
    static async getMyReports(req, res) {
        try {
            const userId = req.user.id;
            const isAdmin = req.user.role === 'admin';

            let reports;

            if (isAdmin) {
                reports = await db.query(`
                    SELECT
                        r.id, r.name, r.description, r.embed_url, r.category,
                        r.is_active, r.created_at, r.updated_at,
                        1 as can_view, 1 as can_export
                    FROM reports r
                    WHERE r.is_active = 1
                    ORDER BY r.category, r.name
                `);
            } else {
                reports = await db.query(`
                    SELECT
                        r.id, r.name, r.description, r.embed_url, r.category,
                        r.is_active, r.created_at,
                        p.can_view, p.can_export, p.granted_at
                    FROM reports r
                    INNER JOIN user_report_permissions p ON r.id = p.report_id
                    WHERE p.user_id = ? AND r.is_active = 1 AND p.can_view = 1
                    ORDER BY r.category, r.name
                `, [userId]);
            }

            const groupedReports = reports.reduce((acc, report) => {
                const category = report.category || 'Sin categoría';
                if (!acc[category]) acc[category] = [];
                acc[category].push(report);
                return acc;
            }, {});

            await db.execute(
                'INSERT INTO access_logs (user_id, action, ip_address) VALUES (?, ?, ?)',
                [userId, 'view_reports_list', req.ip || 'unknown']
            );

            res.json({
                success: true,
                data: { reports, groupedReports, total: reports.length }
            });
        } catch (error) {
            console.error('Error al obtener reportes:', error);
            res.status(500).json({ success: false, message: 'Error al obtener reportes' });
        }
    }

    // Obtener todos los reportes (solo admin)
    static async getAllReports(req, res) {
        try {
            const { page = 1, limit = 10, search = '', category = '' } = req.query;
            const offset = (page - 1) * limit;

            let baseSelect = `
                SELECT
                    r.id, r.name, r.description, r.embed_url, r.category,
                    r.is_active, r.created_at, r.updated_at,
                    COUNT(p.user_id) as users_with_access
                FROM reports r
                LEFT JOIN user_report_permissions p ON r.id = p.report_id
            `;

            const conditions = [];
            const params = [];

            if (search) {
                conditions.push('(r.name LIKE ? OR r.description LIKE ?)');
                const sp = `%${search}%`;
                params.push(sp, sp);
            }
            if (category) {
                conditions.push('r.category = ?');
                params.push(category);
            }

            if (conditions.length > 0) {
                baseSelect += ' WHERE ' + conditions.join(' AND ');
            }
            baseSelect += ' GROUP BY r.id';

            // Total. PostgreSQL exige alias en subquery del FROM, SQLite lo acepta igual.
            const countQuery = `SELECT COUNT(*) as total FROM (${baseSelect}) AS sub`;
            const totalRow = await db.queryOne(countQuery, params);
            const total = Number(totalRow.total);

            const listSql = baseSelect + ' ORDER BY r.created_at DESC LIMIT ? OFFSET ?';
            const reports = await db.query(
                listSql,
                [...params, parseInt(limit), parseInt(offset)]
            );

            const cats = await db.query(
                'SELECT DISTINCT category FROM reports WHERE category IS NOT NULL ORDER BY category'
            );
            const categories = cats.map(r => r.category);

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
            res.status(500).json({ success: false, message: 'Error al obtener reportes' });
        }
    }

    // Obtener un reporte específico
    static async getReportById(req, res) {
        try {
            const { id } = req.params;
            const userId = req.user.id;
            const isAdmin = req.user.role === 'admin';

            let report;
            if (isAdmin) {
                report = await db.queryOne('SELECT * FROM reports WHERE id = ?', [id]);
            } else {
                report = await db.queryOne(`
                    SELECT r.*, p.can_view, p.can_export
                    FROM reports r
                    INNER JOIN user_report_permissions p ON r.id = p.report_id
                    WHERE r.id = ? AND p.user_id = ? AND p.can_view = 1
                `, [id, userId]);
            }

            if (!report) {
                return res.status(404).json({
                    success: false,
                    message: 'Reporte no encontrado o sin permisos'
                });
            }

            await db.execute(
                'INSERT INTO access_logs (user_id, report_id, action, ip_address) VALUES (?, ?, ?, ?)',
                [userId, id, 'view_report', req.ip || 'unknown']
            );

            if (isAdmin) {
                report.users_with_access = await db.query(`
                    SELECT u.id, u.username, u.full_name,
                           p.can_view, p.can_export, p.granted_at
                    FROM user_report_permissions p
                    JOIN users u ON p.user_id = u.id
                    WHERE p.report_id = ?
                `, [id]);
            }

            res.json({ success: true, data: { report } });
        } catch (error) {
            console.error('Error al obtener reporte:', error);
            res.status(500).json({ success: false, message: 'Error al obtener reporte' });
        }
    }

    // Crear nuevo reporte
    static async createReport(req, res) {
        try {
            const { name, description, embed_url, category } = req.body;

            if (!name || !embed_url) {
                return res.status(400).json({
                    success: false,
                    message: 'Nombre y URL de inserción son requeridos'
                });
            }
            if (!embed_url.includes('powerbi.com')) {
                return res.status(400).json({
                    success: false,
                    message: 'La URL debe ser una URL válida de Power BI'
                });
            }

            const existingReport = await db.queryOne(
                'SELECT id FROM reports WHERE name = ?',
                [name]
            );
            if (existingReport) {
                return res.status(409).json({
                    success: false,
                    message: 'Ya existe un reporte con ese nombre'
                });
            }

            const result = await db.execute(
                `INSERT INTO reports (name, description, embed_url, category)
                 VALUES (?, ?, ?, ?)`,
                [name, description || '', embed_url, category || null]
            );

            await db.execute(
                'INSERT INTO access_logs (user_id, report_id, action, ip_address) VALUES (?, ?, ?, ?)',
                [req.user.id, result.lastInsertId, 'create_report', req.ip || 'unknown']
            );

            res.status(201).json({
                success: true,
                message: 'Reporte creado exitosamente',
                data: { id: result.lastInsertId, name, description, embed_url, category }
            });
        } catch (error) {
            console.error('Error al crear reporte:', error);
            res.status(500).json({ success: false, message: 'Error al crear reporte' });
        }
    }

    // Actualizar reporte
    static async updateReport(req, res) {
        try {
            const { id } = req.params;
            const { name, description, embed_url, category, is_active } = req.body;

            const report = await db.queryOne('SELECT id FROM reports WHERE id = ?', [id]);
            if (!report) {
                return res.status(404).json({ success: false, message: 'Reporte no encontrado' });
            }

            const updates = [];
            const values = [];

            if (name !== undefined)        { updates.push('name = ?');        values.push(name); }
            if (description !== undefined) { updates.push('description = ?'); values.push(description); }
            if (embed_url !== undefined)   { updates.push('embed_url = ?');   values.push(embed_url); }
            if (category !== undefined)    { updates.push('category = ?');    values.push(category); }
            if (is_active !== undefined)   { updates.push('is_active = ?');   values.push(is_active ? 1 : 0); }

            if (updates.length === 0) {
                return res.status(400).json({ success: false, message: 'No hay campos para actualizar' });
            }

            values.push(id);
            await db.execute(
                `UPDATE reports SET ${updates.join(', ')} WHERE id = ?`,
                values
            );

            await db.execute(
                'INSERT INTO access_logs (user_id, report_id, action, ip_address) VALUES (?, ?, ?, ?)',
                [req.user.id, id, 'update_report', req.ip || 'unknown']
            );

            res.json({ success: true, message: 'Reporte actualizado exitosamente' });
        } catch (error) {
            console.error('Error al actualizar reporte:', error);
            res.status(500).json({ success: false, message: 'Error al actualizar reporte' });
        }
    }

    // Eliminar reporte
    static async deleteReport(req, res) {
        try {
            const { id } = req.params;

            const report = await db.queryOne('SELECT name FROM reports WHERE id = ?', [id]);
            if (!report) {
                return res.status(404).json({ success: false, message: 'Reporte no encontrado' });
            }

            await db.execute('DELETE FROM reports WHERE id = ?', [id]);

            await db.execute(
                'INSERT INTO access_logs (user_id, action, ip_address) VALUES (?, ?, ?)',
                [req.user.id, `delete_report:${report.name}`, req.ip || 'unknown']
            );

            res.json({ success: true, message: 'Reporte eliminado exitosamente' });
        } catch (error) {
            console.error('Error al eliminar reporte:', error);
            res.status(500).json({ success: false, message: 'Error al eliminar reporte' });
        }
    }

    // Obtener estadísticas de acceso
    static async getReportStats(req, res) {
        try {
            const { id } = req.params;

            const report = await db.queryOne('SELECT name FROM reports WHERE id = ?', [id]);
            if (!report) {
                return res.status(404).json({ success: false, message: 'Reporte no encontrado' });
            }

            const stats = await db.queryOne(`
                SELECT
                    COUNT(DISTINCT user_id) as unique_users,
                    COUNT(*) as total_views,
                    MAX(timestamp) as last_accessed
                FROM access_logs
                WHERE report_id = ? AND action = 'view_report'
            `, [id]);

            const recentAccess = await db.query(`
                SELECT u.username, u.full_name, l.timestamp
                FROM access_logs l
                JOIN users u ON l.user_id = u.id
                WHERE l.report_id = ? AND l.action = 'view_report'
                ORDER BY l.timestamp DESC
                LIMIT 10
            `, [id]);

            res.json({
                success: true,
                data: { report_name: report.name, stats, recentAccess }
            });
        } catch (error) {
            console.error('Error al obtener estadísticas:', error);
            res.status(500).json({ success: false, message: 'Error al obtener estadísticas' });
        }
    }
}

module.exports = ReportController;
