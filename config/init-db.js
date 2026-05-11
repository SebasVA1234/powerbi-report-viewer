/**
 * Inicializador de base de datos. Funciona con SQLite o PostgreSQL.
 *
 * 1. Carga el archivo de schema correspondiente (schema/sqlite.sql o postgres.sql)
 * 2. Ejecuta el script (idempotente: usa CREATE TABLE IF NOT EXISTS)
 * 3. Hace seed: usuario admin, usuario de prueba, reportes de ejemplo,
 *    config defaults, datos seed del Cotizador (Copa Airlines + Miami).
 *
 * Llamado al iniciar el server. Es idempotente: se puede correr cada arranque.
 */
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const db = require('./db');

const SCHEMA_DIR = path.join(__dirname, 'schema');

async function loadSchema() {
    const file = db.driver === 'postgres' ? 'postgres.sql' : 'sqlite.sql';
    const sql = fs.readFileSync(path.join(SCHEMA_DIR, file), 'utf8');
    await db.exec(sql);
    console.log(`📐 Schema aplicado (${file})`);
}

async function migrateAccessLogsDocCol() {
    // Para bases de datos viejas que no tienen la columna document_id en access_logs.
    // SQLite y PG tienen sintaxis diferente.
    if (db.driver === 'sqlite') {
        const cols = await db.query("PRAGMA table_info(access_logs)");
        const has = cols.some(c => c.name === 'document_id');
        if (!has) {
            await db.exec('ALTER TABLE access_logs ADD COLUMN document_id INTEGER');
            console.log('🔧 Migración: columna document_id añadida a access_logs');
        }
    } else {
        // PG: en nuestro schema ya viene con la columna, solo verificamos por si acaso
        const r = await db.query(
            "SELECT 1 FROM information_schema.columns WHERE table_name = 'access_logs' AND column_name = 'document_id'"
        );
        if (r.length === 0) {
            await db.exec('ALTER TABLE access_logs ADD COLUMN document_id INTEGER');
            console.log('🔧 Migración: columna document_id añadida a access_logs');
        }
    }
}

// PR-1c: agrega reports.category_id y documents.category_id (FK a categories).
// Migra los strings existentes de reports.category / documents.category a
// filas en categories. Idempotente: detecta el estado y aplica solo lo que falta.
//
// Estrategia:
//   1. Si reports.category_id no existe, la crea (nullable).
//   2. Para cada distinct reports.category (string no-vacio) que NO tenga
//      una categoría correspondiente en categories(type='report'), la crea
//      y popula reports.category_id. Idem para documents.
//   3. La columna string queda intacta para no romper código que la lea.
//      Se puede dropear más adelante (en una PR futura) cuando confirmemos
//      que nadie la usa.
async function migrateCategoriesFK() {
    const isPg = db.driver === 'postgres';

    // Helper: detectar columnas presentes en una tabla.
    async function tableCols(table) {
        if (isPg) {
            const r = await db.query(
                "SELECT column_name FROM information_schema.columns WHERE table_name = ?",
                [table]
            );
            return r.map(c => c.column_name);
        }
        const r = await db.query(`PRAGMA table_info(${table})`);
        return r.map(c => c.name);
    }

    // Helper: snake_case del nombre de la categoría para el code.
    function toCode(name) {
        return (name || '')
            .toString()
            .toLowerCase()
            .replace(/[áàä]/g, 'a').replace(/[éèë]/g, 'e').replace(/[íìï]/g, 'i')
            .replace(/[óòö]/g, 'o').replace(/[úùü]/g, 'u').replace(/ñ/g, 'n')
            .replace(/[^a-z0-9]+/g, '_')
            .replace(/^_+|_+$/g, '')
            .slice(0, 31) || 'sin_categoria';
    }

    for (const [table, type] of [['reports', 'report'], ['documents', 'document']]) {
        const cols = await tableCols(table);
        const fkCol = 'category_id';
        const stringCol = 'category';

        // 1. Crear category_id si falta.
        if (!cols.includes(fkCol)) {
            await db.exec(`ALTER TABLE ${table} ADD COLUMN ${fkCol} INTEGER`);
            console.log(`🔧 Migración: columna ${fkCol} añadida a ${table}`);
        }

        // 2. Si no hay columna 'category' string, no hay nada que migrar.
        if (!cols.includes(stringCol)) continue;

        // 3. Buscar reports/documents con category string pero sin category_id.
        const pending = await db.query(`
            SELECT DISTINCT ${stringCol} AS cat_name
            FROM ${table}
            WHERE ${stringCol} IS NOT NULL AND ${stringCol} <> ''
              AND ${fkCol} IS NULL
        `);
        if (pending.length === 0) continue;

        for (const row of pending) {
            const name = row.cat_name;
            const code = toCode(name);

            // Crear categoría si no existe.
            const onConflictCat = isPg
                ? `INSERT INTO categories (type, code, name) VALUES (?, ?, ?)
                   ON CONFLICT(type, code) DO NOTHING`
                : `INSERT OR IGNORE INTO categories (type, code, name) VALUES (?, ?, ?)`;
            await db.execute(onConflictCat, [type, code, name]);

            // Popular FK en todas las filas que matchean por string.
            const cat = await db.queryOne(
                'SELECT id FROM categories WHERE type = ? AND code = ?',
                [type, code]
            );
            if (cat) {
                await db.execute(
                    `UPDATE ${table} SET ${fkCol} = ? WHERE ${stringCol} = ? AND ${fkCol} IS NULL`,
                    [cat.id, name]
                );
            }
        }
        console.log(`🔧 Migración: ${pending.length} categoría(s) string migradas a categories(type='${type}')`);
    }
}

// PR-0c: agrega documents.storage_key (path en el volumen) y permite que
// file_data sea NULL. Idempotente. Los documentos legacy con BLOB siguen
// funcionando: streamDocument hace fallback a file_data si storage_key
// está vacío.
async function migrateDocumentsStorageKey() {
    if (db.driver === 'sqlite') {
        const cols = await db.query("PRAGMA table_info(documents)");
        if (!cols.some(c => c.name === 'storage_key')) {
            await db.exec('ALTER TABLE documents ADD COLUMN storage_key TEXT');
            console.log('🔧 Migración: columna storage_key añadida a documents');
        }
        // SQLite no permite cambiar NOT NULL→NULL sin recrear la tabla; lo
        // dejamos: el schema legacy tenía file_data NOT NULL, pero los
        // INSERTs nuevos pueden enviar null si la columna no fue declarada
        // así. En la práctica, escribimos un Buffer vacío como sentinel
        // cuando hay storage_key, así no rompemos el constraint.
    } else {
        const cols = await db.query(
            "SELECT column_name, is_nullable FROM information_schema.columns WHERE table_name = 'documents'"
        );
        const colNames = cols.map(c => c.column_name);
        if (!colNames.includes('storage_key')) {
            await db.exec('ALTER TABLE documents ADD COLUMN storage_key TEXT');
            console.log('🔧 Migración: columna storage_key añadida a documents');
        }
        const fileDataCol = cols.find(c => c.column_name === 'file_data');
        if (fileDataCol && fileDataCol.is_nullable === 'NO') {
            await db.exec('ALTER TABLE documents ALTER COLUMN file_data DROP NOT NULL');
            console.log('🔧 Migración: documents.file_data ahora permite NULL');
        }
    }
}

// PR-0b.1: agrega users.totp_secret y users.totp_enabled (2FA TOTP).
// Idempotente: detecta el estado y aplica solo lo que falta.
async function migrateUsersTotpFields() {
    if (db.driver === 'sqlite') {
        const cols = await db.query("PRAGMA table_info(users)");
        const has = name => cols.some(c => c.name === name);
        if (!has('totp_secret')) {
            await db.exec('ALTER TABLE users ADD COLUMN totp_secret TEXT');
            console.log('🔧 Migración: columna totp_secret añadida a users');
        }
        if (!has('totp_enabled')) {
            await db.exec('ALTER TABLE users ADD COLUMN totp_enabled INTEGER DEFAULT 0');
            console.log('🔧 Migración: columna totp_enabled añadida a users');
        }
    } else {
        const cols = await db.query(
            "SELECT column_name FROM information_schema.columns WHERE table_name = 'users'"
        );
        const colNames = cols.map(c => c.column_name);
        if (!colNames.includes('totp_secret')) {
            await db.exec('ALTER TABLE users ADD COLUMN totp_secret TEXT');
            console.log('🔧 Migración: columna totp_secret añadida a users');
        }
        if (!colNames.includes('totp_enabled')) {
            await db.exec('ALTER TABLE users ADD COLUMN totp_enabled INTEGER DEFAULT 0');
            console.log('🔧 Migración: columna totp_enabled añadida a users');
        }
    }
}

// PR-0b: borrar columna users.plain_password (riesgo de seguridad) y
// agregar users.must_change_password (forzar cambio en primer login).
// Idempotente: detecta el estado y aplica solo lo que falta.
async function migrateUsersAuthFields() {
    if (db.driver === 'sqlite') {
        const cols = await db.query("PRAGMA table_info(users)");
        const hasPlain = cols.some(c => c.name === 'plain_password');
        const hasMust = cols.some(c => c.name === 'must_change_password');

        if (!hasMust) {
            await db.exec('ALTER TABLE users ADD COLUMN must_change_password INTEGER DEFAULT 0');
            console.log('🔧 Migración: columna must_change_password añadida a users');
            // Marcar usuarios existentes con creds de seed (admin/usuario1) o
            // cualquier user del legacy para que cambien su pass al próximo login.
            // Un admin que crea usuarios desde aqui en adelante decide caso a caso.
            await db.exec('UPDATE users SET must_change_password = 1 WHERE id IS NOT NULL');
            console.log('🔧 Migración: marcado must_change_password=1 a usuarios existentes');
        }

        if (hasPlain) {
            // SQLite ≥ 3.35 (2021-03) soporta DROP COLUMN.
            try {
                await db.exec('ALTER TABLE users DROP COLUMN plain_password');
                console.log('🔧 Migración: columna plain_password eliminada de users');
            } catch (err) {
                console.warn('⚠️  No se pudo DROP COLUMN plain_password (SQLite muy viejo). La columna queda pero no se usa.', err.message);
            }
        }
    } else {
        // PG
        const cols = await db.query(
            "SELECT column_name FROM information_schema.columns WHERE table_name = 'users'"
        );
        const colNames = cols.map(c => c.column_name);
        const hasPlain = colNames.includes('plain_password');
        const hasMust = colNames.includes('must_change_password');

        if (!hasMust) {
            await db.exec('ALTER TABLE users ADD COLUMN must_change_password INTEGER DEFAULT 0');
            console.log('🔧 Migración: columna must_change_password añadida a users');
            await db.exec('UPDATE users SET must_change_password = 1 WHERE id IS NOT NULL');
            console.log('🔧 Migración: marcado must_change_password=1 a usuarios existentes');
        }

        if (hasPlain) {
            await db.exec('ALTER TABLE users DROP COLUMN plain_password');
            console.log('🔧 Migración: columna plain_password eliminada de users');
        }
    }
}

// Helper: INSERT que ignora si la fila ya existe (UNIQUE conflict).
// SQLite: INSERT OR IGNORE.  PostgreSQL: INSERT ... ON CONFLICT DO NOTHING.
function insertOrIgnore(table, columns, conflictTarget) {
    const placeholders = columns.map(() => '?').join(', ');
    const cols = columns.join(', ');
    if (db.driver === 'sqlite') {
        return `INSERT OR IGNORE INTO ${table} (${cols}) VALUES (${placeholders})`;
    } else {
        return `INSERT INTO ${table} (${cols}) VALUES (${placeholders}) ON CONFLICT (${conflictTarget}) DO NOTHING`;
    }
}

// PR-1a: semilla del modelo RBAC.
// - 9 roles del negocio (con is_system=1 los iniciales).
// - 8 departamentos formales.
// - ~15 permisos atómicos.
// - role_permissions: gerencia/jefe_innovacion/admin_sistema reciben todos
//   los permisos; jefes de área los suyos; rrhh los de RRHH+lectura;
//   empleado los mínimos.
// - El user admin (id=1) recibe el rol admin_sistema y se asigna al
//   departamento Gerencia. Idempotente: usa INSERT OR IGNORE / ON CONFLICT.
async function seedRbac() {
    // -------- Roles --------
    const ROLES = [
        ['admin_sistema',  'Administrador del Sistema', 100, 'Cuenta técnica de mantenimiento. Acceso total.'],
        ['gerencia',       'Gerencia',                  90,  'Gerentes principales. Acceso total al negocio.'],
        ['jefe_innovacion','Jefe de Innovación',        90,  'Mismos permisos que Gerencia (rol separado para el organigrama).'],
        ['jefe_compras',   'Jefe de Compras',           70,  'Gestiona el equipo de Compras.'],
        ['jefe_ventas',    'Jefe de Ventas',            70,  'Gestiona el equipo de Ventas.'],
        ['jefe_contabilidad','Jefe de Contabilidad',    70,  'Gestiona el equipo de Contabilidad.'],
        ['jefe_marketing', 'Jefe de Marketing',         70,  'Gestiona el equipo de Marketing.'],
        ['rrhh',           'Recursos Humanos',          50,  'Gestiona empleados, vacaciones, certificados.'],
        ['empleado',       'Empleado',                  10,  'Acceso a recursos asignados y a su propio perfil.']
    ];
    for (const [code, name, level, description] of ROLES) {
        await db.execute(
            insertOrIgnore('roles', ['code','name','level','description','is_system'], 'code'),
            [code, name, level, description, 1]
        );
    }

    // -------- Permisos --------
    const PERMS = [
        ['system.admin',       'system',     'admin', 'Acceso total al sistema'],
        ['users.read',         'users',      'read',  'Listar y ver usuarios'],
        ['users.write',        'users',      'write', 'Crear, editar, eliminar usuarios'],
        ['roles.manage',       'roles',      'manage','Asignar y quitar roles'],
        ['departments.manage', 'departments','manage','CRUD de departamentos'],
        ['categories.manage',  'categories', 'manage','CRUD de categorías de reportes/documentos'],
        ['reports.read.all',   'reports',    'read.all',     'Ver todos los reportes'],
        ['reports.read.assigned','reports',  'read.assigned','Ver reportes asignados'],
        ['reports.write',      'reports',    'write', 'Crear, editar, eliminar reportes'],
        ['documents.read.all', 'documents',  'read.all',     'Ver todos los documentos'],
        ['documents.read.assigned','documents','read.assigned','Ver documentos asignados'],
        ['documents.write',    'documents',  'write', 'Subir, eliminar documentos'],
        ['cotizador.use',      'cotizador',  'use',   'Usar el cotizador y guardar histórico propio'],
        ['cotizador.tarifas.manage', 'cotizador', 'tarifas.manage', 'Configurar tarifas, costos por país y catálogos del cotizador'],
        ['permissions.manage', 'permissions','manage','Asignar/quitar permisos a otros usuarios'],
        ['audit.read',         'audit',      'read',  'Ver logs de acceso'],
        // PR-3a: permisos RRHH
        ['hr.read.own',        'hr',         'read.own',  'Ver el propio perfil de empleado'],
        ['hr.read.team',       'hr',         'read.team', 'Ver empleados del propio departamento (jefe)'],
        ['hr.read.all',        'hr',         'read.all',  'Ver todos los empleados (RRHH/Gerencia)'],
        ['hr.write',           'hr',         'write',     'Crear, editar empleados'],
        ['hr.documents.upload','hr',         'documents.upload', 'Subir documentos al expediente del empleado'],
        ['hr.positions.manage','hr',         'positions.manage', 'CRUD de perfiles de cargo'],
        // PR-3b: feriados y banco de días compensados
        ['hr.holidays.manage', 'hr',         'holidays.manage',  'CRUD de feriados (RRHH)'],
        ['hr.attendance.manage','hr',        'attendance.manage','Registrar asistencia a feriados (RRHH)'],
        // PR-3c: solicitudes de tiempo libre
        ['hr.timeoff.request', 'hr',         'timeoff.request',  'Solicitar días libres (cualquier empleado)'],
        ['hr.timeoff.approve', 'hr',         'timeoff.approve',  'Aprobar/rechazar solicitudes (jefe / RRHH)'],
        // PR-3d: memos / comunicados
        ['hr.memos.read',      'hr',         'memos.read',       'Leer los propios memos / comunicados'],
        ['hr.memos.write',     'hr',         'memos.write',      'Emitir memos a empleados (RRHH/Gerencia)']
    ];
    for (const [code, resource_type, action, description] of PERMS) {
        await db.execute(
            insertOrIgnore('permissions', ['code','resource_type','action','description'], 'code'),
            [code, resource_type, action, description]
        );
    }

    // -------- Departamentos --------
    const DEPTS = [
        ['gerencia',     'Gerencia'],
        ['compras',      'Compras'],
        ['ventas',       'Ventas'],
        ['contabilidad', 'Contabilidad'],
        ['marketing',    'Marketing'],
        ['innovacion',   'Innovación'],
        ['rrhh',         'RRHH'],
        ['direct_money', 'Direct Money']
    ];
    for (const [code, name] of DEPTS) {
        await db.execute(
            insertOrIgnore('departments', ['code','name'], 'code'),
            [code, name]
        );
    }

    // -------- Mapping role_permissions --------
    // Helper: dar todos los permisos a un rol.
    async function grantAllToRole(roleCode) {
        const role = await db.queryOne('SELECT id FROM roles WHERE code = ?', [roleCode]);
        if (!role) return;
        const perms = await db.query('SELECT id FROM permissions');
        for (const p of perms) {
            const onConflict = db.driver === 'sqlite'
                ? 'INSERT OR IGNORE INTO role_permissions (role_id, permission_id) VALUES (?, ?)'
                : 'INSERT INTO role_permissions (role_id, permission_id) VALUES (?, ?) ON CONFLICT (role_id, permission_id) DO NOTHING';
            await db.execute(onConflict, [role.id, p.id]);
        }
    }
    async function grantPermsToRole(roleCode, permCodes) {
        const role = await db.queryOne('SELECT id FROM roles WHERE code = ?', [roleCode]);
        if (!role) return;
        for (const code of permCodes) {
            const perm = await db.queryOne('SELECT id FROM permissions WHERE code = ?', [code]);
            if (!perm) continue;
            const onConflict = db.driver === 'sqlite'
                ? 'INSERT OR IGNORE INTO role_permissions (role_id, permission_id) VALUES (?, ?)'
                : 'INSERT INTO role_permissions (role_id, permission_id) VALUES (?, ?) ON CONFLICT (role_id, permission_id) DO NOTHING';
            await db.execute(onConflict, [role.id, perm.id]);
        }
    }

    await grantAllToRole('admin_sistema');
    await grantAllToRole('gerencia');
    await grantAllToRole('jefe_innovacion');

    // Jefes de área: los suyos + lectura básica + cotizador.
    const jefeBasePerms = [
        'reports.read.assigned', 'documents.read.assigned',
        'cotizador.use', 'audit.read'
    ];
    for (const j of ['jefe_compras','jefe_ventas','jefe_contabilidad','jefe_marketing']) {
        await grantPermsToRole(j, jefeBasePerms);
    }

    // RRHH: lectura amplia + manejo de departamentos (para el organigrama
    // que arma RRHH). NO recibe reports.read.all por default — el admin
    // se lo da explícito si quiere. PR-3a: + RRHH completo.
    await grantPermsToRole('rrhh', [
        'users.read', 'departments.manage',
        'reports.read.assigned', 'documents.read.assigned',
        'audit.read',
        'hr.read.all', 'hr.write', 'hr.documents.upload', 'hr.positions.manage',
        'hr.holidays.manage', 'hr.attendance.manage',  // PR-3b
        'hr.timeoff.approve',                           // PR-3c
        'hr.memos.read', 'hr.memos.write'               // PR-3d
    ]);

    // PR-3a: jefes ven a su equipo en RRHH. PR-3c: aprueban time-off de su equipo.
    // PR-3d: jefes pueden emitir memos a su equipo y leer los suyos.
    for (const j of ['jefe_compras','jefe_ventas','jefe_contabilidad','jefe_marketing']) {
        await grantPermsToRole(j, [
            'hr.read.team', 'hr.read.own',
            'hr.timeoff.request', 'hr.timeoff.approve',
            'hr.memos.read', 'hr.memos.write'
        ]);
    }

    // Empleado: lo mínimo + ver su propio perfil RRHH + solicitar días libres
    // + leer memos dirigidos a él (PR-3d).
    await grantPermsToRole('empleado', [
        'reports.read.assigned', 'documents.read.assigned',
        'hr.read.own',
        'hr.timeoff.request',
        'hr.memos.read'
    ]);

    // -------- Asignar admin del sistema al user admin (id=1) --------
    const adminUser = await db.queryOne('SELECT id FROM users WHERE username = ?', ['admin']);
    const adminRole = await db.queryOne('SELECT id FROM roles WHERE code = ?', ['admin_sistema']);
    if (adminUser && adminRole) {
        const ur = db.driver === 'sqlite'
            ? 'INSERT OR IGNORE INTO user_roles (user_id, role_id, granted_by) VALUES (?, ?, ?)'
            : 'INSERT INTO user_roles (user_id, role_id, granted_by) VALUES (?, ?, ?) ON CONFLICT (user_id, role_id) DO NOTHING';
        await db.execute(ur, [adminUser.id, adminRole.id, adminUser.id]);
    }
    const gerenciaDept = await db.queryOne('SELECT id FROM departments WHERE code = ?', ['gerencia']);
    if (adminUser && gerenciaDept) {
        const ud = db.driver === 'sqlite'
            ? 'INSERT OR IGNORE INTO user_departments (user_id, department_id, is_head, granted_by) VALUES (?, ?, ?, ?)'
            : 'INSERT INTO user_departments (user_id, department_id, is_head, granted_by) VALUES (?, ?, ?, ?) ON CONFLICT (user_id, department_id) DO NOTHING';
        await db.execute(ud, [adminUser.id, gerenciaDept.id, 1, adminUser.id]);
    }

    console.log('🛡️  RBAC: 9 roles, 15 permisos, 8 departamentos sembrados; admin asignado a Gerencia.');
}

async function seedSystemConfig() {
    await db.execute(
        insertOrIgnore('system_config', ['config_key', 'config_value', 'description'], 'config_key'),
        ['max_report_windows', '5', 'Máximo de ventanas de reportes abiertas simultáneamente']
    );
}

async function seedUsers() {
    const adminPwd = bcrypt.hashSync('admin123', 10);
    const testPwd = bcrypt.hashSync('user123', 10);

    // Los usuarios de seed se crean con must_change_password=1 — la primera
    // vez que entren con la pass de ejemplo deben cambiarla. Si ya existen
    // (INSERT OR IGNORE), no se tocan; la migración previa ya los marcó.
    await db.execute(
        insertOrIgnore('users', ['username', 'email', 'password', 'full_name', 'role', 'must_change_password'], 'username'),
        ['admin', 'admin@powerbi.local', adminPwd, 'Administrador', 'admin', 1]
    );
    await db.execute(
        insertOrIgnore('users', ['username', 'email', 'password', 'full_name', 'role', 'must_change_password'], 'username'),
        ['usuario1', 'usuario1@test.com', testPwd, 'Usuario de Prueba', 'user', 1]
    );
    console.log('👤 Usuarios admin / usuario1 listos');
}

async function seedSampleReports() {
    const r = await db.queryOne('SELECT COUNT(*) as count FROM reports');
    if (Number(r.count) > 0) {
        console.log(`📊 Reportes existentes: ${r.count}`);
        return;
    }
    const samples = [
        ['Dashboard Ventas 2024', 'Dashboard principal de ventas con métricas clave', 'https://app.powerbi.com/view?r=ejemplo_url_1', 'Ventas'],
        ['Reporte Financiero Mensual', 'Análisis financiero detallado por mes', 'https://app.powerbi.com/view?r=ejemplo_url_2', 'Finanzas'],
        ['KPIs Operacionales', 'Indicadores clave de rendimiento operacional', 'https://app.powerbi.com/view?r=ejemplo_url_3', 'Operaciones']
    ];
    for (const row of samples) {
        await db.execute(
            'INSERT INTO reports (name, description, embed_url, category) VALUES (?, ?, ?, ?)',
            row
        );
    }
    console.log('📊 3 reportes de ejemplo creados');
}

async function seedSamplePermission() {
    // Asignar Dashboard Ventas (id=1) al usuario1 (id=2)
    try {
        const u = await db.queryOne('SELECT id FROM users WHERE username = ?', ['usuario1']);
        const rep = await db.queryOne('SELECT id FROM reports WHERE name = ?', ['Dashboard Ventas 2024']);
        if (u && rep) {
            await db.execute(
                insertOrIgnore(
                    'user_report_permissions',
                    ['user_id', 'report_id', 'can_view', 'can_export', 'granted_by'],
                    'user_id, report_id'
                ),
                [u.id, rep.id, 1, 0, 1]
            );
        }
    } catch (e) { /* tolerante */ }
}

// PR-finalize-prototype · Migración del cotizador v1 → v2.
// Schema viejo: destinos / cargueras (solo nombre) / tarifas_carguera (sin
// aerolinea, sin origen) / tarifas_destino (key por destino, no país).
// Schema nuevo: airports / aerolineas / cargueras (con pais, email) /
// tarifas_carguera (con aerolinea, origen, destino, tariff_type, currency,
// validity, surcharges) / tarifas_pais (por country_code) / tariff_changes_log.
//
// IMPORTANTE: corre ANTES de loadSchema(). Si quedan tablas viejas, el
// loadSchema fallaría al crear índices que referencian columnas inexistentes
// (ej. CREATE INDEX ... ON tarifas_carguera(carguera_id) sobre la tabla
// vieja con id_carguera). Después loadSchema crea las tablas nuevas limpias.
//
// El seed viejo era solo Copa+MIA (datos de demo) → no hay pérdida real de
// datos productivos.
async function migrateCotizadorV2_PreSchema() {
    const isPg = db.driver === 'postgres';

    async function tableExists(name) {
        if (isPg) {
            const r = await db.queryOne(
                "SELECT 1 FROM information_schema.tables WHERE table_name = ?",
                [name]
            );
            return !!r;
        }
        const r = await db.queryOne(
            "SELECT name FROM sqlite_master WHERE type='table' AND name = ?",
            [name]
        );
        return !!r;
    }

    async function columnExists(table, column) {
        if (!(await tableExists(table))) return false;
        if (isPg) {
            const r = await db.queryOne(
                "SELECT 1 FROM information_schema.columns WHERE table_name = ? AND column_name = ?",
                [table, column]
            );
            return !!r;
        }
        const cols = await db.query(`PRAGMA table_info(${table})`);
        return cols.some(c => c.name === column);
    }

    // Detección: si tarifas_carguera no tiene la columna nueva 'carguera_id'
    // pero sí la vieja 'id_carguera', es schema v1 — hay que dropear.
    // También dropeamos si existe 'destinos' o 'tarifas_destino' (viejas).
    const tarifaTableExists = await tableExists('tarifas_carguera');
    const tarifaIsOld = tarifaTableExists && !(await columnExists('tarifas_carguera', 'carguera_id'));
    const hasOldDestinos = await tableExists('destinos');
    const hasOldTarifaDestino = await tableExists('tarifas_destino');
    // cargueras vieja tiene SOLO 'nombre'; la nueva tiene 'pais' también.
    const cargTableExists = await tableExists('cargueras');
    const cargIsOld = cargTableExists && !(await columnExists('cargueras', 'pais'));

    if (tarifaIsOld || hasOldDestinos || hasOldTarifaDestino || cargIsOld) {
        console.log('🔄 Migración cotizador v1 → v2: dropeando tablas viejas (pre-schema)');
        // Drop en orden inverso de dependencias FK.
        try { await db.exec('DROP TABLE IF EXISTS tarifas_destino CASCADE'); } catch {}
        try { await db.exec('DROP TABLE IF EXISTS tarifas_carguera CASCADE'); } catch {}
        try { await db.exec('DROP TABLE IF EXISTS destinos CASCADE'); } catch {}
        try { await db.exec('DROP TABLE IF EXISTS cargueras CASCADE'); } catch {}
        console.log('🔄 Cotizador v2: tablas viejas dropeadas; loadSchema creará las nuevas');
    }
}

// Seed catálogos del cotizador v2: aeropuertos típicos para flores
// ecuatorianas, aerolíneas cargo principales, las 5 cargueras reales que
// nos pasó el usuario, y costos por país placeholder para los 10 destinos
// más relevantes. Idempotente — solo inserta si no existe.
async function seedCotizador() {
    // ---- Aeropuertos (35 — orígenes Ecuador + destinos top flores) ----
    const AIRPORTS = [
        // Origen Ecuador
        ['UIO', 'Mariscal Sucre',           'Quito',         'Ecuador',     'EC'],
        ['GYE', 'José Joaquín de Olmedo',   'Guayaquil',     'Ecuador',     'EC'],
        // USA
        ['MIA', 'Miami International',      'Miami',         'USA',         'US'],
        ['MCO', 'Orlando International',    'Orlando',       'USA',         'US'],
        ['JFK', 'John F. Kennedy Intl.',    'New York',      'USA',         'US'],
        ['LAX', 'Los Angeles Intl.',        'Los Angeles',   'USA',         'US'],
        ['ORD', "O'Hare International",     'Chicago',       'USA',         'US'],
        ['IAH', 'George Bush Intl.',        'Houston',       'USA',         'US'],
        ['ATL', 'Hartsfield-Jackson',       'Atlanta',       'USA',         'US'],
        ['DFW', 'Dallas/Fort Worth Intl.',  'Dallas',        'USA',         'US'],
        // Europa
        ['AMS', 'Schiphol',                 'Amsterdam',     'Países Bajos','NL'],
        ['FRA', 'Frankfurt am Main',        'Frankfurt',     'Alemania',    'DE'],
        ['CDG', 'Charles de Gaulle',        'París',         'Francia',     'FR'],
        ['MAD', 'Adolfo Suárez Madrid',     'Madrid',        'España',      'ES'],
        ['MXP', 'Malpensa',                 'Milán',         'Italia',      'IT'],
        ['LGG', 'Liège',                    'Lieja',         'Bélgica',     'BE'],
        ['LHR', 'Heathrow',                 'Londres',       'Reino Unido', 'GB'],
        ['ZRH', 'Zürich',                   'Zúrich',        'Suiza',       'CH'],
        ['VIE', 'Schwechat',                'Viena',         'Austria',     'AT'],
        // Canadá
        ['YYZ', 'Pearson',                  'Toronto',       'Canadá',      'CA'],
        ['YVR', 'Vancouver Intl.',          'Vancouver',     'Canadá',      'CA'],
        // Rusia
        ['SVO', 'Sheremetyevo',             'Moscú',         'Rusia',       'RU'],
        ['DME', 'Domodedovo',               'Moscú',         'Rusia',       'RU'],
        // Medio Oriente
        ['DXB', 'Dubai International',      'Dubai',         'Emiratos',    'AE'],
        ['DOH', 'Hamad International',      'Doha',          'Catar',       'QA'],
        // Asia
        ['NRT', 'Narita',                   'Tokio',         'Japón',       'JP'],
        ['HND', 'Haneda',                   'Tokio',         'Japón',       'JP'],
        ['PVG', 'Pudong',                   'Shanghái',      'China',       'CN'],
        ['HKG', 'Hong Kong Intl.',          'Hong Kong',     'Hong Kong',   'HK'],
        ['ICN', 'Incheon',                  'Seúl',          'Corea del Sur','KR'],
        // LATAM
        ['BOG', 'El Dorado',                'Bogotá',        'Colombia',    'CO'],
        ['LIM', 'Jorge Chávez',             'Lima',          'Perú',        'PE'],
        ['PTY', 'Tocumen',                  'Panamá',        'Panamá',      'PA'],
        ['MEX', 'Benito Juárez',            'CDMX',          'México',      'MX'],
        ['GRU', 'Guarulhos',                'São Paulo',     'Brasil',      'BR']
    ];
    for (const [iata, name, city, country, cc] of AIRPORTS) {
        await db.execute(
            insertOrIgnore('airports', ['iata_code','name','city','country','country_code'], 'iata_code'),
            [iata, name, city, country, cc]
        );
    }
    console.log(`✈️  Cotizador: ${AIRPORTS.length} aeropuertos sembrados`);

    // ---- Aerolíneas cargo (12 principales) ----
    const AEROLINEAS = [
        ['Avianca Cargo',           'AV', 'CO'],
        ['LATAM Cargo',             'LA', 'CL'],
        ['KLM Cargo',               'KL', 'NL'],
        ['Lufthansa Cargo',         'LH', 'DE'],
        ['Air France Cargo',        'AF', 'FR'],
        ['American Airlines Cargo', 'AA', 'US'],
        ['Iberia Cargo',            'IB', 'ES'],
        ['Centurion Air Cargo',     'WE', 'US'],
        ['Cargolux',                'CV', 'LU'],
        ['Atlas Air',               '5Y', 'US'],
        ['Qatar Airways Cargo',     'QR', 'QA'],
        ['Emirates SkyCargo',       'EK', 'AE']
    ];
    for (const [nombre, iata, pais] of AEROLINEAS) {
        await db.execute(
            insertOrIgnore('aerolineas', ['nombre','codigo_iata','codigo_pais'], 'codigo_iata'),
            [nombre, iata, pais]
        );
    }
    console.log(`🛫 Cotizador: ${AEROLINEAS.length} aerolíneas sembradas`);

    // ---- Cargueras (5 reales del listado del usuario) ----
    const CARGUERAS = [
        ['Saftec S.A.',              'Ecuador',  'sales@saftec.com.ec'],
        ['Ebf Cargo Cía Ltda',       'Ecuador',  'ebf@ebfcargo.com'],
        ['Logiztik Alliance Group',  'Ecuador',  'sales3@logiztikalliance.com'],
        ['One Team Cargo S.A.',      'Ecuador',  'administracion@oneteamcargo.com'],
        ['Kuehne + Nagel S.A.',      'Kenya',    'nbo.fa@kuehne-nagel.com']
    ];
    for (const [nombre, pais, email] of CARGUERAS) {
        await db.execute(
            insertOrIgnore('cargueras', ['nombre','pais','email'], 'nombre'),
            [nombre, pais, email]
        );
    }
    console.log(`🚚 Cotizador: ${CARGUERAS.length} cargueras sembradas`);

    // ---- Tarifas por país (placeholder en cero — admin las edita
    // desde el módulo "Configurar tarifas") ----
    const PAISES = [
        ['US','USA'], ['NL','Países Bajos'], ['DE','Alemania'], ['ES','España'],
        ['FR','Francia'], ['GB','Reino Unido'], ['IT','Italia'], ['RU','Rusia'],
        ['CA','Canadá'], ['JP','Japón']
    ];
    for (const [code, name] of PAISES) {
        await db.execute(
            insertOrIgnore('tarifas_pais',
                ['country_code','country_name','aduana_fija','transporte_interno_caja',
                 'porcentaje_arancel','porcentaje_impuesto_consumo'],
                'country_code'),
            [code, name, 0, 0, 0, 0]
        );
    }
    console.log(`🌎 Cotizador: ${PAISES.length} países con costos placeholder sembrados (admin debe completar)`);

    // ---- Tarifa demo (Saftec via Avianca UIO→MIA) — solo si no existe
    // ninguna tarifa todavía; sirve para que el cotizador tenga algo
    // que mostrar al primer arranque. ----
    const anyTarifa = await db.queryOne('SELECT COUNT(*) as c FROM tarifas_carguera');
    if (Number(anyTarifa.c) === 0) {
        const carg = await db.queryOne('SELECT id FROM cargueras WHERE nombre = ?', ['Saftec S.A.']);
        const aero = await db.queryOne('SELECT id FROM aerolineas WHERE codigo_iata = ?', ['AV']);
        const orig = await db.queryOne('SELECT id FROM airports WHERE iata_code = ?', ['UIO']);
        const dest = await db.queryOne('SELECT id FROM airports WHERE iata_code = ?', ['MIA']);
        if (carg && aero && orig && dest) {
            await db.execute(
                `INSERT INTO tarifas_carguera
                 (carguera_id, aerolinea_id, origen_airport_id, destino_airport_id,
                  peso_minimo, peso_maximo, tarifa_kilo, costo_cuarto_frio_kilo,
                  costo_documentacion_fijo, tariff_type, notas)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [carg.id, aero.id, orig.id, dest.id,
                 0, 999999, 3.50, 0.20, 120, 'contract', 'Tarifa demo · editar desde el módulo']
            );
            console.log('💸 Cotizador: tarifa demo Saftec/Avianca UIO→MIA sembrada');
        }
    }
}

// PR-3b: semilla de feriados Ecuador 2026 (los 11 que estaban en
// FERIADOS.xlsx del usuario). Idempotente: UNIQUE(holiday_date, name).
// El usuario puede agregar más vía /api/hr/holidays cuando el gobierno
// decreta extras (is_national=0 para custom).
async function seedHolidays() {
    const HOLIDAYS_2026 = [
        ['2026-01-01', 'Año Nuevo'],
        ['2026-02-16', 'Carnaval'],
        ['2026-02-17', 'Carnaval'],
        ['2026-04-03', 'Viernes Santo'],
        ['2026-05-01', 'Día del Trabajo'],
        ['2026-05-23', 'Batalla de Pichincha'],
        ['2026-08-10', 'Primer Grito de la Independencia'],
        ['2026-10-09', 'Independencia de Guayaquil'],
        ['2026-11-02', 'Día de los Difuntos'],
        ['2026-11-03', 'Independencia de Cuenca'],
        ['2026-12-25', 'Navidad']
    ];
    for (const [date, name] of HOLIDAYS_2026) {
        await db.execute(
            insertOrIgnore('holidays', ['holiday_date','name','is_national'], 'holiday_date, name'),
            [date, name, 1]
        );
    }
    console.log(`📅 Feriados: ${HOLIDAYS_2026.length} feriados Ecuador 2026 sembrados`);
}

// PR-3a: semilla de perfiles de cargo (los 12 PDFs del directorio
// PERFILES DE CARGO/ del proyecto se mapean a filas en hr_positions).
// Idempotente: usa INSERT OR IGNORE / ON CONFLICT por code.
async function seedHrPositions() {
    const POSITIONS = [
        // [code, title, department_code, level]
        ['asist_contable',     'Asistente Contable',           'contabilidad', 'asistente'],
        ['asist_th',           'Asistente de Talento Humano',  'rrhh',         'asistente'],
        ['direct_money_op',    'Operador Direct Money',        'direct_money', 'ejecutivo'],
        ['ejec_compras',       'Ejecutivo de Compras',         'compras',      'ejecutivo'],
        ['ejec_ventas',        'Ejecutivo de Ventas',          'ventas',       'ejecutivo'],
        ['ejec_mkt_1',         'Ejecutivo de Marketing Digital 1', 'marketing','ejecutivo'],
        ['ejec_mkt_2',         'Ejecutivo de Marketing Digital 2', 'marketing','ejecutivo'],
        ['atencion_cliente',   'Servicio al Cliente',          'ventas',       'asistente'],
        ['jefe_compras',       'Jefe de Compras',              'compras',      'jefe'],
        ['jefe_ventas',        'Jefe de Ventas',               'ventas',       'jefe'],
        ['jefe_contabilidad',  'Jefe de Contabilidad',         'contabilidad', 'jefe'],
        ['gerente',            'Gerencia',                     'gerencia',     'jefe']
    ];
    for (const [code, title, dept, level] of POSITIONS) {
        await db.execute(
            insertOrIgnore('hr_positions', ['code','title','department_code','level'], 'code'),
            [code, title, dept, level]
        );
    }
    console.log(`👥 RRHH: ${POSITIONS.length} perfiles de cargo sembrados`);
}

async function init() {
    console.log('🔧 Inicializando base de datos...');
    // CRÍTICO: la migración del cotizador v2 va ANTES de loadSchema porque
    // los nuevos índices del schema (idx_tarifa_carg_lookup) referencian
    // columnas (carguera_id, aerolinea_id, etc.) que en el schema viejo
    // no existían — y CREATE INDEX IF NOT EXISTS no es robusto a columnas
    // faltantes.
    await migrateCotizadorV2_PreSchema();
    await loadSchema();
    await migrateAccessLogsDocCol();
    await migrateUsersAuthFields();
    await migrateUsersTotpFields();
    await migrateDocumentsStorageKey();
    await seedSystemConfig();
    await seedUsers();
    await seedSampleReports();
    await seedSamplePermission();
    await seedCotizador();
    // PR-1a: semilla RBAC. Corre después de seedUsers para poder asignar
    // admin_sistema al user admin (id=1).
    await seedRbac();
    // PR-3a: perfiles de cargo. Después de seedRbac porque los CHECKs
    // de hr_positions referencian al modelo de departments por code.
    await seedHrPositions();
    // PR-3b: feriados Ecuador 2026.
    await seedHolidays();
    // PR-1c: la migración de categories corre DESPUÉS del seed para
    // capturar las categorías string sembradas (DB virgen) y también
    // las preexistentes en una DB legacy que ya tenía reports/docs.
    await migrateCategoriesFK();
    console.log('✅ Base de datos inicializada correctamente');
    console.log('👤 Usuario admin: admin / admin123');
    console.log('👤 Usuario test: usuario1 / user123');
}

// Si se ejecuta como script (node config/init-db.js), correr y salir.
if (require.main === module) {
    init()
        .then(() => db.close())
        .then(() => process.exit(0))
        .catch(err => { console.error(err); process.exit(1); });
}

module.exports = { init };
