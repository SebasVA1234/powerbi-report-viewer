const express = require('express');
const router = express.Router();
const PermissionController = require('../controllers/permission.controller');
const { authMiddleware, adminMiddleware } = require('../middleware/auth.middleware');

// ==== Permisos de REPORTES ====
router.get('/matrix', authMiddleware, adminMiddleware, PermissionController.getPermissionsMatrix);
router.post('/users/:userId/reports/:reportId', authMiddleware, adminMiddleware, PermissionController.assignPermission);
router.delete('/users/:userId/reports/:reportId', authMiddleware, adminMiddleware, PermissionController.removePermission);
router.post('/bulk-assign', authMiddleware, adminMiddleware, PermissionController.bulkAssignPermissions);
router.post('/clone', authMiddleware, adminMiddleware, PermissionController.clonePermissions);

// ==== Permisos de DOCUMENTOS ====
router.get('/documents/matrix', authMiddleware, adminMiddleware, PermissionController.getDocumentsPermissionsMatrix);
router.post('/users/:userId/documents/:documentId', authMiddleware, adminMiddleware, PermissionController.assignDocumentPermission);
router.delete('/users/:userId/documents/:documentId', authMiddleware, adminMiddleware, PermissionController.removeDocumentPermission);
router.post('/documents/bulk-assign', authMiddleware, adminMiddleware, PermissionController.bulkAssignDocumentPermissions);

module.exports = router;
