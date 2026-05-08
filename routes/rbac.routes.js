/**
 * RBAC routes (PR-1a)
 *
 * Bajo /api/rbac. Lectura: cualquier user logueado puede listar roles,
 * permisos, departamentos y su propio contexto. Escritura: requiere
 * permisos explícitos (departments.manage, roles.manage, users.read);
 * `requirePermission` deja pasar a admin (con system.admin) siempre.
 */
const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/auth.middleware');
const { RbacController, requirePermission } = require('../controllers/rbac.controller');

// Lecturas
router.get('/roles',           authMiddleware, RbacController.listRoles);
router.get('/permissions',     authMiddleware, RbacController.listPermissions);
router.get('/departments',     authMiddleware, RbacController.listDepartments);
router.get('/me/context',      authMiddleware, RbacController.myContext);
router.get('/users/:id/context',
    authMiddleware, requirePermission('users.read'), RbacController.getUserContextById);

// Departamentos (escritura)
router.post('/departments',
    authMiddleware, requirePermission('departments.manage'), RbacController.createDepartment);
router.put('/departments/:id',
    authMiddleware, requirePermission('departments.manage'), RbacController.updateDepartment);
router.post('/departments/:id/archive',
    authMiddleware, requirePermission('departments.manage'), RbacController.archiveDepartment);

// Asignación user ↔ rol
router.post('/users/:userId/roles/:roleCode',
    authMiddleware, requirePermission('roles.manage'), RbacController.assignRoleToUser);
router.delete('/users/:userId/roles/:roleCode',
    authMiddleware, requirePermission('roles.manage'), RbacController.removeRoleFromUser);

// Asignación user ↔ departamento
router.post('/users/:userId/departments/:deptId',
    authMiddleware, requirePermission('departments.manage'), RbacController.assignUserToDepartment);
router.delete('/users/:userId/departments/:deptId',
    authMiddleware, requirePermission('departments.manage'), RbacController.removeUserFromDepartment);

// PR-1b: Resource ACL — asignar reportes/documentos a user / departamento / rol.
//   Body de createAcl: { resource_type, resource_id, principal_type, principal_id, actions? }
router.post('/acl',
    authMiddleware, requirePermission('permissions.manage'), RbacController.createAcl);
router.delete('/acl/:id',
    authMiddleware, requirePermission('permissions.manage'), RbacController.deleteAcl);
router.get('/acl/resource/:type/:id',
    authMiddleware, requirePermission('permissions.manage'), RbacController.listAclsForResource);
router.get('/acl/principal/:type/:id',
    authMiddleware, requirePermission('permissions.manage'), RbacController.listAclsForPrincipal);

// PR-1c: Categorías de reportes y documentos.
//   GET /categories?type=report|document&include_archived=0|1   listar
//   POST /categories                                            crear (categories.manage)
//   PUT /categories/:id                                         editar
//   POST /categories/:id/archive                                soft-delete
router.get('/categories',                authMiddleware,                                       RbacController.listCategories);
router.post('/categories',               authMiddleware, requirePermission('categories.manage'), RbacController.createCategory);
router.put('/categories/:id',            authMiddleware, requirePermission('categories.manage'), RbacController.updateCategory);
router.post('/categories/:id/archive',   authMiddleware, requirePermission('categories.manage'), RbacController.archiveCategory);

module.exports = router;
