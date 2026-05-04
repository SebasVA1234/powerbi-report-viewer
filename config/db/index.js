/**
 * Capa de abstraccion de base de datos.
 *
 * Uso desde controllers:
 *   const db = require('../config/db');
 *   const users = await db.query('SELECT * FROM users WHERE role = ?', ['admin']);
 *   const user  = await db.queryOne('SELECT * FROM users WHERE id = ?', [id]);
 *   const r     = await db.execute('INSERT INTO users (name) VALUES (?)', ['Juan']);
 *   console.log(r.lastInsertId);
 *
 *   await db.transaction(async (tx) => {
 *       await tx.execute(...);
 *       await tx.execute(...);
 *   });
 *
 * Driver activo:
 *   process.env.DB_DRIVER = 'sqlite' | 'postgres'   (default: sqlite)
 */
require('dotenv').config();

const driver = (process.env.DB_DRIVER || 'sqlite').toLowerCase();

let impl;
if (driver === 'postgres' || driver === 'pg') {
    impl = require('./postgres');
} else if (driver === 'sqlite') {
    impl = require('./sqlite');
} else {
    throw new Error(`DB_DRIVER desconocido: "${driver}" (usa "sqlite" o "postgres")`);
}

module.exports = impl;
