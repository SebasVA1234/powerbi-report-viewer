const express = require('express');
const multer = require('multer');
const router = express.Router();
const DocumentController = require('../controllers/document.controller');
const { authMiddleware, adminMiddleware } = require('../middleware/auth.middleware');

// Multer en memoria: el BLOB se escribe directo a SQLite
const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 50 * 1024 * 1024 // 50 MB máximo
    },
    fileFilter: (req, file, cb) => {
        if (file.mimetype === 'application/pdf') {
            cb(null, true);
        } else {
            cb(new Error('Solo se permiten archivos PDF'));
        }
    }
});

// Rutas para usuarios logueados
router.get('/my-documents', authMiddleware, DocumentController.getMyDocuments);
router.get('/:id', authMiddleware, DocumentController.getDocumentById);
router.get('/:id/stream', authMiddleware, DocumentController.streamDocument);

// Rutas de ADMINISTRADOR
router.get('/', authMiddleware, adminMiddleware, DocumentController.getAllDocuments);
router.post('/', authMiddleware, adminMiddleware, upload.single('file'), DocumentController.createDocument);
router.put('/:id', authMiddleware, adminMiddleware, DocumentController.updateDocument);
router.delete('/:id', authMiddleware, adminMiddleware, DocumentController.deleteDocument);

// Handler específico para errores de multer (archivo muy grande, tipo inválido, etc.)
router.use((err, req, res, next) => {
    if (err instanceof multer.MulterError) {
        return res.status(400).json({
            success: false,
            message: err.code === 'LIMIT_FILE_SIZE'
                ? 'El archivo excede el tamaño máximo (50 MB)'
                : `Error de subida: ${err.message}`
        });
    }
    if (err) {
        return res.status(400).json({
            success: false,
            message: err.message || 'Error al procesar el archivo'
        });
    }
    next();
});

module.exports = router;
