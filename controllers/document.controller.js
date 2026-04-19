const db = require('../config/database');

class DocumentController {
    // Obtener documentos disponibles para el usuario actual
    static getMyDocuments(req, res) {
        try {
            const userId = req.user.id;
            const isAdmin = req.user.role === 'admin';

            let documents;

            if (isAdmin) {
                // Los admins pueden ver todos los documentos activos (sin el BLOB)
                documents = db.prepare(`
                    SELECT
                        d.id,
                        d.name,
                        d.description,
                        d.category,
                        d.file_name,
                        d.mime_type,
                        d.file_size,
                        d.is_active,
                        d.created_at,
                        d.updated_at,
                        1 as can_view
                    FROM documents d
                    WHERE d.is_active = 1
                    ORDER BY d.category, d.name
                `).all();
            } else {
                // Los usuarios solo ven los documentos asignados
                documents = db.prepare(`
                    SELECT
                        d.id,
                        d.name,
                        d.description,
                        d.category,
                        d.file_name,
                        d.mime_type,
                        d.file_size,
                        d.is_active,
                        d.created_at,
                        p.can_view,
                        p.granted_at
                    FROM documents d
                    INNER JOIN user_document_permissions p ON d.id = p.document_id
                    WHERE p.user_id = ? AND d.is_active = 1 AND p.can_view = 1
                    ORDER BY d.category, d.name
                `).all(userId);
            }

            // Registrar acceso
            db.prepare(`
                INSERT INTO access_logs (user_id, action, ip_address)
                VALUES (?, ?, ?)
            `).run(userId, 'view_documents_list', req.ip || 'unknown');

            res.json({
                success: true,
                data: {
                    documents,
                    total: documents.length
                }
            });
        } catch (error) {
            console.error('Error al obtener documentos:', error);
            res.status(500).json({
                success: false,
                message: 'Error al obtener documentos'
            });
        }
    }

    // Obtener todos los documentos (solo admin)
    static getAllDocuments(req, res) {
        try {
            const { page = 1, limit = 20, search = '', category = '' } = req.query;
            const offset = (page - 1) * limit;

            let query = `
                SELECT
                    d.id,
                    d.name,
                    d.description,
                    d.category,
                    d.file_name,
                    d.mime_type,
                    d.file_size,
                    d.is_active,
                    d.created_at,
                    d.updated_at,
                    COUNT(p.user_id) as users_with_access
                FROM documents d
                LEFT JOIN user_document_permissions p ON d.id = p.document_id
            `;

            const conditions = [];
            const params = [];

            if (search) {
                conditions.push('(d.name LIKE ? OR d.description LIKE ?)');
                const searchPattern = `%${search}%`;
                params.push(searchPattern, searchPattern);
            }

            if (category) {
                conditions.push('d.category = ?');
                params.push(category);
            }

            if (conditions.length > 0) {
                query += ' WHERE ' + conditions.join(' AND ');
            }

            query += ' GROUP BY d.id';

            // Total (sin paginación)
            const countQuery = `SELECT COUNT(*) as total FROM (${query})`;
            const totalResult = db.prepare(countQuery).get(...params);
            const total = totalResult.total;

            query += ' ORDER BY d.created_at DESC LIMIT ? OFFSET ?';
            params.push(parseInt(limit), parseInt(offset));

            const documents = db.prepare(query).all(...params);

            const categories = db.prepare(`
                SELECT DISTINCT category FROM documents WHERE category IS NOT NULL ORDER BY category
            `).all().map(row => row.category);

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
            res.status(500).json({
                success: false,
                message: 'Error al obtener documentos'
            });
        }
    }

    // Obtener metadatos de un documento
    static getDocumentById(req, res) {
        try {
            const { id } = req.params;
            const userId = req.user.id;
            const isAdmin = req.user.role === 'admin';

            let document;

            if (isAdmin) {
                document = db.prepare(`
                    SELECT id, name, description, category, file_name, mime_type, file_size, is_active, created_at, updated_at
                    FROM documents WHERE id = ?
                `).get(id);
            } else {
                document = db.prepare(`
                    SELECT d.id, d.name, d.description, d.category, d.file_name, d.mime_type, d.file_size, d.is_active, d.created_at, p.can_view
                    FROM documents d
                    INNER JOIN user_document_permissions p ON d.id = p.document_id
                    WHERE d.id = ? AND p.user_id = ? AND p.can_view = 1 AND d.is_active = 1
                `).get(id, userId);
            }

            if (!document) {
                return res.status(404).json({
                    success: false,
                    message: 'Documento no encontrado o sin permisos'
                });
            }

            if (isAdmin) {
                document.users_with_access = db.prepare(`
                    SELECT u.id, u.username, u.full_name, p.can_view, p.granted_at
                    FROM user_document_permissions p
                    JOIN users u ON p.user_id = u.id
                    WHERE p.document_id = ?
                `).all(id);
            }

            res.json({
                success: true,
                data: { document }
            });
        } catch (error) {
            console.error('Error al obtener documento:', error);
            res.status(500).json({
                success: false,
                message: 'Error al obtener documento'
            });
        }
    }

    // Stream del PDF (renderizado seguro, no descarga)
    // IMPORTANTE: Se envía con Content-Disposition: inline y cabeceras
    // que desaniman la descarga/caché. PDF.js lo consume como ArrayBuffer.
    static streamDocument(req, res) {
        try {
            const { id } = req.params;
            const userId = req.user.id;
            const isAdmin = req.user.role === 'admin';

            let row;

            if (isAdmin) {
                row = db.prepare(`
                    SELECT file_data, mime_type, file_name, is_active
                    FROM documents WHERE id = ?
                `).get(id);
            } else {
                row = db.prepare(`
                    SELECT d.file_data, d.mime_type, d.file_name, d.is_active
                    FROM documents d
                    INNER JOIN user_document_permissions p ON d.id = p.document_id
                    WHERE d.id = ? AND p.user_id = ? AND p.can_view = 1
                `).get(id, userId);
            }

            if (!row || !row.is_active) {
                return res.status(404).json({
                    success: false,
                    message: 'Documento no encontrado o sin permisos'
                });
            }

            // Registrar visualización
            db.prepare(`
                INSERT INTO access_logs (user_id, document_id, action, ip_address, user_agent)
                VALUES (?, ?, ?, ?, ?)
            `).run(userId, id, 'view_document', req.ip || 'unknown', req.get('user-agent') || '');

            // Cabeceras que desaniman descarga/caché
            res.setHeader('Content-Type', row.mime_type || 'application/pdf');
            res.setHeader('Content-Disposition', 'inline; filename="documento.pdf"');
            res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('X-Content-Type-Options', 'nosniff');
            res.setHeader('X-Frame-Options', 'SAMEORIGIN');

            // Enviar el BLOB directamente
            res.end(row.file_data);
        } catch (error) {
            console.error('Error al transmitir documento:', error);
            res.status(500).json({
                success: false,
                message: 'Error al cargar documento'
            });
        }
    }

    // Crear/subir nuevo documento (admin)
    static createDocument(req, res) {
        try {
            const { name, description, category } = req.body;
            const file = req.file;
            const uploadedBy = req.user.id;

            if (!file) {
                return res.status(400).json({
                    success: false,
                    message: 'No se recibió ningún archivo'
                });
            }

            if (file.mimetype !== 'application/pdf') {
                return res.status(400).json({
                    success: false,
                    message: 'Solo se permiten archivos PDF'
                });
            }

            if (!name) {
                return res.status(400).json({
                    success: false,
                    message: 'El nombre del documento es requerido'
                });
            }

            const result = db.prepare(`
                INSERT INTO documents (name, description, category, file_name, mime_type, file_size, file_data, uploaded_by)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
                name,
                description || '',
                category || null,
                file.originalname,
                file.mimetype,
                file.size,
                file.buffer,
                uploadedBy
            );

            db.prepare(`
                INSERT INTO access_logs (user_id, document_id, action, ip_address)
                VALUES (?, ?, ?, ?)
            `).run(uploadedBy, result.lastInsertRowid, 'create_document', req.ip || 'unknown');

            res.status(201).json({
                success: true,
                message: 'Documento subido exitosamente',
                data: {
                    id: result.lastInsertRowid,
                    name,
                    description,
                    category,
                    file_name: file.originalname,
                    file_size: file.size
                }
            });
        } catch (error) {
            console.error('Error al crear documento:', error);
            res.status(500).json({
                success: false,
                message: 'Error al crear documento'
            });
        }
    }

    // Actualizar metadatos del documento (admin)
    // Nota: no se permite reemplazar el PDF por aquí para mantener trazabilidad.
    static updateDocument(req, res) {
        try {
            const { id } = req.params;
            const { name, description, category, is_active } = req.body;

            const existing = db.prepare('SELECT id FROM documents WHERE id = ?').get(id);
            if (!existing) {
                return res.status(404).json({
                    success: false,
                    message: 'Documento no encontrado'
                });
            }

            const updates = [];
            const values = [];

            if (name !== undefined) { updates.push('name = ?'); values.push(name); }
            if (description !== undefined) { updates.push('description = ?'); values.push(description); }
            if (category !== undefined) { updates.push('category = ?'); values.push(category); }
            if (is_active !== undefined) { updates.push('is_active = ?'); values.push(is_active ? 1 : 0); }

            if (updates.length === 0) {
                return res.status(400).json({
                    success: false,
                    message: 'No hay campos para actualizar'
                });
            }

            updates.push('updated_at = CURRENT_TIMESTAMP');
            values.push(id);

            db.prepare(`UPDATE documents SET ${updates.join(', ')} WHERE id = ?`).run(...values);

            db.prepare(`
                INSERT INTO access_logs (user_id, document_id, action, ip_address)
                VALUES (?, ?, ?, ?)
            `).run(req.user.id, id, 'update_document', req.ip || 'unknown');

            res.json({
                success: true,
                message: 'Documento actualizado exitosamente'
            });
        } catch (error) {
            console.error('Error al actualizar documento:', error);
            res.status(500).json({
                success: false,
                message: 'Error al actualizar documento'
            });
        }
    }

    // Eliminar documento (admin)
    static deleteDocument(req, res) {
        try {
            const { id } = req.params;

            const document = db.prepare('SELECT name FROM documents WHERE id = ?').get(id);
            if (!document) {
                return res.status(404).json({
                    success: false,
                    message: 'Documento no encontrado'
                });
            }

            db.prepare('DELETE FROM documents WHERE id = ?').run(id);

            db.prepare(`
                INSERT INTO access_logs (user_id, action, ip_address)
                VALUES (?, ?, ?)
            `).run(req.user.id, `delete_document:${document.name}`, req.ip || 'unknown');

            res.json({
                success: true,
                message: 'Documento eliminado exitosamente'
            });
        } catch (error) {
            console.error('Error al eliminar documento:', error);
            res.status(500).json({
                success: false,
                message: 'Error al eliminar documento'
            });
        }
    }
}

module.exports = DocumentController;
