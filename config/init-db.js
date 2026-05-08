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
        ['permissions.manage', 'permissions','manage','Asignar/quitar permisos a otros usuarios'],
        ['audit.read',         'audit',      'read',  'Ver logs de acceso']
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
    // se lo da explícito si quiere.
    await grantPermsToRole('rrhh', [
        'users.read', 'departments.manage',
        'reports.read.assigned', 'documents.read.assigned',
        'audit.read'
    ]);

    // Empleado: lo mínimo.
    await grantPermsToRole('empleado', [
        'reports.read.assigned', 'documents.read.assigned'
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

async function seedCotizador() {
    // Destino: Miami (MIA)
    await db.execute(
        insertOrIgnore('destinos',
            ['codigo_iata', 'nombre', 'pais', 'porcentaje_arancel', 'porcentaje_impuesto_consumo'],
            'codigo_iata'),
        ['MIA', 'Miami', 'USA', 0, 0]
    );
    // Carguera: Copa Airlines
    await db.execute(
        insertOrIgnore('cargueras', ['nombre'], 'nombre'),
        ['Copa Airlines']
    );

    const dest = await db.queryOne('SELECT id FROM destinos WHERE codigo_iata = ?', ['MIA']);
    const carg = await db.queryOne('SELECT id FROM cargueras WHERE nombre = ?', ['Copa Airlines']);

    // Tarifas de Copa Airlines a Miami (vigentes desde 2024-01-01)
    const existing = await db.queryOne(
        'SELECT COUNT(*) as c FROM tarifas_carguera WHERE id_carguera = ? AND id_destino = ?',
        [carg.id, dest.id]
    );
    if (Number(existing.c) === 0) {
        // Tarifa para < 100 kg
        await db.execute(
            `INSERT INTO tarifas_carguera
             (id_carguera, id_destino, peso_minimo, peso_maximo, tarifa_kilo,
              costo_cuarto_frio_kilo, costo_documentacion_fijo, fecha_inicio, fecha_fin)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [carg.id, dest.id, 0, 99.99, 3.50, 0, 120, '2024-01-01', null]
        );
        // Tarifa para >= 100 kg
        await db.execute(
            `INSERT INTO tarifas_carguera
             (id_carguera, id_destino, peso_minimo, peso_maximo, tarifa_kilo,
              costo_cuarto_frio_kilo, costo_documentacion_fijo, fecha_inicio, fecha_fin)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [carg.id, dest.id, 100, 999999, 2.405, 0, 120, '2024-01-01', null]
        );
        console.log('💸 Tarifas de Copa Airlines a Miami sembradas');
    }

    const tdest = await db.queryOne(
        'SELECT COUNT(*) as c FROM tarifas_destino WHERE id_destino = ?',
        [dest.id]
    );
    if (Number(tdest.c) === 0) {
        const rubros = JSON.stringify({});
        await db.execute(
            `INSERT INTO tarifas_destino
             (id_destino, aduana_fija, transporte_interno_caja, rubros_dinamicos, fecha_inicio, fecha_fin)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [dest.id, 240, 15, rubros, '2024-01-01', null]
        );
        console.log('💸 Tarifa de destino MIA sembrada');
    }
}

async function init() {
    console.log('🔧 Inicializando base de datos...');
    await loadSchema();
    await migrateAccessLogsDocCol();
    await migrateUsersAuthFields();
    await migrateUsersTotpFields();
    await seedSystemConfig();
    await seedUsers();
    await seedSampleReports();
    await seedSamplePermission();
    await seedCotizador();
    // PR-1a: semilla RBAC. Corre después de seedUsers para poder asignar
    // admin_sistema al user admin (id=1).
    await seedRbac();
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
