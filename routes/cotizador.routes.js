const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/cotizador.controller');
const { authMiddleware } = require('../middleware/auth.middleware');
const { requirePermission } = require('../controllers/rbac.controller');

// PR-1b: las acciones del cotizador exigen el permiso 'cotizador.use'.
// Admin (system.admin), gerencia, jefe_innovacion y los jefes de área
// lo tienen por default. Empleados regulares no — el admin lo asigna
// explicito al user/depto/rol que lo necesite.

// Catálogos para los dropdowns: lectura amplia, sin gating (necesarios
// para la UI; no exponen información sensible).
router.get('/destinos',  authMiddleware, ctrl.listDestinos);
router.get('/cargueras', authMiddleware, ctrl.listCargueras);

// Cálculo (sin guardar) — gateado.
router.post('/cotizar', authMiddleware, requirePermission('cotizador.use'), ctrl.calcular);

// Calcular Y guardar snapshot — gateado.
router.post('/cotizaciones', authMiddleware, requirePermission('cotizador.use'), ctrl.guardarCotizacion);

// Histórico — gateado. (Admin sigue viendo el de todos por la lógica
// interna del controller; non-admin con cotizador.use ve el suyo.)
router.get('/cotizaciones', authMiddleware, requirePermission('cotizador.use'), ctrl.listarCotizaciones);

module.exports = router;
