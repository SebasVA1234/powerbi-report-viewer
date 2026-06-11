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

    // Sub-query: ids de categorías 'report' o 'document' a las que el user
    // tiene acceso vía ACL (directo, depto o rol). Si la categoría está en
    // resource_acl como resource_type='category' y el user/depto/rol matchea,
    // todos los recursos de esa categoría son visibles. PR-1c.
    const categoryAccessSubquery = `
        SELECT DISTINCT a.resource_id AS cat_id
        FROM resource_acl a
        WHERE a.resource_type = 'category'
          AND (
            (a.principal_type = 'user' AND a.principal_id = ?)
            ${deptIds.length > 0 ? `OR (a.principal_type = 'department' AND a.principal_id IN (${deptPlaceholders}))` : ''}
            ${roleIds.length > 0 ? `OR (a.principal_type = 'role' AND a.principal_id IN (${rolePlaceholders}))` : ''}
          )
    `;

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
          )
          OR` : ''}
          -- PR-1c: heredada por la CATEGORÍA del recurso.
          -- NOTA: se omite si category_id no existe en la tabla
          -- (migración opcional; las ACL por dept/user/rol siguen funcionando).
          1 = 0
        )
    `;

    // Params: legacy + acl_user + acl_dept + acl_role
    // (sin params de category subquery — eliminada para compatibilidad)
    const params = [
        userId,                                          // legacy
        userId,                                          // acl user directo
        ...(deptIds.length > 0 ? deptIds : []),          // acl department
        ...(roleIds.length > 0 ? roleIds : [])           // acl role
    ];

    return { whereClause, params };
}

// Chequea si un user puede ver un recurso específico. Devuelve true/false.
// Útil para endpoints que reciben un :id (getReportById, streamDocument).
async function canUserAccessResource(userId, resourceType, resourceId, action = 'view') {
    const ctx = await getUserContext(userId);
    if (ctx.isAdmin) return true;
    // `<resource>s.read.all` concede VER (y exportar reportes), pero NO
    // descargar: la descarga del PDF original es una compuerta sensible y
    // explícita (el visor es view-only por diseño). Sólo admin o un grant
    // 'download' directo/heredado la abre. F2.
    const readAllPerm = `${resourceType}s.read.all`;
    if (action !== 'download' && ctx.permissions.has(readAllPerm)) return true;

    // Legacy
    const legacyTable = resourceType === 'report'
        ? 'user_report_permissions'
        : 'user_document_permissions';
    const legacyIdCol = resourceType === 'report' ? 'report_id' : 'document_id';
    // Columna legacy según la acción: reportes usan can_export; documentos,
    // can_download (F2). 'view' por defecto.
    let legacyCol = 'can_view';
    if (action === 'export') legacyCol = 'can_export';
    else if (action === 'download') legacyCol = 'can_download';
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

    // PR-1c: ACL heredada por la CATEGORÍA del recurso.
    if (resourceType === 'report' || resourceType === 'document') {
        const table = resourceType === 'report' ? 'reports' : 'documents';
        let resourceRow;
        try {
            resourceRow = await db.queryOne(
                `SELECT category_id FROM ${table} WHERE id = ?`,
                [resourceId]
            );
        } catch {
            // Columna category_id puede no existir si la migración aún no corrió.
            resourceRow = null;
        }
        if (resourceRow && resourceRow.category_id) {
            const principals = [
                { type: 'user', id: userId }
            ];
            for (const d of ctx.departments) principals.push({ type: 'department', id: d.id });
            for (const r of ctx.roles)       principals.push({ type: 'role',       id: r.id });

            for (const p of principals) {
                const row = await db.queryOne(
                    `SELECT actions FROM resource_acl
                     WHERE resource_type = 'category' AND resource_id = ?
                       AND principal_type = ? AND principal_id = ?`,
                    [resourceRow.category_id, p.type, p.id]
                );
                if (row && aclGrantsAction(row.actions, action)) return true;
            }
        }
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

// F2: fragmento SQL (columna 0/1) que indica si el user puede DESCARGAR el
// documento de la fila (alias.id). Se usa como columna computada en la lista
// de "mis documentos" para evitar N consultas. Fuentes (cualquiera basta):
//   - legacy user_document_permissions.can_download = 1
//   - resource_acl con la acción 'download' (directo, por depto o por rol)
// El match del JSON usa LIKE '%"download"%' — exacto para nuestro formato
// (actions siempre es un array de strings quoteados, p.ej. ["view","download"]).
// PARIDAD: igual que buildVisibilityFilter (el filtro de visibilidad de la
// grilla), esta función NO evalúa la herencia por CATEGORÍA. La frontera de
// autorización real es canUserAccessResource (el endpoint), que sí la considera.
function buildDownloadFlagSql(userContext, userId, tableAlias = 'd') {
    if (userContext.isAdmin) return { sql: '1', params: [] };

    const aliasId = `${tableAlias}.id`;
    const deptIds = userContext.departments.map(d => d.id);
    const roleIds = userContext.roles.map(r => r.id);
    const parts = [];
    const params = [];

    // Legacy directo al user.
    parts.push(
        `EXISTS (SELECT 1 FROM user_document_permissions
                 WHERE document_id = ${aliasId} AND user_id = ? AND can_download = 1)`
    );
    params.push(userId);

    // ACL: asignación directa al user con acción 'download'.
    parts.push(
        `EXISTS (SELECT 1 FROM resource_acl
                 WHERE resource_type = 'document' AND resource_id = ${aliasId}
                   AND principal_type = 'user' AND principal_id = ?
                   AND actions LIKE '%"download"%')`
    );
    params.push(userId);

    // ACL: heredada por departamento.
    if (deptIds.length > 0) {
        const ph = deptIds.map(() => '?').join(',');
        parts.push(
            `EXISTS (SELECT 1 FROM resource_acl
                     WHERE resource_type = 'document' AND resource_id = ${aliasId}
                       AND principal_type = 'department' AND principal_id IN (${ph})
                       AND actions LIKE '%"download"%')`
        );
        params.push(...deptIds);
    }

    // ACL: heredada por rol.
    if (roleIds.length > 0) {
        const ph = roleIds.map(() => '?').join(',');
        parts.push(
            `EXISTS (SELECT 1 FROM resource_acl
                     WHERE resource_type = 'document' AND resource_id = ${aliasId}
                       AND principal_type = 'role' AND principal_id IN (${ph})
                       AND actions LIKE '%"download"%')`
        );
        params.push(...roleIds);
    }

    return { sql: `(CASE WHEN (${parts.join(' OR ')}) THEN 1 ELSE 0 END)`, params };
}

module.exports = { buildVisibilityFilter, canUserAccessResource, aclGrantsAction, buildDownloadFlagSql };
