/**
 * Driver SQLite — adapta better-sqlite3 (sincrono) a la interfaz async comun.
 * Mantiene el comportamiento actual del Portal sin cambios visibles.
 */
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dbPath = path.resolve(process.env.DB_PATH || './database/powerbi_reports.db');
const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

const handle = new Database(dbPath);
handle.pragma('foreign_keys = ON');
handle.pragma('journal_mode = WAL');
handle.pragma('synchronous = NORMAL');

console.log(`📦 [db] driver=sqlite  path=${dbPath}`);

/**
 * Ejecuta SELECT y devuelve todas las filas.
 * @param {string} sql  - SQL con placeholders ?
 * @param {Array}  [params=[]]
 * @returns {Promise<Array<object>>}
 */
async function query(sql, params = []) {
    const stmt = handle.prepare(sql);
    return stmt.all(...params);
}

/**
 * Ejecuta SELECT y devuelve la primera fila (o undefined).
 */
async function queryOne(sql, params = []) {
    const stmt = handle.prepare(sql);
    return stmt.get(...params);
}

/**
 * Ejecuta INSERT/UPDATE/DELETE.
 * Devuelve { changes, lastInsertId } — uniformiza con la version PG.
 */
async function execute(sql, params = []) {
    const stmt = handle.prepare(sql);
    const info = stmt.run(...params);
    return {
        changes: info.changes,
        lastInsertId: info.lastInsertRowid !== undefined
            ? Number(info.lastInsertRowid)
            : null
    };
}

/**
 * Transaccion. BEGIN / COMMIT / ROLLBACK manual sobre la conexion global.
 *
 * NOTA importante: better-sqlite3 es sync y la conexion es unica. Mientras dura
 * la transaccion, cualquier OTRA query del proceso (otra request HTTP, etc.)
 * vera el estado intermedio. Para nuestro uso (transacciones cortas sin awaits
 * a IO externa) es seguro. Si en algun momento agregamos awaits largos dentro
 * del callback, hay que reconsiderarlo o moverlo a postgres.
 */
async function transaction(callback) {
    const txObj = {
        query: async (sql, params = []) => handle.prepare(sql).all(...(params || [])),
        queryOne: async (sql, params = []) => handle.prepare(sql).get(...(params || [])),
        execute: async (sql, params = []) => {
            const info = handle.prepare(sql).run(...(params || []));
            return {
                changes: info.changes,
                lastInsertId: info.lastInsertRowid !== undefined
                    ? Number(info.lastInsertRowid)
                    : null
            };
        }
    };

    handle.exec('BEGIN');
    try {
        const result = await callback(txObj);
        handle.exec('COMMIT');
        return result;
    } catch (err) {
        try { handle.exec('ROLLBACK'); } catch (_) { /* ignore */ }
        throw err;
    }
}

/**
 * Ejecuta multiples statements separados por ;
 * Util para correr scripts de schema (init-db).
 */
async function exec(sqlScript) {
    handle.exec(sqlScript);
}

/**
 * Acceso al handle nativo. Solo para casos legacy / migracion.
 * NO usar en codigo de aplicacion nuevo.
 */
function _native() {
    return handle;
}

async function close() {
    handle.close();
}

module.exports = {
    driver: 'sqlite',
    query,
    queryOne,
    execute,
    transaction,
    exec,
    close,
    _native
};
