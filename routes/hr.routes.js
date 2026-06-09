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
const multer = require('multer');
const router = express.Router();
const { authMiddleware } = require('../middleware/auth.middleware');
const { requirePermission } = require('../controllers/rbac.controller');
const HrController = require('../controllers/hr.controller');
const HrMemosController = require('../controllers/hr_memos.controller');
const PayrollController = require('../controllers/payroll.controller');

// F1: límite y tipos permitidos para los justificativos de time-off.
const TIMEOFF_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024; // 10 MB (x-max-bytes de la spec)
const TIMEOFF_ATTACHMENT_MIME = ['application/pdf', 'image/png', 'image/jpeg'];

// Multer en memoria: el adjunto se persiste al volumen vía storage_key (NO BLOB).
// fileFilter rechaza tipos no permitidos; el límite de tamaño dispara
// LIMIT_FILE_SIZE que el handler de errores traduce a 413.
const timeoffUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: TIMEOFF_ATTACHMENT_MAX_BYTES },
    fileFilter: (req, file, cb) => {
        if (TIMEOFF_ATTACHMENT_MIME.includes(file.mimetype)) {
            cb(null, true);
        } else {
            // Marcamos el error para que el handler responda 415 (no 400 genérico).
            const err = new Error('Tipo de archivo no permitido (solo PDF/PNG/JPEG)');
            err.code = 'UNSUPPORTED_MEDIA_TYPE';
            cb(err);
        }
    }
});

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

// PR-3a: backfill — crea hr_employees para los users que no lo tienen.
// Útil para usuarios creados antes de la auto-creación, o cuando el INSERT
// del trigger en createUser falló silenciosamente.
router.post('/employees/sync-from-users',
    authMiddleware, requirePermission('hr.write'), HrController.syncEmployeesFromUsers);

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

// PR-3c + F1: Solicitudes de tiempo libre con firma + aprobación multinivel + adjuntos.
//   - listar: cualquier user logueado (la visibilidad la filtra el controller).
//   - crear+firmar: hr.timeoff.request (el propio empleado; RRHH/admin por otro).
//   - adjuntar justificativo: hr.timeoff.request (dueño o RRHH); multipart 'file'.
//   - aprobar / rechazar: hr.timeoff.approve (el nivel jefe/tthh lo decide el controller).
//   - decidir descuento (waive): hr.timeoff.waive_discount (EXCLUSIVO TTHH/gerencia).
//   - cancelar: el dueño de la solicitud O quien tenga hr.timeoff.approve.
//   - historial: cualquier user logueado dentro de su scope de visibilidad.
router.get('/time-off',                  authMiddleware, HrController.listTimeOffRequests);
router.post('/time-off',
    authMiddleware, requirePermission('hr.timeoff.request'), HrController.crearSolicitudFirmada);
router.post('/time-off/:id/attachment',
    authMiddleware, requirePermission('hr.timeoff.request'),
    timeoffUpload.single('file'), HrController.subirJustificativo);
router.post('/time-off/:id/approve',
    authMiddleware, requirePermission('hr.timeoff.approve'), HrController.aprobarSolicitud);
router.post('/time-off/:id/reject',
    authMiddleware, requirePermission('hr.timeoff.approve'), HrController.rechazarSolicitud);
router.post('/time-off/:id/discount-decision',
    authMiddleware, requirePermission('hr.timeoff.waive_discount'), HrController.decidirDescuento);
router.post('/time-off/:id/cancel',       authMiddleware, HrController.cancelTimeOffRequest);
router.get('/time-off/:id/approval-history', authMiddleware, HrController.obtenerHistorialAprobacion);

// PR-3d: Memos / comunicados a empleados (historial inmutable).
//   - inbox / sent / get: cualquier user logueado (visibilidad en controller).
//   - create: requiere hr.memos.write (RRHH/Gerencia/jefes).
//   - ack: cualquier user logueado puede acusar memos que le competen.
router.get('/memos/inbox',  authMiddleware, requirePermission('hr.memos.read'), HrMemosController.listMyInbox);
router.get('/memos/sent',   authMiddleware, requirePermission('hr.memos.read'), HrMemosController.listMySent);
router.get('/memos/:id',    authMiddleware, requirePermission('hr.memos.read'), HrMemosController.getMemo);
router.post('/memos',       authMiddleware, requirePermission('hr.memos.write'), HrMemosController.createMemo);
router.post('/memos/:id/ack', authMiddleware, requirePermission('hr.memos.read'), HrMemosController.acknowledgeMemo);

// ============================================================
// Nómina / Roles de pago (v1.2). Bajo /api/hr/payroll/*.
// La PROYECCIÓN de total_* / todos los renglones la decide hr.payroll.read.all
// DENTRO del controller (no es guard de ruta). Ver _nominaspec_out 13-notes §0.
// ============================================================
router.get('/payroll/params',
    authMiddleware, requirePermission('hr.payroll.read'), PayrollController.listParams);
router.put('/payroll/params/:key',
    authMiddleware, requirePermission('hr.payroll.params.write'), PayrollController.updateParam);
router.get('/payroll/runs',
    authMiddleware, requirePermission('hr.payroll.read'), PayrollController.listRuns);
router.post('/payroll/runs',
    authMiddleware, requirePermission('hr.payroll.run'), PayrollController.generateRun);
router.get('/payroll/runs/:id',
    authMiddleware, requirePermission('hr.payroll.read'), PayrollController.getRun);
router.post('/payroll/runs/:id/finalize',
    authMiddleware, requirePermission('hr.payroll.run'), PayrollController.finalizeRun);
// PDF del rol de un empleado (scope IDOR -> 404 dentro del controller).
router.get('/payroll/runs/:id/employee/:employeeId/pdf',
    authMiddleware, requirePermission('hr.payroll.read'), PayrollController.employeePdf);

// F1: handler de errores de subida (adjuntos de time-off). Traduce los errores
// de multer a los códigos HTTP de la spec: tamaño → 413, tipo no permitido → 415.
// eslint-disable-next-line no-unused-vars
router.use((err, req, res, next) => {
    if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
            return res.status(413).json({ success: false, message: 'El archivo excede el tamaño máximo (10 MB)' });
        }
        return res.status(400).json({ success: false, message: `Error de subida: ${err.message}` });
    }
    if (err && err.code === 'UNSUPPORTED_MEDIA_TYPE') {
        return res.status(415).json({ success: false, message: err.message });
    }
    if (err) {
        return res.status(400).json({ success: false, message: err.message || 'Error al procesar el archivo' });
    }
    next();
});

module.exports = router;
