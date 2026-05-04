/**
 * Driver PostgreSQL — usa pg.Pool con la misma API async que el driver SQLite.
 * Acepta SQL con placeholders ? y los traduce a $1, $2, ... internamente.
 */
const { Pool, types } = require('pg');
const { translateToPg } = require('./translate');

// Parsear BIGINT (oid=20) como Number — para que COUNT(*) y otros agregados
// devuelvan number en vez de string. Seguro mientras no manejemos cifras > 2^53.
types.setTypeParser(20, val => val === null ? null : Number(val));

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
    throw new Error('DATABASE_URL no esta definida — necesaria para DB_DRIVER=postgres');
}

// SSL: Railway PG requiere SSL en produccion. En local (Docker), no.
const useSSL = /sslmode=require/.test(connectionString)
    || (process.env.NODE_ENV === 'production' && !connectionString.includes('localhost'));

const pool = new Pool({
    connectionString,
    ssl: useSSL ? { rejectUnauthorized: false } : false,
    max: parseInt(process.env.PG_POOL_MAX || '10', 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000
});

pool.on('error', (err) => {
    console.error('[db:pg] error inesperado en cliente del pool:', err.message);
});

console.log(`📦 [db] driver=postgres  ssl=${useSSL}`);

/**
 * Ejecuta SELECT y devuelve todas las filas.
 */
async function query(sql, params = []) {
    const text = translateToPg(sql);
    const r = await pool.query(text, params);
    return r.rows;
}

/**
 * Ejecuta SELECT y devuelve la primera fila (o undefined).
 */
async function queryOne(sql, params = []) {
    const text = translateToPg(sql);
    const r = await pool.query(text, params);
    return r.rows[0];
}

/**
 * Ejecuta INSERT/UPDATE/DELETE.
 * Para que devuelva lastInsertId en INSERT, automaticamente agrega RETURNING id
 * si la query es un INSERT y no tiene RETURNING aun.
 */
async function execute(sql, params = []) {
    const trimmed = sql.trim();
    const isInsert = /^insert\s/i.test(trimmed);
    const hasReturning = /\sreturning\s/i.test(trimmed);

    let text = translateToPg(sql);
    if (isInsert && !hasReturning) {
        // Agregar RETURNING id (el id auto-incremental de la tabla)
        text = text.replace(/;?\s*$/, '') + ' RETURNING id';
    }

    const r = await pool.query(text, params);
    return {
        changes: r.rowCount,
        lastInsertId: (isInsert && r.rows && r.rows[0] && r.rows[0].id !== undefined)
            ? Number(r.rows[0].id)
            : null
    };
}

/**
 * Transaccion. El callback recibe un tx con la misma API trabajando sobre
 * una conexion dedicada con BEGIN/COMMIT/ROLLBACK automatico.
 */
async function transaction(callback) {
    const client = await pool.connect();
    const txObj = {
        query: async (sql, params = []) => {
            const r = await client.query(translateToPg(sql), params);
            return r.rows;
        },
        queryOne: async (sql, params = []) => {
            const r = await client.query(translateToPg(sql), params);
            return r.rows[0];
        },
        execute: async (sql, params = []) => {
            const trimmed = sql.trim();
            const isInsert = /^insert\s/i.test(trimmed);
            const hasReturning = /\sreturning\s/i.test(trimmed);
            let text = translateToPg(sql);
            if (isInsert && !hasReturning) {
                text = text.replace(/;?\s*$/, '') + ' RETURNING id';
            }
            const r = await client.query(text, params);
            return {
                changes: r.rowCount,
                lastInsertId: (isInsert && r.rows && r.rows[0] && r.rows[0].id !== undefined)
                    ? Number(r.rows[0].id)
                    : null
            };
        }
    };

    try {
        await client.query('BEGIN');
        const result = await callback(txObj);
        await client.query('COMMIT');
        return result;
    } catch (err) {
        try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
        throw err;
    } finally {
        client.release();
    }
}

/**
 * Ejecuta un script SQL multi-statement (init de schema).
 * No usa placeholders.
 */
async function exec(sqlScript) {
    await pool.query(sqlScript);
}

function _native() {
    return pool;
}

async function close() {
    await pool.end();
}

module.exports = {
    driver: 'postgres',
    query,
    queryOne,
    execute,
    transaction,
    exec,
    close,
    _native
};
