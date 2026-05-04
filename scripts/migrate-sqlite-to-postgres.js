/**
 * Migración SQLite → PostgreSQL.
 *
 * Lee la DB SQLite del path indicado y vuelca el contenido en PostgreSQL.
 *
 * Uso:
 *   node scripts/migrate-sqlite-to-postgres.js [--sqlite=ruta/al/archivo.db] [--truncate]
 *
 * Variables de entorno:
 *   DATABASE_URL    URL del PG destino (default: la del .env)
 *   DB_PATH         path del SQLite origen (default: ./database/powerbi_reports.db)
 *
 * Flags:
 *   --truncate      Borra las tablas de PG antes de migrar (recomendado).
 *                   Sin este flag, intenta INSERT y aborta si hay conflicto de PK.
 *   --dry-run       Solo cuenta filas, no escribe nada.
 *
 * Estrategia:
 *   1. Lee config y abre ambas conexiones.
 *   2. Si --truncate, vacía las tablas PG en orden de dependencia inversa.
 *   3. Para cada tabla, lee SQLite por chunks y escribe en PG dentro de una transacción.
 *   4. Resetea las secuencias SERIAL en PG (para que el próximo INSERT auto-id continúe).
 *   5. Verifica que los counts cuadren entre SQLite y PG.
 *
 * NO modifica la DB SQLite origen. Es safe correrlo varias veces (con --truncate).
 */
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { Pool } = require('pg');
require('dotenv').config();

// =============== Config ===============
const args = process.argv.slice(2);
const argMap = Object.fromEntries(
    args.filter(a => a.startsWith('--')).map(a => {
        const [k, v] = a.replace(/^--/, '').split('=');
        return [k, v === undefined ? true : v];
    })
);

const SQLITE_PATH = path.resolve(argMap.sqlite || process.env.DB_PATH || './database/powerbi_reports.db');
const PG_URL = process.env.DATABASE_URL;
const TRUNCATE = !!argMap.truncate;
const DRY_RUN = !!argMap['dry-run'];

if (!PG_URL) {
    console.error('❌ DATABASE_URL no definida. Configurala en .env o pásala como env var.');
    process.exit(1);
}
if (!fs.existsSync(SQLITE_PATH)) {
    console.error(`❌ No existe el SQLite en: ${SQLITE_PATH}`);
    process.exit(1);
}

const useSSL = /sslmode=require/.test(PG_URL)
    || (process.env.NODE_ENV === 'production' && !PG_URL.includes('localhost'));

const sqlite = new Database(SQLITE_PATH, { readonly: true });
const pg = new Pool({
    connectionString: PG_URL,
    ssl: useSSL ? { rejectUnauthorized: false } : false
});

// =============== Tablas en orden de dependencia ===============
// Cada entrada: { name, columns, sequence }
// 'columns' explicita el orden de columnas para el INSERT (el ID se incluye
// para preservar relaciones entre tablas).
const TABLES = [
    {
        name: 'users',
        columns: ['id', 'username', 'email', 'password', 'plain_password', 'full_name', 'role', 'is_active', 'created_at', 'updated_at'],
        sequence: 'users_id_seq'
    },
    {
        name: 'reports',
        columns: ['id', 'name', 'description', 'embed_url', 'category', 'is_active', 'created_at', 'updated_at'],
        sequence: 'reports_id_seq'
    },
    {
        name: 'user_report_permissions',
        columns: ['id', 'user_id', 'report_id', 'can_view', 'can_export', 'granted_at', 'granted_by'],
        sequence: 'user_report_permissions_id_seq'
    },
    {
        name: 'documents',
        columns: ['id', 'name', 'description', 'category', 'file_name', 'mime_type', 'file_size', 'file_data', 'is_active', 'uploaded_by', 'created_at', 'updated_at'],
        sequence: 'documents_id_seq',
        bytea: ['file_data']  // columnas BLOB en SQLite que van como BYTEA en PG
    },
    {
        name: 'user_document_permissions',
        columns: ['id', 'user_id', 'document_id', 'can_view', 'granted_at', 'granted_by'],
        sequence: 'user_document_permissions_id_seq'
    },
    {
        name: 'access_logs',
        columns: ['id', 'user_id', 'report_id', 'document_id', 'action', 'ip_address', 'user_agent', 'timestamp'],
        sequence: 'access_logs_id_seq'
    },
    {
        name: 'system_config',
        columns: ['id', 'config_key', 'config_value', 'description', 'updated_at'],
        sequence: 'system_config_id_seq'
    },
    // Cotizador (puede estar vacío en la SQLite origen — eso está bien)
    {
        name: 'destinos',
        columns: ['id', 'codigo_iata', 'nombre', 'pais', 'porcentaje_arancel', 'porcentaje_impuesto_consumo', 'is_active', 'created_at'],
        sequence: 'destinos_id_seq',
        optional: true
    },
    {
        name: 'cargueras',
        columns: ['id', 'nombre', 'is_active', 'created_at'],
        sequence: 'cargueras_id_seq',
        optional: true
    },
    {
        name: 'tarifas_carguera',
        columns: ['id', 'id_carguera', 'id_destino', 'peso_minimo', 'peso_maximo', 'tarifa_kilo', 'costo_cuarto_frio_kilo', 'costo_documentacion_fijo', 'fecha_inicio', 'fecha_fin', 'created_at'],
        sequence: 'tarifas_carguera_id_seq',
        optional: true
    },
    {
        name: 'tarifas_destino',
        columns: ['id', 'id_destino', 'aduana_fija', 'transporte_interno_caja', 'rubros_dinamicos', 'fecha_inicio', 'fecha_fin', 'created_at'],
        sequence: 'tarifas_destino_id_seq',
        optional: true,
        json: ['rubros_dinamicos']  // SQLite TEXT JSON → PG JSONB
    },
    {
        name: 'cotizaciones_historico',
        columns: ['id', 'user_id', 'fecha_proyeccion', 'snapshot', 'created_at'],
        sequence: 'cotizaciones_historico_id_seq',
        optional: true,
        json: ['snapshot']
    }
];

// =============== Helpers ===============
function tableExistsInSqlite(name) {
    const r = sqlite.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name = ?"
    ).get(name);
    return !!r;
}

function countRows(table) {
    const r = sqlite.prepare(`SELECT COUNT(*) as c FROM ${table}`).get();
    return r.c;
}

async function pgCount(table) {
    const r = await pg.query(`SELECT COUNT(*) as c FROM ${table}`);
    return Number(r.rows[0].c);
}

async function truncateAll() {
    console.log('🧹 Truncando tablas en PG (orden inverso a dependencias)...');
    const reversed = [...TABLES].reverse();
    const client = await pg.connect();
    try {
        await client.query('BEGIN');
        for (const t of reversed) {
            try {
                await client.query(`TRUNCATE TABLE ${t.name} RESTART IDENTITY CASCADE`);
            } catch (e) {
                // Si la tabla no existe en PG, lo ignoramos
                console.log(`   (skip ${t.name}: ${e.message})`);
            }
        }
        await client.query('COMMIT');
        console.log('   ✓ truncate OK');
    } catch (e) {
        await client.query('ROLLBACK');
        throw e;
    } finally {
        client.release();
    }
}

// Convierte una fila de SQLite al formato esperado por pg (Buffer para BYTEA, JSONB stringificado, etc.)
function adaptRow(row, table) {
    const out = {};
    for (const col of table.columns) {
        let val = row[col];
        // BLOB → Buffer (better-sqlite3 ya devuelve Buffer)
        if (table.bytea && table.bytea.includes(col) && val != null && !Buffer.isBuffer(val)) {
            val = Buffer.from(val);
        }
        // JSON: si viene como string, dejar string para que pg lo parsee como JSONB
        // (pg acepta string JSON válido para columna JSONB)
        if (table.json && table.json.includes(col) && val != null && typeof val !== 'string') {
            val = JSON.stringify(val);
        }
        out[col] = val;
    }
    return out;
}

async function migrateTable(table) {
    if (!tableExistsInSqlite(table.name)) {
        if (table.optional) {
            console.log(`📭 Tabla ${table.name} no existe en SQLite (es opcional, salto)`);
            return { skipped: true, count: 0 };
        }
        throw new Error(`Tabla ${table.name} no existe en SQLite`);
    }

    const total = countRows(table.name);
    console.log(`📋 ${table.name}: ${total} filas en SQLite`);

    if (total === 0 || DRY_RUN) {
        return { skipped: false, count: 0 };
    }

    // Leer toda la tabla (asumimos que cabe en memoria — para volúmenes mayores se podría chunkear)
    const colsList = table.columns.join(', ');
    const rows = sqlite.prepare(`SELECT ${colsList} FROM ${table.name}`).all();

    // Insertar en PG dentro de una transacción
    const placeholders = table.columns.map((_, i) => `$${i + 1}`).join(', ');
    const insertSql = `INSERT INTO ${table.name} (${colsList}) VALUES (${placeholders})`;

    const client = await pg.connect();
    try {
        await client.query('BEGIN');
        let inserted = 0;
        for (const r of rows) {
            const adapted = adaptRow(r, table);
            const values = table.columns.map(c => adapted[c]);
            try {
                await client.query(insertSql, values);
                inserted++;
            } catch (e) {
                console.error(`   ❌ Error insertando fila ${JSON.stringify(r).slice(0, 200)}: ${e.message}`);
                throw e;
            }
        }
        await client.query('COMMIT');
        console.log(`   ✓ ${inserted} filas insertadas en PG`);
        return { skipped: false, count: inserted };
    } catch (e) {
        await client.query('ROLLBACK');
        throw e;
    } finally {
        client.release();
    }
}

async function resetSequence(table) {
    if (DRY_RUN) return;
    if (!table.sequence) return;
    try {
        // setval al máximo id actual; si no hay filas usa 1
        await pg.query(`
            SELECT setval(
                '${table.sequence}',
                COALESCE((SELECT MAX(id) FROM ${table.name}), 1),
                (SELECT MAX(id) FROM ${table.name}) IS NOT NULL
            )
        `);
    } catch (e) {
        console.log(`   (no se pudo reset secuencia ${table.sequence}: ${e.message})`);
    }
}

async function verifyCounts() {
    console.log('\n🔍 Verificando counts SQLite ↔ PostgreSQL...');
    let allOk = true;
    for (const t of TABLES) {
        if (!tableExistsInSqlite(t.name)) continue;
        const sCount = countRows(t.name);
        let pCount;
        try {
            pCount = await pgCount(t.name);
        } catch (e) {
            console.log(`   ${t.name}: ⚠️ no existe en PG (${e.message})`);
            allOk = false;
            continue;
        }
        const ok = sCount === pCount;
        if (!ok) allOk = false;
        console.log(`   ${ok ? '✓' : '✗'} ${t.name.padEnd(28)} sqlite=${sCount}  pg=${pCount}`);
    }
    return allOk;
}

// =============== Main ===============
(async () => {
    console.log('═══════════════════════════════════════════════════════');
    console.log(' Migración SQLite → PostgreSQL');
    console.log('═══════════════════════════════════════════════════════');
    console.log(`  SQLite origen : ${SQLITE_PATH}`);
    console.log(`  PG destino    : ${PG_URL.replace(/:[^:@]+@/, ':****@')}`);
    console.log(`  --truncate    : ${TRUNCATE}`);
    console.log(`  --dry-run     : ${DRY_RUN}`);
    console.log('───────────────────────────────────────────────────────');

    try {
        if (TRUNCATE && !DRY_RUN) {
            await truncateAll();
        }

        for (const table of TABLES) {
            await migrateTable(table);
            await resetSequence(table);
        }

        const ok = await verifyCounts();
        console.log('───────────────────────────────────────────────────────');
        if (ok) {
            console.log('✅ Migración exitosa: counts coinciden en todas las tablas.');
            process.exit(0);
        } else {
            console.log('⚠️  Migración con discrepancias. Revisa la lista de arriba.');
            process.exit(2);
        }
    } catch (e) {
        console.error('\n❌ FALLO en migración:', e.message);
        if (e.stack) console.error(e.stack);
        process.exit(1);
    } finally {
        sqlite.close();
        await pg.end();
    }
})();
