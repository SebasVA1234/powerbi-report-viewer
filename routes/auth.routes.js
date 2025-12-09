const express = require('express');
const router = express.Router();
const AuthController = require('../controllers/auth.controller');
// Al usar require así, obtenemos la función directa gracias al cambio en el paso 1
const { authMiddleware } = require('../middleware/auth.middleware');

// Definición de rutas
router.post('/login', AuthController.login);

// Esta era la línea del error (Línea 12 aprox):
// Ahora 'authMiddleware' es una función, no un objeto, así que funcionará.
router.get('/verify', authMiddleware, AuthController.verify);

router.post('/logout', authMiddleware, AuthController.logout);
router.post('/change-password', authMiddleware, AuthController.changePassword);

module.exports = router;