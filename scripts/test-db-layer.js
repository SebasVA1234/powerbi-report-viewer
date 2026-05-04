/**
 * Test manual de la capa de DB.
 * Uso: node scripts/test-db-layer.js [sqlite|postgres]
 */
process.env.DB_DRIVER = process.argv[2] || 'sqlite';
require('dotenv').config();

const { translateToPg } = require('../config/db/translate');

console.log('=== translateToPg ===');
const cases = [
    ['SELECT * FROM u WHERE id = ?', 'SELECT * FROM u WHERE id = $1'],
    ["SELECT 'a?b' FROM u WHERE id = ?", "SELECT 'a?b' FROM u WHERE id = $1"],
    ['SELECT ? , ? , ?', 'SELECT $1 , $2 , $3'],
    ["UPDATE t SET name = ?, val = 'it''s ok?' WHERE id = ?", "UPDATE t SET name = $1, val = 'it''s ok?' WHERE id = $2"]
];
let ok = true;
for (const [input, expected] of cases) {
    const got = translateToPg(input);
    const pass = got === expected;
    if (!pass) ok = false;
    console.log(pass ? 'OK ' : 'FAIL', input, '->', got);
}
console.log(ok ? 'TRANSLATE OK' : 'TRANSLATE FAILED');
console.log();

(async () => {
    const db = require('../config/db');
    console.log('driver activo:', db.driver);

    // Crear tabla de prueba (compatible con ambos)
    if (db.driver === 'sqlite') {
        await db.exec('DROP TABLE IF EXISTS _t_layer');
        await db.exec('CREATE TABLE _t_layer (id INTEGER PRIMARY KEY AUTOINCREMENT, n TEXT)');
    } else {
        await db.exec('DROP TABLE IF EXISTS _t_layer');
        await db.exec('CREATE TABLE _t_layer (id SERIAL PRIMARY KEY, n TEXT)');
    }

    const r1 = await db.execute('INSERT INTO _t_layer (n) VALUES (?)', ['hola']);
    console.log('insert 1:', r1);
    const r2 = await db.execute('INSERT INTO _t_layer (n) VALUES (?)', ['mundo']);
    console.log('insert 2:', r2);

    const all = await db.query('SELECT * FROM _t_layer ORDER BY id');
    console.log('select all:', all);
    const one = await db.queryOne('SELECT * FROM _t_layer WHERE id = ?', [1]);
    console.log('select one:', one);

    // Transaccion: ambas inserciones o ninguna
    await db.transaction(async tx => {
        await tx.execute('INSERT INTO _t_layer (n) VALUES (?)', ['tx_a']);
        await tx.execute('INSERT INTO _t_layer (n) VALUES (?)', ['tx_b']);
    });
    const after = await db.query('SELECT COUNT(*) as c FROM _t_layer');
    console.log('despues de tx OK, count =', after[0].c, '(esperado: 4)');

    // Transaccion con rollback intencional
    try {
        await db.transaction(async tx => {
            await tx.execute('INSERT INTO _t_layer (n) VALUES (?)', ['rollback_me']);
            throw new Error('fuerza rollback');
        });
    } catch (e) {
        const after2 = await db.query('SELECT COUNT(*) as c FROM _t_layer');
        console.log('despues de rollback, count =', after2[0].c, '(esperado: 4)');
    }

    await db.exec('DROP TABLE _t_layer');
    await db.close();
    console.log(`CAPA OK con driver ${db.driver}`);
})().catch(e => { console.error('FALLO:', e); process.exit(1); });
