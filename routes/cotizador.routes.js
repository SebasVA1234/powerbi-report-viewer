const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/cotizador.controller');
const { authMiddleware } = require('../middleware/auth.middleware');

// Catálogos para los dropdowns del frontend (todos los usuarios autenticados)
router.get('/destinos',  authMiddleware, ctrl.listDestinos);
router.get('/cargueras', authMiddleware, ctrl.listCargueras);

// Cálculo (sin guardar)
router.post('/cotizar', authMiddleware, ctrl.calcular);

// Calcular Y guardar snapshot
router.post('/cotizaciones', authMiddleware, ctrl.guardarCotizacion);

// Histórico
router.get('/cotizaciones', authMiddleware, ctrl.listarCotizaciones);

module.exports = router;
