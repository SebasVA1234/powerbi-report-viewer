/**
 * RRHH routes (PR-3a)
 *
 * Bajo /api/hr. Dos áreas:
 *   /positions/*   perfiles de cargo (lectura abierta logged-in,
 *                  escritura con hr.positions.manage)
 *   /employees/*   empleados (escritura con hr.write,
 *                  lectura filtrada por permisos en el controller)
 *   /me            mi perfil RRHH (cualquier user logueado)
 */
const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/auth.middleware');
const { requirePermission } = require('../controllers/rbac.controller');
const HrController = require('../controllers/hr.controller');

// Perfiles de cargo
router.get('/positions',           authMiddleware, HrController.listPositions);
router.post('/positions',
    authMiddleware, requirePermission('hr.positions.manage'), HrController.createPosition);

// Mi perfil RRHH
router.get('/me',                  authMiddleware, HrController.getMyEmployee);

// Empleados — la lectura filtra por permisos dentro del controller
// (hr.read.own / hr.read.team / hr.read.all). La escritura siempre exige hr.write.
router.get('/employees',           authMiddleware, HrController.listEmployees);
router.get('/employees/:id',       authMiddleware, HrController.getEmployeeById);
router.get('/employees/:id/team',  authMiddleware, HrController.getDirectReports);
router.post('/employees',          authMiddleware, requirePermission('hr.write'), HrController.createEmployee);
router.put('/employees/:id',       authMiddleware, requirePermission('hr.write'), HrController.updateEmployee);
router.delete('/employees/:id',    authMiddleware, requirePermission('hr.write'), HrController.deleteEmployee);

// PR-3b: Calendario de feriados + banco de días compensados.
router.get('/holidays',            authMiddleware, HrController.listHolidays);
router.post('/holidays',
    authMiddleware, requirePermission('hr.holidays.manage'), HrController.createHoliday);
router.delete('/holidays/:id',
    authMiddleware, requirePermission('hr.holidays.manage'), HrController.deleteHoliday);

// Asistencia a feriados (registrar quién trabajó cada feriado).
router.get('/holidays/:id/attendance',  authMiddleware, HrController.listAttendance);
router.post('/holidays/:id/attendance',
    authMiddleware, requirePermission('hr.attendance.manage'), HrController.upsertAttendance);
router.delete('/attendance/:attendanceId',
    authMiddleware, requirePermission('hr.attendance.manage'), HrController.deleteAttendance);

// Saldo del banco de días compensados por empleado.
router.get('/employees/:id/compensated-balance', authMiddleware, HrController.getCompensatedBalance);

// PR-3c: Solicitudes de tiempo libre (vacaciones / permisos / feriado compensado).
//   - listar / crear: cualquier user logueado (la visibilidad la filtra el controller).
//   - aprobar / rechazar: requiere hr.timeoff.approve (jefes y RRHH).
//   - cancelar: el dueño de la solicitud O quien tenga hr.timeoff.approve.
router.get('/time-off',                  authMiddleware, HrController.listTimeOffRequests);
router.post('/time-off',                 authMiddleware, HrController.createTimeOffRequest);
router.post('/time-off/:id/approve',
    authMiddleware, requirePermission('hr.timeoff.approve'), HrController.approveTimeOffRequest);
router.post('/time-off/:id/reject',
    authMiddleware, requirePermission('hr.timeoff.approve'), HrController.rejectTimeOffRequest);
router.post('/time-off/:id/cancel',       authMiddleware, HrController.cancelTimeOffRequest);

module.exports = router;
