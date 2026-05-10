/**
 * PR-3d: Memos / comunicados a empleados (historial inmutable).
 *
 * Reglas de negocio:
 *   - Append-only: NUNCA se edita ni borra un memo emitido. Si se necesita
 *     corregir, se emite un memo nuevo y opcionalmente se setea
 *     superseded_by sobre el original (que sigue visible para auditoría).
 *   - content_hash es SHA-256(subject + '\n' + content) calculado al INSERT.
 *     Si alguien tocara content directo en la DB, la verificación al leer
 *     detecta el tamper y marca content_integrity=false en la respuesta.
 *
 * Visibilidad de la inbox del user:
 *   - target_type='all'                                  → siempre visible
 *   - target_type='department' AND target_id ∈ deptos del user → visible
 *   - target_type='employee' AND target_id = mi hr_employee.id → visible
 *
 * Quien emitió un memo (issued_by) lo ve siempre vía /sent.
 *
 * Acuse de lectura: POST /api/hr/memos/:id/ack registra fila en
 * hr_memo_acknowledgments (timestamp + ip). El issuer ve quién acusó
 * vía GET /api/hr/memos/:id (con detalle).
 */
const crypto = require('crypto');
const db = require('../config/db');
const { getUserContext } = require('./rbac.controller');

function computeHash(subject, content) {
    return crypto
        .createHash('sha256')
        .update(String(subject) + '\n' + String(content), 'utf8')
        .digest('hex');
}

function verifyHash(memo) {
    const expected = computeHash(memo.subject, memo.content);
    return expected === memo.content_hash;
}

// Devuelve la lista de hr_employees.id del user, los department.id donde está,
// y si tiene permiso para ver memos personales/área.
async function getInboxTargets(userId) {
    const ctx = await getUserContext(userId);
    const me = await db.queryOne('SELECT id FROM hr_employees WHERE user_id = ?', [userId]);
    return {
        ctx,
        myEmployeeId: me ? me.id : null,
        myDepartmentIds: ctx.departments.map(d => d.id),
        canSeeAll: ctx.isAdmin || ctx.permissions.has('hr.read.all')
    };
}

class HrMemosController {
    // INBOX del user logueado: memos dirigidos a él, su depto, o "all".
    static async listMyInbox(req, res) {
        try {
            const { myEmployeeId, myDepartmentIds, canSeeAll } = await getInboxTargets(req.user.id);

            const conditions = [];
            const params = [];

            if (canSeeAll) {
                // RRHH/admin: ven TODOS los memos.
            } else {
                const ors = [`m.target_type = 'all'`];
                if (myEmployeeId) {
                    ors.push(`(m.target_type = 'employee' AND m.target_id = ?)`);
                    params.push(myEmployeeId);
                }
                if (myDepartmentIds.length > 0) {
                    ors.push(`(m.target_type = 'department' AND m.target_id IN (${myDepartmentIds.map(() => '?').join(',')}))`);
                    params.push(...myDepartmentIds);
                }
                // Issuer ve los suyos también desde la inbox (no hace falta /sent).
                ors.push(`m.issued_by = ?`);
                params.push(req.user.id);
                conditions.push('(' + ors.join(' OR ') + ')');
            }

            const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
            const rows = await db.query(`
                SELECT m.id, m.subject, m.severity, m.target_type, m.target_id,
                       m.issued_by, m.issued_at, m.superseded_by,
                       u.username AS issued_by_username,
                       u.full_name AS issued_by_full_name,
                       (SELECT 1 FROM hr_memo_acknowledgments a
                        WHERE a.memo_id = m.id AND a.user_id = ?) AS acknowledged
                FROM hr_memos m
                LEFT JOIN users u ON u.id = m.issued_by
                ${where}
                ORDER BY m.issued_at DESC
            `, [req.user.id, ...params]);

            res.json({ success: true, data: { memos: rows, total: rows.length } });
        } catch (err) {
            console.error('listMyInbox:', err);
            res.status(500).json({ success: false, message: 'Error al listar memos' });
        }
    }

    // Detalle. Resuelve target_name (employee.full_name / department.name).
    // Verifica integridad del hash y avisa si está roto.
    static async getMemo(req, res) {
        try {
            const { id } = req.params;
            const { myEmployeeId, myDepartmentIds, canSeeAll } = await getInboxTargets(req.user.id);

            const memo = await db.queryOne(`
                SELECT m.*, u.username AS issued_by_username, u.full_name AS issued_by_full_name
                FROM hr_memos m
                LEFT JOIN users u ON u.id = m.issued_by
                WHERE m.id = ?
            `, [id]);
            if (!memo) {
                return res.status(404).json({ success: false, message: 'Memo no encontrado' });
            }

            const isIssuer = memo.issued_by === req.user.id;
            let visible = canSeeAll || isIssuer || memo.target_type === 'all';
            if (!visible && memo.target_type === 'employee' && memo.target_id === myEmployeeId) visible = true;
            if (!visible && memo.target_type === 'department' && myDepartmentIds.includes(memo.target_id)) visible = true;
            if (!visible) {
                return res.status(404).json({ success: false, message: 'Memo no encontrado o sin permisos' });
            }

            // Resolver nombre del target.
            let targetName = null;
            if (memo.target_type === 'employee' && memo.target_id) {
                const e = await db.queryOne('SELECT full_name FROM hr_employees WHERE id = ?', [memo.target_id]);
                targetName = e ? e.full_name : null;
            } else if (memo.target_type === 'department' && memo.target_id) {
                const d = await db.queryOne('SELECT name FROM departments WHERE id = ?', [memo.target_id]);
                targetName = d ? d.name : null;
            } else if (memo.target_type === 'all') {
                targetName = 'Toda la empresa';
            }

            const integrity = verifyHash(memo);

            // Si el caller es el issuer o RRHH, también devolvemos la lista de acks.
            let acknowledgments = null;
            if (isIssuer || canSeeAll) {
                acknowledgments = await db.query(`
                    SELECT a.user_id, a.acknowledged_at, a.ip_address,
                           u.username, u.full_name
                    FROM hr_memo_acknowledgments a
                    JOIN users u ON u.id = a.user_id
                    WHERE a.memo_id = ?
                    ORDER BY a.acknowledged_at
                `, [id]);
            }

            const myAck = await db.queryOne(
                'SELECT acknowledged_at FROM hr_memo_acknowledgments WHERE memo_id = ? AND user_id = ?',
                [id, req.user.id]
            );

            res.json({
                success: true,
                data: {
                    memo: { ...memo, target_name: targetName },
                    content_integrity: integrity,
                    my_ack: myAck ? myAck.acknowledged_at : null,
                    acknowledgments
                }
            });
        } catch (err) {
            console.error('getMemo:', err);
            res.status(500).json({ success: false, message: 'Error al obtener memo' });
        }
    }

    // Crear memo. Valida target, calcula hash. NO permite editar después.
    // Body: { subject, content, target_type, target_id?, severity?, supersedes? }
    static async createMemo(req, res) {
        try {
            const { subject, content, target_type, target_id, severity, supersedes } = req.body;
            if (!subject || !content || !target_type) {
                return res.status(400).json({
                    success: false,
                    message: 'subject, content y target_type son requeridos'
                });
            }
            if (!['employee','department','all'].includes(target_type)) {
                return res.status(400).json({ success: false, message: 'target_type inválido' });
            }
            const sev = severity || 'info';
            if (!['info','warning','sanction'].includes(sev)) {
                return res.status(400).json({ success: false, message: 'severity inválida' });
            }

            // Validar target.
            if (target_type === 'employee') {
                if (!target_id) {
                    return res.status(400).json({ success: false, message: 'target_id requerido para target_type=employee' });
                }
                const e = await db.queryOne('SELECT id FROM hr_employees WHERE id = ?', [target_id]);
                if (!e) return res.status(400).json({ success: false, message: 'Empleado destinatario no existe' });
            } else if (target_type === 'department') {
                if (!target_id) {
                    return res.status(400).json({ success: false, message: 'target_id requerido para target_type=department' });
                }
                const d = await db.queryOne('SELECT id FROM departments WHERE id = ?', [target_id]);
                if (!d) return res.status(400).json({ success: false, message: 'Departamento destinatario no existe' });
            }

            // Validar supersedes (si lo mandan).
            let supersededId = null;
            if (supersedes) {
                const old = await db.queryOne('SELECT id, issued_by FROM hr_memos WHERE id = ?', [supersedes]);
                if (!old) return res.status(400).json({ success: false, message: 'El memo a reemplazar no existe' });
                supersededId = old.id;
            }

            const hash = computeHash(subject, content);

            const r = await db.execute(
                `INSERT INTO hr_memos
                 (subject, content, content_hash, target_type, target_id, severity, issued_by, superseded_by)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [subject, content, hash, target_type, target_id || null, sev, req.user.id, supersededId]
            );

            // Si supersedes está seteado, marcamos al viejo con superseded_by
            // apuntando al NUEVO (semántica: "este memo viejo fue reemplazado por X").
            if (supersededId) {
                await db.execute(
                    'UPDATE hr_memos SET superseded_by = ? WHERE id = ?',
                    [r.lastInsertId, supersededId]
                );
            }

            res.status(201).json({
                success: true,
                data: { id: r.lastInsertId, content_hash: hash }
            });
        } catch (err) {
            console.error('createMemo:', err);
            res.status(500).json({ success: false, message: 'Error al crear memo' });
        }
    }

    // Acuse de recibo del user logueado. Idempotente: si ya acusó, devuelve OK.
    static async acknowledgeMemo(req, res) {
        try {
            const { id } = req.params;
            const memo = await db.queryOne('SELECT id, target_type, target_id FROM hr_memos WHERE id = ?', [id]);
            if (!memo) return res.status(404).json({ success: false, message: 'Memo no encontrado' });

            // Verificar visibilidad antes de aceptar el ack.
            const { myEmployeeId, myDepartmentIds, canSeeAll } = await getInboxTargets(req.user.id);
            const isIssuer = await db.queryOne('SELECT 1 FROM hr_memos WHERE id = ? AND issued_by = ?', [id, req.user.id]);
            let visible = canSeeAll || !!isIssuer || memo.target_type === 'all';
            if (!visible && memo.target_type === 'employee' && memo.target_id === myEmployeeId) visible = true;
            if (!visible && memo.target_type === 'department' && myDepartmentIds.includes(memo.target_id)) visible = true;
            if (!visible) {
                return res.status(404).json({ success: false, message: 'Memo no encontrado o sin permisos' });
            }

            const onConflict = db.driver === 'sqlite'
                ? 'INSERT OR IGNORE INTO hr_memo_acknowledgments (memo_id, user_id, ip_address) VALUES (?, ?, ?)'
                : 'INSERT INTO hr_memo_acknowledgments (memo_id, user_id, ip_address) VALUES (?, ?, ?) ON CONFLICT (memo_id, user_id) DO NOTHING';
            await db.execute(onConflict, [id, req.user.id, req.ip || 'unknown']);

            res.json({ success: true, message: 'Acuse registrado' });
        } catch (err) {
            console.error('acknowledgeMemo:', err);
            res.status(500).json({ success: false, message: 'Error al registrar acuse' });
        }
    }

    // /sent: memos emitidos por el caller (lo que él escribió y para quién).
    static async listMySent(req, res) {
        try {
            const rows = await db.query(`
                SELECT m.id, m.subject, m.severity, m.target_type, m.target_id,
                       m.issued_at, m.superseded_by,
                       (SELECT COUNT(*) FROM hr_memo_acknowledgments a WHERE a.memo_id = m.id) AS ack_count
                FROM hr_memos m
                WHERE m.issued_by = ?
                ORDER BY m.issued_at DESC
            `, [req.user.id]);
            res.json({ success: true, data: { memos: rows, total: rows.length } });
        } catch (err) {
            console.error('listMySent:', err);
            res.status(500).json({ success: false, message: 'Error al listar memos enviados' });
        }
    }
}

module.exports = HrMemosController;
