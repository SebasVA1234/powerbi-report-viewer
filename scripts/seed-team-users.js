/**
 * Sembrar los usuarios reales de Ecualand (Ventas/Compras/Contabilidad/Direct Money)
 * con sus contraseñas finales (must_change_password=0).
 *
 * Idempotente: si el user ya existe, actualiza la contraseña + must_change_password=0
 * y reasigna depto. No borra users existentes.
 *
 * Run: node scripts/seed-team-users.js
 */
const bcrypt = require('bcryptjs');
const db = require('../config/db');

const TEAMS = [
    { dept: 'ventas', users: [
        ['pilipenko@ecualand.ec', 'Ania Pilipenko',     'Anya@234'],
        ['vokhmin@ecualand.ec',   'Sergio Vokhmin',     'Sergio123'],
        ['sivakova@ecualand.ec',  'Aliona Sivakova',    'Alona123'],
        ['fediaeva@ecualand.ec',  'Svetlana Fediaeva',  'Svetlana@123'],
        ['kisil@ecualand.ec',     'Uliana Kisil',       'Uliana123'],
        ['campuzano@ecualand.ec', 'Maribel Campuzano',  'MarBel@123']
    ]},
    { dept: 'compras', users: [
        ['rivas@ecualand.ec',     'Melanie Rivas',      'Melanie123'],
        ['quirola@ecualand.ec',   'Gabriela Quirola',   'Gaby1234'],
        ['arboleda@ecualand.ec',  'Irene Arboleda',     'Irene@234'],
        ['rodriguez@ecualand.ec', 'Lucy Rodriguez',     'Lucy@234'],
        ['hernandez@ecualand.ec', 'Geovanny Hernandez', 'geovy123']
    ]},
    { dept: 'contabilidad', users: [
        ['tobar@ecualand.ec',      'Liz Tobar',          'Liz@2345'],
        ['guanopatin@ecualand.ec', 'Jorge Guanopatin',   'Jorge123'],
        ['jaramillo@ecualand.ec',  'Norma Jaramillo',    'Norma123'],
        ['vasquez@ecualand.ec',    'Camila Vasquez',     'Camila123']
    ]},
    { dept: 'direct_money', users: [
        ['cartera@ecualand.ec', 'Cartera Direct Money', 'Cartera123@']
    ]}
];

(async () => {
    const created = [];
    const updated = [];
    const adminUser = await db.queryOne('SELECT id FROM users WHERE username = ?', ['admin']);
    const adminId = adminUser ? adminUser.id : 1;

    for (const team of TEAMS) {
        const dept = await db.queryOne('SELECT id FROM departments WHERE code = ?', [team.dept]);
        if (!dept) {
            console.error(`❌ Departamento ${team.dept} no encontrado`);
            continue;
        }
        for (const [email, fullName, password] of team.users) {
            // username = local-part del email
            const username = email.split('@')[0];
            const hashed = bcrypt.hashSync(password, 10);
            const existing = await db.queryOne(
                'SELECT id FROM users WHERE email = ? OR username = ?',
                [email, username]
            );

            let userId;
            if (existing) {
                userId = existing.id;
                await db.execute(
                    `UPDATE users SET password = ?, full_name = ?, must_change_password = 0,
                                       is_active = 1, updated_at = CURRENT_TIMESTAMP
                     WHERE id = ?`,
                    [hashed, fullName, userId]
                );
                updated.push(`${username} (${team.dept})`);
            } else {
                const r = await db.execute(
                    `INSERT INTO users (username, email, password, full_name, role, must_change_password)
                     VALUES (?, ?, ?, ?, 'user', 0)`,
                    [username, email, hashed, fullName]
                );
                userId = r.lastInsertId;
                created.push(`${username} (${team.dept})`);
            }

            // Asignar al depto si no está ya
            const onConflict = db.driver === 'sqlite'
                ? 'INSERT OR IGNORE INTO user_departments (user_id, department_id, is_head, granted_by) VALUES (?, ?, 0, ?)'
                : 'INSERT INTO user_departments (user_id, department_id, is_head, granted_by) VALUES (?, ?, 0, ?) ON CONFLICT (user_id, department_id) DO NOTHING';
            await db.execute(onConflict, [userId, dept.id, adminId]);

            // Asignar rol 'empleado' si no lo tiene
            const empRole = await db.queryOne('SELECT id FROM roles WHERE code = ?', ['empleado']);
            if (empRole) {
                const onConflictRole = db.driver === 'sqlite'
                    ? 'INSERT OR IGNORE INTO user_roles (user_id, role_id, granted_by) VALUES (?, ?, ?)'
                    : 'INSERT INTO user_roles (user_id, role_id, granted_by) VALUES (?, ?, ?) ON CONFLICT (user_id, role_id) DO NOTHING';
                await db.execute(onConflictRole, [userId, empRole.id, adminId]);
            }
        }
    }

    console.log(`\n✅ Sembrado completo`);
    console.log(`   Creados nuevos: ${created.length}`);
    if (created.length > 0) created.forEach(u => console.log('     +', u));
    console.log(`   Actualizados existentes: ${updated.length}`);
    if (updated.length > 0) updated.forEach(u => console.log('     ✎', u));

    await db.close();
})().catch(err => { console.error('seed crash:', err); process.exit(1); });
