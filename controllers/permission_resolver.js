/**
 * Permission Resolver (PR-1b)
 *
 * Decide qué recursos puede ver un user dado, considerando:
 *
 *   1. Permisos de rol globales: si tiene 'reports.read.all' o 'system.admin',
 *      ve todos los reports activos (idem documents).
 *   2. Asignaciones legacy (user_report_permissions / user_document_permissions):
 *      siguen vigentes durante la transición hacia el modelo nuevo.
 *   3. ACL nueva (resource_acl): asignación a user, departamento o rol.
 *
 * Las funciones devuelven query fragments listos para usar en SELECT (no
 * arrays de IDs) para no traer toda la lista a memoria — evita problemas
 * de performance cuando hay muchos reports/docs.
 */
const db = require('../config/db');
const { getUserContext } = require('./rbac.controller');

// Devuelve la condición SQL (whereClause + params) que filtra los recursos
// visibles para el user. Para usar como subquery en SELECT.
//
// resourceType: 'report' | 'document'
// userContext:  el resultado de getUserContext(userId)
// userId:       el id del user (para los binds)
//
// Si el user tiene `<resourceType>s.read.all` o es admin, devuelve null
// (caller debe ignorar el filtro y traer todo).
async function buildVisibilityFilter(resourceType, userContext, userId, tableAlias = 'r') {
    const readAllPerm = `${resourceType}s.read.all`;
    if (userContext.isAdmin || userContext.permissions.has(readAllPerm)) {
        return null;  // ve todo
    }

    const legacyTable = resourceType === 'report'
        ? 'user_report_permissions'
        : 'user_document_permissions';
    const legacyIdCol = resourceType === 'report' ? 'report_id' : 'document_id';
    const aliasId = `${tableAlias}.id`;

    const deptIds = userContext.departments.map(d => d.id);
    const roleIds = userContext.roles.map(r => r.id);

    const deptPlaceholders = deptIds.length > 0 ? deptIds.map(() => '?').join(',') : '0';
    const rolePlaceholders = roleIds.length > 0 ? roleIds.map(() => '?').join(',') : '0';

    const whereClause = `
        (
          -- Legacy: user_report_permissions / user_document_permissions
          EXISTS (
            SELECT 1 FROM ${legacyTable}
            WHERE ${legacyIdCol} = ${aliasId} AND user_id = ? AND can_view = 1
          )
          OR
          -- ACL: asignación directa al user
          EXISTS (
            SELECT 1 FROM resource_acl
            WHERE resource_type = '${resourceType}' AND resource_id = ${aliasId}
              AND principal_type = 'user' AND principal_id = ?
          )
          OR
          -- ACL: heredada por departamento
          ${deptIds.length > 0 ? `
          EXISTS (
            SELECT 1 FROM resource_acl
            WHERE resource_type = '${resourceType}' AND resource_id = ${aliasId}
              AND principal_type = 'department' AND principal_id IN (${deptPlaceholders})
          )
          OR` : ''}
          -- ACL: heredada por rol
          ${roleIds.length > 0 ? `
          EXISTS (
            SELECT 1 FROM resource_acl
            WHERE resource_type = '${resourceType}' AND resource_id = ${aliasId}
              AND principal_type = 'role' AND principal_id IN (${rolePlaceholders})
          )` : '0=1'}
        )
    `;

    const params = [
        userId,                     // legacy
        userId,                     // acl user
        ...(deptIds.length > 0 ? deptIds : []),  // acl department
        ...(roleIds.length > 0 ? roleIds : [])   // acl role
    ];

    return { whereClause, params };
}

// Chequea si un user puede ver un recurso específico. Devuelve true/false.
// Útil para endpoints que reciben un :id (getReportById, streamDocument).
async function canUserAccessResource(userId, resourceType, resourceId, action = 'view') {
    const ctx = await getUserContext(userId);
    const readAllPerm = `${resourceType}s.read.all`;
    if (ctx.isAdmin || ctx.permissions.has(readAllPerm)) return true;

    // Legacy
    const legacyTable = resourceType === 'report'
        ? 'user_report_permissions'
        : 'user_document_permissions';
    const legacyIdCol = resourceType === 'report' ? 'report_id' : 'document_id';
    const legacyCol = action === 'export' ? 'can_export' : 'can_view';
    const legacy = await db.queryOne(
        `SELECT 1 FROM ${legacyTable}
         WHERE ${legacyIdCol} = ? AND user_id = ? AND ${legacyCol} = 1`,
        [resourceId, userId]
    );
    if (legacy) return true;

    // ACL: user directo
    const direct = await db.queryOne(
        `SELECT actions FROM resource_acl
         WHERE resource_type = ? AND resource_id = ?
           AND principal_type = 'user' AND principal_id = ?`,
        [resourceType, resourceId, userId]
    );
    if (direct && aclGrantsAction(direct.actions, action)) return true;

    // ACL: por departamento (cualquiera del que el user sea miembro)
    if (ctx.departments.length > 0) {
        const placeholders = ctx.departments.map(() => '?').join(',');
        const byDept = await db.query(
            `SELECT actions FROM resource_acl
             WHERE resource_type = ? AND resource_id = ?
               AND principal_type = 'department'
               AND principal_id IN (${placeholders})`,
            [resourceType, resourceId, ...ctx.departments.map(d => d.id)]
        );
        if (byDept.some(row => aclGrantsAction(row.actions, action))) return true;
    }

    // ACL: por rol
    if (ctx.roles.length > 0) {
        const placeholders = ctx.roles.map(() => '?').join(',');
        const byRole = await db.query(
            `SELECT actions FROM resource_acl
             WHERE resource_type = ? AND resource_id = ?
               AND principal_type = 'role'
               AND principal_id IN (${placeholders})`,
            [resourceType, resourceId, ...ctx.roles.map(r => r.id)]
        );
        if (byRole.some(row => aclGrantsAction(row.actions, action))) return true;
    }

    return false;
}

// 'actions' viene como string JSON: '["view","export"]'.
// Devuelve true si la accion solicitada esta en el array.
function aclGrantsAction(actionsJson, action) {
    try {
        const arr = typeof actionsJson === 'string' ? JSON.parse(actionsJson) : actionsJson;
        return Array.isArray(arr) && arr.includes(action);
    } catch {
        return false;
    }
}

module.exports = { buildVisibilityFilter, canUserAccessResource, aclGrantsAction };
