const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/cotizador.controller');
const { authMiddleware } = require('../middleware/auth.middleware');
const { requirePermission } = require('../controllers/rbac.controller');

// PR-finalize-prototype · Cotizador v2.
// Lectura de catálogos: cualquier user con cotizador.use puede ver
// (necesita los dropdowns para cotizar).
// Escritura (CRUD): exige cotizador.tarifas.manage. Admin del sistema lo
// tiene por default; otros roles (gerencia, jefe_innovacion) también.
// Admin puede otorgárselo a cualquier user vía Admin → Permisos avanzados.

const canUse = requirePermission('cotizador.use');
const canManage = requirePermission('cotizador.tarifas.manage');

// ---- Catálogos (lectura) ----
router.get('/airports',    authMiddleware, canUse, ctrl.listAirports);
router.get('/aerolineas',  authMiddleware, canUse, ctrl.listAerolineas);
router.get('/cargueras',   authMiddleware, canUse, ctrl.listCargueras);
router.get('/tarifas',     authMiddleware, canUse, ctrl.listTarifas);
router.get('/tarifas-pais',authMiddleware, canUse, ctrl.listTarifasPais);

// Aliases legacy para no romper a la UI vieja durante la transición.
// (El frontend nuevo usa /airports en vez de /destinos.)
router.get('/destinos',    authMiddleware, canUse, ctrl.listAirports);

// ---- CRUD aeropuertos ----
router.post('/airports',       authMiddleware, canManage, ctrl.createAirport);
router.put('/airports/:id',    authMiddleware, canManage, ctrl.updateAirport);
router.delete('/airports/:id', authMiddleware, canManage, ctrl.deleteAirport);

// ---- CRUD aerolíneas ----
router.post('/aerolineas',       authMiddleware, canManage, ctrl.createAerolinea);
router.put('/aerolineas/:id',    authMiddleware, canManage, ctrl.updateAerolinea);
router.delete('/aerolineas/:id', authMiddleware, canManage, ctrl.deleteAerolinea);

// ---- CRUD cargueras ----
router.post('/cargueras',       authMiddleware, canManage, ctrl.createCarguera);
router.put('/cargueras/:id',    authMiddleware, canManage, ctrl.updateCarguera);
router.delete('/cargueras/:id', authMiddleware, canManage, ctrl.deleteCarguera);

// ---- CRUD tarifas de flete ----
router.post('/tarifas',       authMiddleware, canManage, ctrl.createTarifa);
router.put('/tarifas/:id',    authMiddleware, canManage, ctrl.updateTarifa);
router.delete('/tarifas/:id', authMiddleware, canManage, ctrl.deleteTarifa);

// ---- Costos por país (upsert: si existe → update; si no → create) ----
router.post('/tarifas-pais',  authMiddleware, canManage, ctrl.upsertTarifaPais);

// ---- Audit log (solo manage puede leer la auditoría) ----
router.get('/audit-log',      authMiddleware, canManage, ctrl.listAuditLog);

// ---- Cálculo (sin guardar) ----
router.post('/cotizar',       authMiddleware, canUse, ctrl.calcular);

// ---- PR-5c: PDF inline ----
router.post('/cotizar-pdf',   authMiddleware, canUse, ctrl.cotizarPdf);

// ---- Calcular Y guardar snapshot ----
router.post('/cotizaciones',  authMiddleware, canUse, ctrl.guardarCotizacion);

// ---- Histórico de cotizaciones del user (admin ve todas) ----
router.get('/cotizaciones',   authMiddleware, canUse, ctrl.listarCotizaciones);

module.exports = router;
