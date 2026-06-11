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

// F2: agrega user_document_permissions.can_download (espejo de
// user_report_permissions.can_export). El sistema de documentos es view-only
// por defecto; este flag habilita la DESCARGA del PDF original a usuarios,
// departamentos o roles concretos. Aditiva e idempotente, driver-aware.
async function migrateDocumentDownloadFlag() {
    if (db.driver === 'sqlite') {
        const cols = await db.query("PRAGMA table_info(user_document_permissions)");
        if (!cols.some(c => c.name === 'can_download')) {
            await db.exec('ALTER TABLE user_document_permissions ADD COLUMN can_download INTEGER DEFAULT 0');
            console.log('🔧 Migración: columna can_download añadida a user_document_permissions');
        }
    } else {
        const r = await db.query(
            "SELECT 1 FROM information_schema.columns WHERE table_name = 'user_document_permissions' AND column_name = 'can_download'"
        );
        if (r.length === 0) {
            await db.exec('ALTER TABLE user_document_permissions ADD COLUMN can_download INTEGER DEFAULT 0');
            console.log('🔧 Migración: columna can_download añadida a user_document_permissions');
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

// F1: extiende time_off_requests para el workflow multinivel + firma + descuento.
// Idempotente y driver-aware. Agrega columnas Y amplía el CHECK de `status`
// (de pending/approved/rejected/cancelled a +pending_jefe/+pending_tthh).
// ⚠️ El CHECK ampliado vive en el .sql para instalaciones NUEVAS, pero en una DB
// EXISTENTE el CREATE TABLE IF NOT EXISTS se saltea → el CHECK viejo sobrevive y
// rechazaría los estados nuevos. Por eso hay que recrearlo aquí:
//   - Postgres: ALTER TABLE DROP/ADD CONSTRAINT (sí lo soporta).
//   - SQLite (no soporta DROP CONSTRAINT): reconstrucción de tabla (12 pasos),
//     sólo si se detecta el CHECK viejo.
// Las tablas nuevas (hr_signatures, hr_approval_steps, hr_request_attachments)
// las crea loadSchema() vía CREATE TABLE IF NOT EXISTS.
const F1_STATUS_VALUES = "'pending','pending_jefe','pending_tthh','approved','rejected','cancelled'";
const F1_DISCOUNT_VALUES = "'pending','discount','waived'";

async function migrateTimeOffWorkflowF1() {
    // [columna, definición SQLite, definición Postgres]. NOT NULL DEFAULT es seguro
    // al agregar columnas sobre filas existentes (el motor rellena con el default).
    const NEW_COLUMNS = [
        ['discount_decision',
            "TEXT NOT NULL DEFAULT 'pending'",
            "TEXT NOT NULL DEFAULT 'pending'"],
        ['waived_by',         'INTEGER', 'INTEGER'],
        ['waived_reason',     'TEXT',    'TEXT'],
        ['balance_marked_at', 'DATETIME', 'TIMESTAMP']
    ];

    if (db.driver === 'sqlite') {
        const cols = await db.query('PRAGMA table_info(time_off_requests)');
        const have = new Set(cols.map(c => c.name));
        for (const [name, sqliteDef] of NEW_COLUMNS) {
            if (!have.has(name)) {
                await db.exec(`ALTER TABLE time_off_requests ADD COLUMN ${name} ${sqliteDef}`);
                console.log(`🔧 Migración F1: columna ${name} añadida a time_off_requests`);
            }
        }
        // ¿El CHECK de status sigue siendo el viejo? Lo detectamos en el DDL guardado.
        // Si ya contiene 'pending_jefe', la tabla es nueva (del .sql) → nada que hacer.
        const ddlRow = await db.queryOne("SELECT sql FROM sqlite_master WHERE type='table' AND name='time_off_requests'");
        if (ddlRow && ddlRow.sql && !ddlRow.sql.includes('pending_jefe')) {
            console.log('🔧 Migración F1: reconstruyendo time_off_requests para ampliar el CHECK de status (SQLite)...');
            await rebuildTimeOffRequestsSqlite();
        }
    } else {
        const cols = await db.query(
            "SELECT column_name FROM information_schema.columns WHERE table_name = 'time_off_requests'"
        );
        const have = new Set(cols.map(c => c.column_name));
        for (const [name, , pgDef] of NEW_COLUMNS) {
            if (!have.has(name)) {
                await db.exec(`ALTER TABLE time_off_requests ADD COLUMN ${name} ${pgDef}`);
                console.log(`🔧 Migración F1: columna ${name} añadida a time_off_requests`);
            }
        }
        // Postgres SÍ puede recrear constraints. En una DB EXISTENTE el CHECK viejo
        // de status rechazaría pending_jefe/pending_tthh → lo reemplazamos. Idempotente
        // (DROP IF EXISTS + ADD). El nombre autogenerado de un CHECK inline es
        // <tabla>_<col>_check. También agregamos el CHECK de discount_decision (la
        // columna se sumó arriba sin CHECK en DBs existentes).
        await db.exec('ALTER TABLE time_off_requests DROP CONSTRAINT IF EXISTS time_off_requests_status_check');
        await db.exec(`ALTER TABLE time_off_requests ADD CONSTRAINT time_off_requests_status_check CHECK (status IN (${F1_STATUS_VALUES}))`);
        await db.exec('ALTER TABLE time_off_requests DROP CONSTRAINT IF EXISTS time_off_requests_discount_decision_check');
        await db.exec(`ALTER TABLE time_off_requests ADD CONSTRAINT time_off_requests_discount_decision_check CHECK (discount_decision IN (${F1_DISCOUNT_VALUES}))`);
        console.log('🔧 Migración F1: CHECK de status/discount_decision actualizado (Postgres)');
    }
}

// SQLite no soporta ALTER ... DROP CONSTRAINT, así que para ampliar el CHECK de
// status en una DB EXISTENTE reconstruimos la tabla (procedimiento oficial de 12
// pasos). Seguro: foreign_keys OFF, tabla nueva con el schema F1, copia explícita
// de TODAS las columnas (las F1 ya se agregaron antes), swap, recrear índices, y
// transacción con ROLLBACK si algo falla. Sólo se invoca si se detectó el CHECK viejo.
async function rebuildTimeOffRequestsSqlite() {
    await db.exec('PRAGMA foreign_keys=OFF');
    await db.exec('BEGIN');
    try {
        // Defensa: limpiar una tabla temporal de un rebuild interrumpido previo.
        await db.exec('DROP TABLE IF EXISTS time_off_requests_f1new');
        await db.exec(`CREATE TABLE time_off_requests_f1new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            employee_id INTEGER NOT NULL,
            request_type TEXT NOT NULL CHECK(request_type IN ('vacaciones','feriado_compensado','permiso_personal','enfermedad','otro')),
            date_from DATE NOT NULL,
            date_to DATE NOT NULL,
            days_count REAL NOT NULL,
            reason TEXT,
            status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN (${F1_STATUS_VALUES})),
            discount_decision TEXT NOT NULL DEFAULT 'pending' CHECK(discount_decision IN (${F1_DISCOUNT_VALUES})),
            waived_by INTEGER,
            waived_reason TEXT,
            balance_marked_at DATETIME,
            requested_by INTEGER,
            approved_by INTEGER,
            approved_at DATETIME,
            rejection_reason TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (employee_id) REFERENCES hr_employees (id) ON DELETE CASCADE,
            FOREIGN KEY (requested_by) REFERENCES users (id),
            FOREIGN KEY (approved_by) REFERENCES users (id),
            FOREIGN KEY (waived_by) REFERENCES users (id)
        )`);
        await db.exec(`INSERT INTO time_off_requests_f1new
            (id, employee_id, request_type, date_from, date_to, days_count, reason, status,
             discount_decision, waived_by, waived_reason, balance_marked_at,
             requested_by, approved_by, approved_at, rejection_reason, created_at, updated_at)
            SELECT
             id, employee_id, request_type, date_from, date_to, days_count, reason, status,
             discount_decision, waived_by, waived_reason, balance_marked_at,
             requested_by, approved_by, approved_at, rejection_reason, created_at, updated_at
            FROM time_off_requests`);
        await db.exec('DROP TABLE time_off_requests');
        await db.exec('ALTER TABLE time_off_requests_f1new RENAME TO time_off_requests');
        await db.exec('CREATE INDEX IF NOT EXISTS idx_time_off_employee ON time_off_requests(employee_id)');
        await db.exec('CREATE INDEX IF NOT EXISTS idx_time_off_status ON time_off_requests(status)');
        await db.exec('CREATE INDEX IF NOT EXISTS idx_time_off_dates ON time_off_requests(date_from, date_to)');
        await db.exec('COMMIT');
    } catch (err) {
        await db.exec('ROLLBACK');
        throw err;
    } finally {
        await db.exec('PRAGMA foreign_keys=ON');
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

// Lista de columnas de payroll_details EN ORDEN (para el rebuild SQLite con
// INSERT explícito, no SELECT *: robusto ante drift de orden).
const PAYROLL_DETAILS_COLS = [
    'id', 'run_id', 'employee_id',
    'sueldo_base', 'fondos_reserva', 'decimo_tercero', 'decimo_cuarto',
    'horas_extra', 'otros_ingresos', 'total_ingresos',
    'base_aportable', 'aporte_personal', 'otros_descuentos', 'total_descuentos',
    'neto_a_pagar', 'aporte_patronal', 'provisiones', 'costo_empresa',
    'iess_personal_pct_snapshot', 'iess_patronal_pct_snapshot',
    'fondos_reserva_pct_snapshot', 'sbu_snapshot',
    'mensualiza_decimos_snapshot', 'paga_fondos_mensual_snapshot',
    'warnings_json', 'created_at'
].join(', ');

// SQLite no soporta ALTER de FK → recrea payroll_details preservando datos,
// índices y UNIQUE, cambiando SÓLO employee_id de CASCADE a RESTRICT (run_id
// sigue CASCADE). Patrón de rebuild idéntico a rebuildTimeOffRequestsSqlite.
async function rebuildPayrollDetailsSqlite() {
    await db.exec('PRAGMA foreign_keys=OFF');
    await db.exec('BEGIN');
    try {
        // Defensa de idempotencia: si un rebuild anterior se interrumpió y dejó la
        // tabla temporal, la limpiamos para que el CREATE no falle con
        // "already exists" (que dejaría el arranque en crash-loop irrecuperable).
        await db.exec('DROP TABLE IF EXISTS payroll_details_v2new');
        await db.exec(`CREATE TABLE payroll_details_v2new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            run_id INTEGER NOT NULL,
            employee_id INTEGER NOT NULL,
            sueldo_base REAL NOT NULL DEFAULT 0,
            fondos_reserva REAL NOT NULL DEFAULT 0,
            decimo_tercero REAL NOT NULL DEFAULT 0,
            decimo_cuarto REAL NOT NULL DEFAULT 0,
            horas_extra REAL NOT NULL DEFAULT 0,
            otros_ingresos REAL NOT NULL DEFAULT 0,
            total_ingresos REAL NOT NULL DEFAULT 0,
            base_aportable REAL NOT NULL DEFAULT 0,
            aporte_personal REAL NOT NULL DEFAULT 0,
            otros_descuentos REAL NOT NULL DEFAULT 0,
            total_descuentos REAL NOT NULL DEFAULT 0,
            neto_a_pagar REAL NOT NULL DEFAULT 0,
            aporte_patronal REAL NOT NULL DEFAULT 0,
            provisiones REAL NOT NULL DEFAULT 0,
            costo_empresa REAL NOT NULL DEFAULT 0,
            iess_personal_pct_snapshot REAL NOT NULL,
            iess_patronal_pct_snapshot REAL NOT NULL,
            fondos_reserva_pct_snapshot REAL NOT NULL,
            sbu_snapshot REAL NOT NULL,
            mensualiza_decimos_snapshot INTEGER NOT NULL DEFAULT 0,
            paga_fondos_mensual_snapshot INTEGER NOT NULL DEFAULT 0,
            warnings_json TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE (run_id, employee_id),
            FOREIGN KEY (run_id) REFERENCES payroll_runs (id) ON DELETE CASCADE,
            FOREIGN KEY (employee_id) REFERENCES hr_employees (id) ON DELETE RESTRICT
        )`);
        await db.exec(`INSERT INTO payroll_details_v2new (${PAYROLL_DETAILS_COLS})
                       SELECT ${PAYROLL_DETAILS_COLS} FROM payroll_details`);
        await db.exec('DROP TABLE payroll_details');
        await db.exec('ALTER TABLE payroll_details_v2new RENAME TO payroll_details');
        await db.exec('CREATE INDEX IF NOT EXISTS idx_payroll_details_run ON payroll_details(run_id)');
        await db.exec('CREATE INDEX IF NOT EXISTS idx_payroll_details_emp ON payroll_details(employee_id)');
        await db.exec('COMMIT');
    } catch (err) {
        await db.exec('ROLLBACK');
        throw err;
    } finally {
        await db.exec('PRAGMA foreign_keys=ON');
    }
}

// Nómina v2: endurece la FK payroll_details.employee_id de CASCADE → RESTRICT.
// Inmutabilidad a nivel DB: borrar un empleado NO debe destruir sus renglones en
// roles SELLADOS (el guard app-side en deleteEmployee ya lo bloquea; esto es la
// segunda capa). run_id sigue CASCADE: borrar un BORRADOR sí limpia sus detalles.
// Idempotente: chequea la regla de borrado actual y no hace nada si ya migró.
async function migratePayrollV2() {
    if (db.driver === 'postgres') {
        // ¿Existe la tabla? (to_regclass distingue "no existe" de "existe pero
        // perdió la FK" — evita el skip silencioso si la FK fue dropeada a medias).
        const tbl = await db.queryOne("SELECT to_regclass('public.payroll_details') AS t");
        if (!tbl || !tbl.t) return;                       // la tabla aún no existe
        // FK actual de employee_id, ACOTADA al schema public y determinista
        // (los nombres de constraint son únicos por schema, no globales).
        const fk = await db.queryOne(`
            SELECT tc.constraint_name, rc.delete_rule
            FROM information_schema.table_constraints tc
            JOIN information_schema.referential_constraints rc
              ON rc.constraint_name = tc.constraint_name
             AND rc.constraint_schema = tc.table_schema
            JOIN information_schema.key_column_usage kcu
              ON kcu.constraint_name = tc.constraint_name
             AND kcu.table_schema = tc.table_schema
            WHERE tc.table_schema = 'public'
              AND tc.table_name = 'payroll_details'
              AND tc.constraint_type = 'FOREIGN KEY'
              AND kcu.column_name = 'employee_id'
            ORDER BY tc.constraint_name
            LIMIT 1
        `);
        if (fk && fk.delete_rule !== 'CASCADE') return;   // ya RESTRICT/NO ACTION
        // CASCADE → migrar; FK ausente (raro: dropeada a medias) → re-crear.
        // db.transaction garantiza BEGIN/COMMIT/ROLLBACK + release de la conexión
        // del pool (no usar db.exec con BEGIN embebido: no libera bien en error).
        await db.transaction(async (tx) => {
            if (fk) {
                await tx.execute(`ALTER TABLE payroll_details DROP CONSTRAINT "${fk.constraint_name}"`);
            }
            await tx.execute(`ALTER TABLE payroll_details
                ADD CONSTRAINT payroll_details_employee_id_fkey
                FOREIGN KEY (employee_id) REFERENCES hr_employees (id) ON DELETE RESTRICT`);
        });
        console.log('🔒 Nómina v2: FK employee_id → RESTRICT (Postgres).');
        return;
    }
    // SQLite
    const exists = await db.queryOne(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='payroll_details'"
    );
    if (!exists) return;
    const fks = await db.query('PRAGMA foreign_key_list(payroll_details)');
    const empFk = fks.find(f => f.from === 'employee_id');
    if (!empFk || empFk.on_delete !== 'CASCADE') return;  // ya migrado o sin FK CASCADE
    await rebuildPayrollDetailsSqlite();
    console.log('🔒 Nómina v2: FK employee_id → RESTRICT (SQLite rebuild).');
}

async function migratePayrollV1() {
    const isPg = db.driver === 'postgres';

    // ---- (a) Tablas de nómina disponibles también en prod (idempotente). ----
    // Tipos por-driver: REAL (SQLite) vs NUMERIC(p,s) (PG); AUTOINCREMENT vs
    // SERIAL; DATETIME vs TIMESTAMP. Coinciden EXACTO con config/schema/*.sql.
    if (isPg) {
        await db.exec(`
            CREATE TABLE IF NOT EXISTS payroll_parameters (
                id SERIAL PRIMARY KEY,
                key TEXT UNIQUE NOT NULL,
                label TEXT NOT NULL,
                value_type TEXT NOT NULL CHECK(value_type IN ('percentage','money','number')),
                value NUMERIC(12,4) NOT NULL,
                unit TEXT,
                description TEXT,
                updated_by INTEGER,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (updated_by) REFERENCES users (id)
            );
            CREATE TABLE IF NOT EXISTS payroll_runs (
                id SERIAL PRIMARY KEY,
                period_month INTEGER NOT NULL,
                period_year INTEGER NOT NULL,
                status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','finalized')),
                sbu_snapshot NUMERIC(12,2) NOT NULL,
                total_ingresos NUMERIC(14,2) NOT NULL DEFAULT 0,
                total_descuentos NUMERIC(14,2) NOT NULL DEFAULT 0,
                total_neto NUMERIC(14,2) NOT NULL DEFAULT 0,
                total_costo_empresa NUMERIC(14,2) NOT NULL DEFAULT 0,
                notes TEXT,
                generated_by INTEGER NOT NULL,
                finalized_by INTEGER,
                finalized_at TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE (period_month, period_year),
                FOREIGN KEY (generated_by) REFERENCES users (id),
                FOREIGN KEY (finalized_by) REFERENCES users (id)
            );
            CREATE TABLE IF NOT EXISTS payroll_details (
                id SERIAL PRIMARY KEY,
                run_id INTEGER NOT NULL,
                employee_id INTEGER NOT NULL,
                sueldo_base NUMERIC(12,2) NOT NULL DEFAULT 0,
                fondos_reserva NUMERIC(12,2) NOT NULL DEFAULT 0,
                decimo_tercero NUMERIC(12,2) NOT NULL DEFAULT 0,
                decimo_cuarto NUMERIC(12,2) NOT NULL DEFAULT 0,
                horas_extra NUMERIC(12,2) NOT NULL DEFAULT 0,
                otros_ingresos NUMERIC(12,2) NOT NULL DEFAULT 0,
                total_ingresos NUMERIC(12,2) NOT NULL DEFAULT 0,
                base_aportable NUMERIC(12,2) NOT NULL DEFAULT 0,
                aporte_personal NUMERIC(12,2) NOT NULL DEFAULT 0,
                otros_descuentos NUMERIC(12,2) NOT NULL DEFAULT 0,
                total_descuentos NUMERIC(12,2) NOT NULL DEFAULT 0,
                neto_a_pagar NUMERIC(12,2) NOT NULL DEFAULT 0,
                aporte_patronal NUMERIC(12,2) NOT NULL DEFAULT 0,
                provisiones NUMERIC(12,2) NOT NULL DEFAULT 0,
                costo_empresa NUMERIC(12,2) NOT NULL DEFAULT 0,
                iess_personal_pct_snapshot NUMERIC(8,4) NOT NULL,
                iess_patronal_pct_snapshot NUMERIC(8,4) NOT NULL,
                fondos_reserva_pct_snapshot NUMERIC(8,4) NOT NULL,
                sbu_snapshot NUMERIC(12,2) NOT NULL,
                mensualiza_decimos_snapshot INTEGER NOT NULL DEFAULT 0,
                paga_fondos_mensual_snapshot INTEGER NOT NULL DEFAULT 0,
                warnings_json TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE (run_id, employee_id),
                FOREIGN KEY (run_id) REFERENCES payroll_runs (id) ON DELETE CASCADE,
                FOREIGN KEY (employee_id) REFERENCES hr_employees (id) ON DELETE RESTRICT
            );
            CREATE INDEX IF NOT EXISTS idx_payroll_runs_period ON payroll_runs(period_year, period_month);
            CREATE INDEX IF NOT EXISTS idx_payroll_runs_status ON payroll_runs(status);
            CREATE INDEX IF NOT EXISTS idx_payroll_details_run ON payroll_details(run_id);
            CREATE INDEX IF NOT EXISTS idx_payroll_details_emp ON payroll_details(employee_id);
        `);
    } else {
        await db.exec(`
            CREATE TABLE IF NOT EXISTS payroll_parameters (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                key TEXT UNIQUE NOT NULL,
                label TEXT NOT NULL,
                value_type TEXT NOT NULL CHECK(value_type IN ('percentage','money','number')),
                value REAL NOT NULL,
                unit TEXT,
                description TEXT,
                updated_by INTEGER,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (updated_by) REFERENCES users (id)
            );
            CREATE TABLE IF NOT EXISTS payroll_runs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                period_month INTEGER NOT NULL,
                period_year INTEGER NOT NULL,
                status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','finalized')),
                sbu_snapshot REAL NOT NULL,
                total_ingresos REAL NOT NULL DEFAULT 0,
                total_descuentos REAL NOT NULL DEFAULT 0,
                total_neto REAL NOT NULL DEFAULT 0,
                total_costo_empresa REAL NOT NULL DEFAULT 0,
                notes TEXT,
                generated_by INTEGER NOT NULL,
                finalized_by INTEGER,
                finalized_at DATETIME,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                UNIQUE (period_month, period_year),
                FOREIGN KEY (generated_by) REFERENCES users (id),
                FOREIGN KEY (finalized_by) REFERENCES users (id)
            );
            CREATE TABLE IF NOT EXISTS payroll_details (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                run_id INTEGER NOT NULL,
                employee_id INTEGER NOT NULL,
                sueldo_base REAL NOT NULL DEFAULT 0,
                fondos_reserva REAL NOT NULL DEFAULT 0,
                decimo_tercero REAL NOT NULL DEFAULT 0,
                decimo_cuarto REAL NOT NULL DEFAULT 0,
                horas_extra REAL NOT NULL DEFAULT 0,
                otros_ingresos REAL NOT NULL DEFAULT 0,
                total_ingresos REAL NOT NULL DEFAULT 0,
                base_aportable REAL NOT NULL DEFAULT 0,
                aporte_personal REAL NOT NULL DEFAULT 0,
                otros_descuentos REAL NOT NULL DEFAULT 0,
                total_descuentos REAL NOT NULL DEFAULT 0,
                neto_a_pagar REAL NOT NULL DEFAULT 0,
                aporte_patronal REAL NOT NULL DEFAULT 0,
                provisiones REAL NOT NULL DEFAULT 0,
                costo_empresa REAL NOT NULL DEFAULT 0,
                iess_personal_pct_snapshot REAL NOT NULL,
                iess_patronal_pct_snapshot REAL NOT NULL,
                fondos_reserva_pct_snapshot REAL NOT NULL,
                sbu_snapshot REAL NOT NULL,
                mensualiza_decimos_snapshot INTEGER NOT NULL DEFAULT 0,
                paga_fondos_mensual_snapshot INTEGER NOT NULL DEFAULT 0,
                warnings_json TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                UNIQUE (run_id, employee_id),
                FOREIGN KEY (run_id) REFERENCES payroll_runs (id) ON DELETE CASCADE,
                FOREIGN KEY (employee_id) REFERENCES hr_employees (id) ON DELETE RESTRICT
            );
            CREATE INDEX IF NOT EXISTS idx_payroll_runs_period ON payroll_runs(period_year, period_month);
            CREATE INDEX IF NOT EXISTS idx_payroll_runs_status ON payroll_runs(status);
            CREATE INDEX IF NOT EXISTS idx_payroll_details_run ON payroll_details(run_id);
            CREATE INDEX IF NOT EXISTS idx_payroll_details_emp ON payroll_details(employee_id);
        `);
    }

    // ---- (b) Columnas de mensualización en hr_employees (DBs existentes). ----
    // Las dos son INTEGER 0/1; NOT NULL DEFAULT 0 es seguro sobre filas viejas.
    const EMPLOYEE_FLAG_COLUMNS = ['mensualiza_decimos', 'paga_fondos_mensual'];
    if (isPg) {
        const cols = await db.query(
            "SELECT column_name FROM information_schema.columns WHERE table_name = 'hr_employees'"
        );
        const have = new Set(cols.map(c => c.column_name));
        for (const name of EMPLOYEE_FLAG_COLUMNS) {
            if (!have.has(name)) {
                await db.exec(`ALTER TABLE hr_employees ADD COLUMN ${name} INTEGER NOT NULL DEFAULT 0`);
                console.log(`🔧 Migración Nómina: columna ${name} añadida a hr_employees`);
            }
        }
    } else {
        const cols = await db.query('PRAGMA table_info(hr_employees)');
        const have = new Set(cols.map(c => c.name));
        for (const name of EMPLOYEE_FLAG_COLUMNS) {
            if (!have.has(name)) {
                await db.exec(`ALTER TABLE hr_employees ADD COLUMN ${name} INTEGER NOT NULL DEFAULT 0`);
                console.log(`🔧 Migración Nómina: columna ${name} añadida a hr_employees`);
            }
        }
    }

    // ---- (c) Seed de los 4 parámetros legales (idempotente por key). ----
    // [key, label, value_type, value, unit, description]. insertOrIgnore NO
    // pisa un value ya editado por RRHH (sólo inserta si la key no existe).
    const PARAMS = [
        ['iess_personal_pct',  'Aporte personal IESS (%)',  'percentage', 9.45,  '%',   'Aporte personal del trabajador al IESS (relación de dependencia).'],
        ['iess_patronal_pct',  'Aporte patronal IESS (%)',  'percentage', 11.15, '%',   'Aporte patronal del empleador al IESS.'],
        ['sbu',                'Salario Básico Unificado',  'money',      470,   'USD', 'SBU vigente en Ecuador; base del décimo cuarto.'],
        ['fondos_reserva_pct', 'Fondos de reserva (%)',     'percentage', 8.33,  '%',   'Porcentaje mensual de fondos de reserva (tras 1 año de antigüedad).']
    ];
    for (const [key, label, value_type, value, unit, description] of PARAMS) {
        await db.execute(
            insertOrIgnore('payroll_parameters', ['key', 'label', 'value_type', 'value', 'unit', 'description'], 'key'),
            [key, label, value_type, value, unit, description]
        );
    }
    console.log(`💵 Nómina: ${PARAMS.length} parámetros legales sembrados (idempotente por key)`);
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
        ['hr.salary.write',    'hr',         'salary.write', 'Editar el salario base de empleados (separación de funciones para nómina)'],
        ['hr.documents.upload','hr',         'documents.upload', 'Subir documentos al expediente del empleado'],
        ['hr.positions.manage','hr',         'positions.manage', 'CRUD de perfiles de cargo'],
        // PR-3b: feriados y banco de días compensados
        ['hr.holidays.manage', 'hr',         'holidays.manage',  'CRUD de feriados (RRHH)'],
        ['hr.attendance.manage','hr',        'attendance.manage','Registrar asistencia a feriados (RRHH)'],
        // PR-3c: solicitudes de tiempo libre
        ['hr.timeoff.request', 'hr',         'timeoff.request',  'Solicitar días libres (cualquier empleado)'],
        ['hr.timeoff.approve', 'hr',         'timeoff.approve',  'Aprobar/rechazar solicitudes (jefe / RRHH)'],
        // F1: override "justificado sin descuento" (exclusivo TTHH/gerencia).
        ['hr.timeoff.waive_discount', 'hr',  'timeoff.waive_discount', 'Justificar una solicitud sin descuento de saldo (override exclusivo TTHH)'],
        // PR-3d: memos / comunicados
        ['hr.memos.read',      'hr',         'memos.read',       'Leer los propios memos / comunicados'],
        ['hr.memos.write',     'hr',         'memos.write',      'Emitir memos a empleados (RRHH/Gerencia)'],
        // Nómina / Roles de pago (v1.2)
        ['hr.payroll.read',         'hr', 'payroll.read',         'Ver parámetros, corridas y el propio rol (empleado: SÓLO su renglón, SIN totales)'],
        ['hr.payroll.read.all',     'hr', 'payroll.read.all',     'Ver total_* agregados y TODOS los renglones (gate de PII de nómina; desacoplado de hr.read.all)'],
        ['hr.payroll.params.write', 'hr', 'payroll.params.write', 'Editar parámetros de nómina (auditado)'],
        ['hr.payroll.run',          'hr', 'payroll.run',          'Generar y finalizar corridas de rol de pago']
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
        'hr.read.own',   // necesario para acceder al módulo RRHH en el sidebar
        'hr.read.all', 'hr.write', 'hr.salary.write', 'hr.documents.upload', 'hr.positions.manage',
        'hr.holidays.manage', 'hr.attendance.manage',  // PR-3b
        'hr.timeoff.approve',                           // PR-3c
        'hr.timeoff.waive_discount',                    // F1: override de descuento (TTHH)
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

    // Nómina (v1.2). Gate de total_* = hr.payroll.read.all (NO hr.read.all):
    // jefe_contabilidad NO tiene hr.read.all pero debe ver los totales del rol que opera.
    const payrollFullPerms = ['hr.payroll.read', 'hr.payroll.read.all', 'hr.payroll.params.write', 'hr.payroll.run'];
    await grantPermsToRole('rrhh', payrollFullPerms);
    await grantPermsToRole('jefe_contabilidad', payrollFullPerms);
    await grantPermsToRole('empleado', ['hr.payroll.read']);

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

    // Conteo dinámico para que el log no se desfase cuando se agreguen roles/permisos.
    console.log(`🛡️  RBAC: ${ROLES.length} roles, ${PERMS.length} permisos, ${DEPTS.length} departamentos sembrados; admin asignado a Gerencia.`);
}

async function seedSystemConfig() {
    await db.execute(
        insertOrIgnore('system_config', ['config_key', 'config_value', 'description'], 'config_key'),
        ['max_report_windows', '5', 'Máximo de ventanas de reportes abiertas simultáneamente']
    );
}

async function seedUsers() {
    const isProd = process.env.NODE_ENV === 'production';
    const cols = ['username', 'email', 'password', 'full_name', 'role', 'must_change_password'];

    // Admin: en prod el password sale de SEED_ADMIN_PASSWORD si está seteado; si
    // no, cae a 'admin123' PERO con must_change_password=1 (la primera entrada lo
    // fuerza a cambiar). insertOrIgnore: si el admin YA existe, NO se pisa su pass.
    const adminPwd = bcrypt.hashSync(process.env.SEED_ADMIN_PASSWORD || 'admin123', 10);
    await db.execute(
        insertOrIgnore('users', cols, 'username'),
        ['admin', 'admin@powerbi.local', adminPwd, 'Administrador', 'admin', 1]
    );

    if (isProd) {
        // El usuario de PRUEBA no debe vivir en producción. No lo sembramos, y si
        // quedó de un seed viejo y nunca se usó (pass de ejemplo intacta), lo
        // DESACTIVAMOS para que no sea un foothold. Idempotente (sólo toca el test
        // user pristino y una sola vez; no borra datos).
        const r = await db.execute(
            "UPDATE users SET is_active = 0 WHERE username = 'usuario1' AND email = 'usuario1@test.com' AND must_change_password = 1 AND is_active = 1",
            []
        );
        if (r.changes) console.log('🔒 Usuario de prueba "usuario1" desactivado en producción.');
        console.log('👤 Usuario admin listo (test user no se siembra en prod).');
        return;
    }

    // Dev: sí sembramos el usuario de prueba para poder testear.
    const testPwd = bcrypt.hashSync('user123', 10);
    await db.execute(
        insertOrIgnore('users', cols, 'username'),
        ['usuario1', 'usuario1@test.com', testPwd, 'Usuario de Prueba', 'user', 1]
    );
    console.log('👤 Usuarios admin / usuario1 listos (dev).');
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
    await migrateDocumentDownloadFlag();   // F2: flag de descarga de documentos
    // F1: agrega las columnas del workflow multinivel a time_off_requests en
    // instalaciones existentes (las tablas nuevas ya las creó loadSchema).
    await migrateTimeOffWorkflowF1();
    await migratePayrollV1();          // Nómina v1.2: tablas + columnas + parámetros legales
    await migratePayrollV2();          // Nómina v2: FK employee_id CASCADE → RESTRICT (inmutabilidad)
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
    // Sólo mostramos credenciales de ejemplo en DEV. En prod la pass del admin
    // sale de SEED_ADMIN_PASSWORD (o exige cambio en el primer login) y no hay
    // usuario de prueba → no imprimimos nada engañoso.
    if (process.env.NODE_ENV !== 'production') {
        console.log('👤 Usuario admin: admin / admin123');
        console.log('👤 Usuario test: usuario1 / user123');
    }
}

// Si se ejecuta como script (node config/init-db.js), correr y salir.
if (require.main === module) {
    init()
        .then(() => db.close())
        .then(() => process.exit(0))
        .catch(err => { console.error(err); process.exit(1); });
}

module.exports = { init, migrateDocumentDownloadFlag };
