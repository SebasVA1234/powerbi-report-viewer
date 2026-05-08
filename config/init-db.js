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

    await db.execute(
        insertOrIgnore('users', ['username', 'email', 'password', 'plain_password', 'full_name', 'role'], 'username'),
        ['admin', 'admin@powerbi.local', adminPwd, 'admin123', 'Administrador', 'admin']
    );
    await db.execute(
        insertOrIgnore('users', ['username', 'email', 'password', 'plain_password', 'full_name', 'role'], 'username'),
        ['usuario1', 'usuario1@test.com', testPwd, 'user123', 'Usuario de Prueba', 'user']
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
    await seedSystemConfig();
    await seedUsers();
    await seedSampleReports();
    await seedSamplePermission();
    await seedCotizador();
    // PR-1a: semilla RBAC. Corre después de seedUsers para poder asignar
    // admin_sistema al user admin (id=1).
    await seedRbac();
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
