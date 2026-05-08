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
