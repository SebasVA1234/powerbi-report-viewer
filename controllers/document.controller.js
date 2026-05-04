const db = require('../config/db');

class DocumentController {
    // Documentos disponibles para el usuario actual
    static async getMyDocuments(req, res) {
        try {
            const userId = req.user.id;
            const isAdmin = req.user.role === 'admin';

            let documents;
            if (isAdmin) {
                documents = await db.query(`
                    SELECT
                        d.id, d.name, d.description, d.category,
                        d.file_name, d.mime_type, d.file_size, d.is_active,
                        d.created_at, d.updated_at,
                        1 as can_view
                    FROM documents d
                    WHERE d.is_active = 1
                    ORDER BY d.category, d.name
                `);
            } else {
                documents = await db.query(`
                    SELECT
                        d.id, d.name, d.description, d.category,
                        d.file_name, d.mime_type, d.file_size, d.is_active, d.created_at,
                        p.can_view, p.granted_at
                    FROM documents d
                    INNER JOIN user_document_permissions p ON d.id = p.document_id
                    WHERE p.user_id = ? AND d.is_active = 1 AND p.can_view = 1
                    ORDER BY d.category, d.name
                `, [userId]);
            }

            await db.execute(
                'INSERT INTO access_logs (user_id, action, ip_address) VALUES (?, ?, ?)',
                [userId, 'view_documents_list', req.ip || 'unknown']
            );

            res.json({ success: true, data: { documents, total: documents.length } });
        } catch (error) {
            console.error('Error al obtener documentos:', error);
            res.status(500).json({ success: false, message: 'Error al obtener documentos' });
        }
    }

    // Todos los documentos (admin)
    static async getAllDocuments(req, res) {
        try {
            const { page = 1, limit = 20, search = '', category = '' } = req.query;
            const offset = (page - 1) * limit;

            let baseSql = `
                SELECT
                    d.id, d.name, d.description, d.category,
                    d.file_name, d.mime_type, d.file_size, d.is_active,
                    d.created_at, d.updated_at,
                    COUNT(p.user_id) as users_with_access
                FROM documents d
                LEFT JOIN user_document_permissions p ON d.id = p.document_id
            `;

            const conditions = [];
            const params = [];

            if (search) {
                conditions.push('(d.name LIKE ? OR d.description LIKE ?)');
                const sp = `%${search}%`;
                params.push(sp, sp);
            }
            if (category) {
                conditions.push('d.category = ?');
                params.push(category);
            }
            if (conditions.length > 0) {
                baseSql += ' WHERE ' + conditions.join(' AND ');
            }
            baseSql += ' GROUP BY d.id';

            const countQuery = `SELECT COUNT(*) as total FROM (${baseSql}) AS sub`;
            const totalRow = await db.queryOne(countQuery, params);
            const total = Number(totalRow.total);

            const listSql = baseSql + ' ORDER BY d.created_at DESC LIMIT ? OFFSET ?';
            const documents = await db.query(
                listSql,
                [...params, parseInt(limit), parseInt(offset)]
            );

            const cats = await db.query(
                'SELECT DISTINCT category FROM documents WHERE category IS NOT NULL ORDER BY category'
            );
            const categories = cats.map(r => r.category);

            res.json({
                success: true,
                data: {
                    documents,
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
            console.error('Error al obtener todos los documentos:', error);
            res.status(500).json({ success: false, message: 'Error al obtener documentos' });
        }
    }

    // Metadatos de un documento
    static async getDocumentById(req, res) {
        try {
            const { id } = req.params;
            const userId = req.user.id;
            const isAdmin = req.user.role === 'admin';

            let document;
            if (isAdmin) {
                document = await db.queryOne(`
                    SELECT id, name, description, category, file_name, mime_type, file_size,
                           is_active, created_at, updated_at
                    FROM documents WHERE id = ?
                `, [id]);
            } else {
                document = await db.queryOne(`
                    SELECT d.id, d.name, d.description, d.category, d.file_name, d.mime_type,
                           d.file_size, d.is_active, d.created_at, p.can_view
                    FROM documents d
                    INNER JOIN user_document_permissions p ON d.id = p.document_id
                    WHERE d.id = ? AND p.user_id = ? AND p.can_view = 1 AND d.is_active = 1
                `, [id, userId]);
            }

            if (!document) {
                return res.status(404).json({
                    success: false,
                    message: 'Documento no encontrado o sin permisos'
                });
            }

            if (isAdmin) {
                document.users_with_access = await db.query(`
                    SELECT u.id, u.username, u.full_name, p.can_view, p.granted_at
                    FROM user_document_permissions p
                    JOIN users u ON p.user_id = u.id
                    WHERE p.document_id = ?
                `, [id]);
            }

            res.json({ success: true, data: { document } });
        } catch (error) {
            console.error('Error al obtener documento:', error);
            res.status(500).json({ success: false, message: 'Error al obtener documento' });
        }
    }

    // Stream del PDF (renderizado seguro, no descarga)
    static async streamDocument(req, res) {
        try {
            const { id } = req.params;
            const userId = req.user.id;
            const isAdmin = req.user.role === 'admin';

            let row;
            if (isAdmin) {
                row = await db.queryOne(`
                    SELECT file_data, mime_type, file_name, is_active
                    FROM documents WHERE id = ?
                `, [id]);
            } else {
                row = await db.queryOne(`
                    SELECT d.file_data, d.mime_type, d.file_name, d.is_active
                    FROM documents d
                    INNER JOIN user_document_permissions p ON d.id = p.document_id
                    WHERE d.id = ? AND p.user_id = ? AND p.can_view = 1
                `, [id, userId]);
            }

            if (!row || !row.is_active) {
                return res.status(404).json({
                    success: false,
                    message: 'Documento no encontrado o sin permisos'
                });
            }

            await db.execute(
                'INSERT INTO access_logs (user_id, document_id, action, ip_address, user_agent) VALUES (?, ?, ?, ?, ?)',
                [userId, id, 'view_document', req.ip || 'unknown', req.get('user-agent') || '']
            );

            res.setHeader('Content-Type', row.mime_type || 'application/pdf');
            res.setHeader('Content-Disposition', 'inline; filename="documento.pdf"');
            res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('X-Content-Type-Options', 'nosniff');
            res.setHeader('X-Frame-Options', 'SAMEORIGIN');

            // file_data viene como Buffer en ambos drivers (BLOB de SQLite, BYTEA de PG).
            res.end(row.file_data);
        } catch (error) {
            console.error('Error al transmitir documento:', error);
            res.status(500).json({ success: false, message: 'Error al cargar documento' });
        }
    }

    // Crear/subir nuevo documento (admin)
    static async createDocument(req, res) {
        try {
            const { name, description, category } = req.body;
            const file = req.file;
            const uploadedBy = req.user.id;

            if (!file) {
                return res.status(400).json({ success: false, message: 'No se recibió ningún archivo' });
            }
            if (file.mimetype !== 'application/pdf') {
                return res.status(400).json({ success: false, message: 'Solo se permiten archivos PDF' });
            }
            if (!name) {
                return res.status(400).json({ success: false, message: 'El nombre del documento es requerido' });
            }

            const result = await db.execute(
                `INSERT INTO documents (name, description, category, file_name, mime_type, file_size, file_data, uploaded_by)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    name,
                    description || '',
                    category || null,
                    file.originalname,
                    file.mimetype,
                    file.size,
                    file.buffer,        // Buffer — pg lo serializa a BYTEA, sqlite a BLOB
                    uploadedBy
                ]
            );

            await db.execute(
                'INSERT INTO access_logs (user_id, document_id, action, ip_address) VALUES (?, ?, ?, ?)',
                [uploadedBy, result.lastInsertId, 'create_document', req.ip || 'unknown']
            );

            res.status(201).json({
                success: true,
                message: 'Documento subido exitosamente',
                data: {
                    id: result.lastInsertId,
                    name,
                    description,
                    category,
                    file_name: file.originalname,
                    file_size: file.size
                }
            });
        } catch (error) {
            console.error('Error al crear documento:', error);
            res.status(500).json({ success: false, message: 'Error al crear documento' });
        }
    }

    // Actualizar metadatos
    static async updateDocument(req, res) {
        try {
            const { id } = req.params;
            const { name, description, category, is_active } = req.body;

            const existing = await db.queryOne('SELECT id FROM documents WHERE id = ?', [id]);
            if (!existing) {
                return res.status(404).json({ success: false, message: 'Documento no encontrado' });
            }

            const updates = [];
            const values = [];

            if (name !== undefined)        { updates.push('name = ?');        values.push(name); }
            if (description !== undefined) { updates.push('description = ?'); values.push(description); }
            if (category !== undefined)    { updates.push('category = ?');    values.push(category); }
            if (is_active !== undefined)   { updates.push('is_active = ?');   values.push(is_active ? 1 : 0); }

            if (updates.length === 0) {
                return res.status(400).json({ success: false, message: 'No hay campos para actualizar' });
            }

            updates.push('updated_at = CURRENT_TIMESTAMP');
            values.push(id);

            await db.execute(
                `UPDATE documents SET ${updates.join(', ')} WHERE id = ?`,
                values
            );

            await db.execute(
                'INSERT INTO access_logs (user_id, document_id, action, ip_address) VALUES (?, ?, ?, ?)',
                [req.user.id, id, 'update_document', req.ip || 'unknown']
            );

            res.json({ success: true, message: 'Documento actualizado exitosamente' });
        } catch (error) {
            console.error('Error al actualizar documento:', error);
            res.status(500).json({ success: false, message: 'Error al actualizar documento' });
        }
    }

    // Eliminar documento
    static async deleteDocument(req, res) {
        try {
            const { id } = req.params;

            const document = await db.queryOne('SELECT name FROM documents WHERE id = ?', [id]);
            if (!document) {
                return res.status(404).json({ success: false, message: 'Documento no encontrado' });
            }

            await db.execute('DELETE FROM documents WHERE id = ?', [id]);

            await db.execute(
                'INSERT INTO access_logs (user_id, action, ip_address) VALUES (?, ?, ?)',
                [req.user.id, `delete_document:${document.name}`, req.ip || 'unknown']
            );

            res.json({ success: true, message: 'Documento eliminado exitosamente' });
        } catch (error) {
            console.error('Error al eliminar documento:', error);
            res.status(500).json({ success: false, message: 'Error al eliminar documento' });
        }
    }
}

module.exports = DocumentController;
