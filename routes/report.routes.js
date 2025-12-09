const express = require('express');
const router = express.Router();
const ReportController = require('../controllers/report.controller');
const { authMiddleware, adminMiddleware } = require('../middleware/auth.middleware');

// Rutas para usuarios logueados
router.get('/my-reports', authMiddleware, ReportController.getMyReports);
router.get('/:id', authMiddleware, ReportController.getReportById);

// Rutas de ADMINISTRADOR
router.get('/', authMiddleware, adminMiddleware, ReportController.getAllReports);
router.post('/', authMiddleware, adminMiddleware, ReportController.createReport);
router.put('/:id', authMiddleware, adminMiddleware, ReportController.updateReport); // <--- La ruta de edición
router.delete('/:id', authMiddleware, adminMiddleware, ReportController.deleteReport);
router.get('/:id/stats', authMiddleware, adminMiddleware, ReportController.getReportStats);

module.exports = router;