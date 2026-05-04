/**
 * @deprecated  Usar `require('../config/db')` con su API async.
 *
 * Este archivo existe SOLO para compatibilidad con controllers que aún
 * importan `../config/database` y usan la API sincrona de better-sqlite3
 * (db.prepare(...).run(), db.exec(...), etc.).
 *
 * En modo SQLite expone el handle nativo de la nueva capa, asegurando que
 * todo el proceso usa UNA sola conexión.
 *
 * En modo PostgreSQL este import falla — eso es intencional: cualquier
 * controller que aún use la API legacy tiene que migrarse a la capa async
 * antes de switchear a postgres.
 */
const db = require('./db');

if (db.driver !== 'sqlite') {
    throw new Error(
        `[config/database.js] driver=${db.driver}. Este import legacy solo funciona con DB_DRIVER=sqlite. ` +
        `Migra el controller que lo importa a la capa async (require('../config/db')).`
    );
}

module.exports = db._native();
