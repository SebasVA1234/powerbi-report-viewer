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

// Cambio obligatorio en el primer login (cuando must_change_password=1).
router.post('/change-my-password', authMiddleware, AuthController.changeMyPassword);

// PR-0b.1: 2FA TOTP.
//   /totp/setup   -> genera secret y QR (no activa).
//   /totp/enable  -> verifica primer código y activa 2FA.
//   /totp/disable -> requiere pass; desactiva.
//   /totp/verify  -> 2do paso del login para users con 2FA activo.
router.post('/totp/setup', authMiddleware, AuthController.setupTotp);
router.post('/totp/enable', authMiddleware, AuthController.enableTotp);
router.post('/totp/disable', authMiddleware, AuthController.disableTotp);
router.post('/totp/verify', authMiddleware, AuthController.verifyTotp);

module.exports = router;