const express = require('express');
const router = express.Router();
const PermissionController = require('../controllers/permission.controller');
const { authMiddleware, adminMiddleware } = require('../middleware/auth.middleware');

router.get('/matrix', authMiddleware, adminMiddleware, PermissionController.getPermissionsMatrix);
router.post('/users/:userId/reports/:reportId', authMiddleware, adminMiddleware, PermissionController.assignPermission);
router.delete('/users/:userId/reports/:reportId', authMiddleware, adminMiddleware, PermissionController.removePermission);
router.post('/bulk-assign', authMiddleware, adminMiddleware, PermissionController.bulkAssignPermissions);
router.post('/clone', authMiddleware, adminMiddleware, PermissionController.clonePermissions);

module.exports = router;