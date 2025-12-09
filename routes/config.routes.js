const express = require('express');
const router = express.Router();
const configController = require('../controllers/config.controller');
const { authMiddleware, adminMiddleware } = require('../middleware/auth.middleware');

// Ruta pública - obtener configuración pública (sin auth)
router.get('/public', configController.getPublicConfig);

// Rutas protegidas (solo admin)
router.get('/', authMiddleware, adminMiddleware, configController.getAllConfig);
router.put('/:key', authMiddleware, adminMiddleware, configController.updateConfig);

module.exports = router;
