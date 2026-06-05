/**
 * HR Controller (PR-3a, foundation backend)
 *
 * Tres recursos:
 *   - hr_positions: perfiles de cargo (catálogo)
 *   - hr_employees: empleados (1-to-1 opcional con users)
 *   - hr_documents: docs del empleado (gestionados en otra PR)
 *
 * Visibilidad de empleados (en orden):
 *   1. Permiso 'hr.read.all' o admin → ve todos.
 *   2. Permiso 'hr.read.team' → ve a los empleados de los departamentos
 *      donde el user es jefe (user_departments.is_head=1) + a los que
 *      tienen al user como manager directo (manager_id = mi employee.id).
 *   3. Permiso 'hr.read.own' → solo ve su propio empleado (user_id = me).
 *   4. Sin ninguno de los anteriores → 403 / vacío.
 *
 * Escritura: requiere 'hr.write' (vía requirePermission en las routes).
 *
 * Defensa anti-PII básica: no se devuelve doc_id ni email_personal en
 * el listado masivo; solo en getEmployeeById si el caller tiene
 * 'hr.read.all' o es el propio user.
 */
const crypto = require('crypto');
const db = require('../config/db');
const storage = require('../config/storage');
const { getUserContext } = require('./rbac.controller');

// ============================================================
// F1: constantes y helpers compartidos (firma + workflow + adjuntos)
// ============================================================

// entity_type de hr_signatures para una solicitud de tiempo libre. Genérico a
// propósito: M2/Nómina (payroll_receipt) y M5/Memos (memo) reusarán la tabla.
const SIGNATURE_ENTITY_TYPE = 'time_off_request';

// Tipos de solicitud que descuentan vacaciones/días-ley → admiten el override
// "justificado sin descuento" (waive). 'feriado_compensado' NO está: su saldo es
// el banco de días compensados, que no tiene semántica de waive (discount=false
// sobre ese tipo se rechaza con 400).
const WAIVABLE_TYPES = ['vacaciones', 'permiso_personal', 'enfermedad', 'otro'];

// Tipos cuyo justificativo es obligatorio (por ley); mientras falte, la
// solicitud queda "para descuento" por defecto (discount_decision='pending').
const ATTACHMENT_REQUIRED_TYPES = ['permiso_personal', 'enfermedad'];

// MIME types aceptados para adjuntos (PDF + imágenes).
const ALLOWED_ATTACHMENT_MIME = ['application/pdf', 'image/png', 'image/jpeg'];

// ---- Banco de días compensados: ÚNICA fuente de verdad ----
// Estados de una solicitud 'feriado_compensado' que OCUPAN saldo del banco:
// aprobadas + las "en vuelo" del workflow multinivel (tras F1 nace en
// 'pending_tthh'). Se centraliza acá para que el cálculo del saldo, el guard de
// creación y el guard de borrado de asistencia NUNCA se desincronicen: si se
// agrega un estado nuevo al workflow, se actualiza UN solo lugar y no reaparece
// el banco-negativo por update parcial.
const COMPENSATED_ACTIVE_STATES = ['approved', 'pending', 'pending_jefe', 'pending_tthh'];

// Saldo del banco compensado de un empleado: días acreditados por asistencia a
// feriados MENOS los días ocupados por solicitudes feriado_compensado activas.
// `conn` puede ser `db` o un `tx` de transacción (ambos exponen queryOne), así
// que sirve dentro y fuera de una transacción. Devuelve { accrued, used, balance }.
async function computeCompensatedBalance(conn, employeeId) {
    const placeholders = COMPENSATED_ACTIVE_STATES.map(() => '?').join(',');
    const creditRow = await conn.queryOne(
        'SELECT COALESCE(SUM(days_credit), 0) AS total FROM holiday_attendance WHERE employee_id = ?',
        [employeeId]
    );
    const usedRow = await conn.queryOne(
        `SELECT COALESCE(SUM(days_count), 0) AS total
         FROM time_off_requests
         WHERE employee_id = ?
           AND request_type = 'feriado_compensado'
           AND status IN (${placeholders})`,
        [employeeId, ...COMPENSATED_ACTIVE_STATES]
    );
    const accrued = Number(creditRow.total || 0);
    const used = Number(usedRow.total || 0);
    return { accrued, used, balance: accrued - used };
}

// Calcula el content_hash de la firma sobre la cadena canónica EXACTA del
// hash_input de la spec. ATA el payload SUSTANTIVO de la solicitud (tipo,
// fechas, días, motivo) ADEMÁS de la identidad del firmante. Orden y separador
// fijos (separador = '|', sin espacios). Recomputar sobre los valores ACTUALES
// en DB detecta cualquier tamper de fechas/días/motivo (signature_integrity).
//
//   entity_type|entity_id|request_type|date_from|date_to|days_count|reason|signer_user_id|signer_name|signer_doc_id|signed_at
//
// Normaliza signed_at a una cadena ISO-8601 UTC canónica. CRÍTICO para el
// dual-driver: SQLite devuelve el signed_at como el MISMO string que insertamos,
// pero el driver de Postgres lo devuelve como objeto Date. Si el hash usara el
// valor crudo, recomputar en Postgres daría una cadena distinta y
// signature_integrity sería SIEMPRE false. Pasar ambos (string y Date) por
// `new Date(x).toISOString()` los colapsa al mismo instante absoluto en ms
// (por eso la columna signed_at de hr_signatures es TIMESTAMPTZ en Postgres).
function canonicalSignedAt(value) {
    return new Date(value).toISOString();
}

// Normaliza una fecha (columna DATE) a 'YYYY-MM-DD'. Otro punto dual-driver:
// SQLite devuelve DATE como string 'YYYY-MM-DD' (igual que lo insertamos), pero
// Postgres lo devuelve como objeto Date a medianoche local. Si es string,
// tomamos los primeros 10 chars; si es Date, usamos sus componentes LOCALES
// (que reflejan la fecha de calendario que Postgres devolvió), evitando el
// corrimiento de día que daría toISOString() en zonas con offset negativo.
function canonicalDate(value) {
    if (value instanceof Date) {
        const y = value.getFullYear();
        const m = String(value.getMonth() + 1).padStart(2, '0');
        const d = String(value.getDate()).padStart(2, '0');
        return `${y}-${m}-${d}`;
    }
    return String(value).slice(0, 10);
}

// Notas de canonicalización (para que la verificación recompute idéntico):
//   - days_count se serializa con String(Number(...)) → punto decimal, sin ceros sobrantes.
//   - reason null/undefined → cadena vacía.
//   - signed_at se normaliza a ISO-8601 UTC (ver canonicalSignedAt) en ambos lados.
function computeSignatureHash(parts) {
    const canonical = [
        SIGNATURE_ENTITY_TYPE,
        parts.entity_id,
        parts.request_type,
        canonicalDate(parts.date_from),
        canonicalDate(parts.date_to),
        String(Number(parts.days_count)),
        parts.reason == null ? '' : String(parts.reason),
        parts.signer_user_id,
        parts.signer_name,
        parts.signer_doc_id,
        canonicalSignedAt(parts.signed_at)
    ].join('|');
    return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}

// Devuelve los IDs de empleados visibles para el user.
// Si el user puede ver TODO, devuelve null (caller debe ignorar el filtro).
async function getVisibleEmployeeIds(userId) {
    const ctx = await getUserContext(userId);
    if (ctx.isAdmin || ctx.permissions.has('hr.read.all')) return null;

    const ids = new Set();

    // hr.read.own: su propio empleado
    if (ctx.permissions.has('hr.read.own')) {
        const own = await db.queryOne(
            'SELECT id FROM hr_employees WHERE user_id = ?',
            [userId]
        );
        if (own) ids.add(own.id);
    }

    // hr.read.team: empleados de deptos donde es jefe + reportes directos
    if (ctx.permissions.has('hr.read.team')) {
        const headDeptIds = ctx.departments
            .filter(d => d.is_head)
            .map(d => d.id);
        if (headDeptIds.length > 0) {
            const placeholders = headDeptIds.map(() => '?').join(',');
            const team = await db.query(
                `SELECT id FROM hr_employees
                 WHERE department_id IN (${placeholders})`,
                headDeptIds
            );
            team.forEach(e => ids.add(e.id));
        }

        // Reportes directos: mis empleados subordinados (donde manager_id
        // es mi propio hr_employees.id si tengo uno).
        const myEmp = await db.queryOne(
            'SELECT id FROM hr_employees WHERE user_id = ?',
            [userId]
        );
        if (myEmp) {
            const reports = await db.query(
                'SELECT id FROM hr_employees WHERE manager_id = ?',
                [myEmp.id]
            );
            reports.forEach(e => ids.add(e.id));
        }
    }

    return Array.from(ids);
}

class HrController {
    // -------- Perfiles de cargo --------
    static async listPositions(req, res) {
        try {
            const positions = await db.query(`
                SELECT id, code, title, description, department_code, level,
                       profile_pdf_path, is_active, created_at
                FROM hr_positions
                WHERE is_active = 1
                ORDER BY level DESC, title
            `);
            res.json({ success: true, data: { positions } });
        } catch (err) {
            console.error('listPositions:', err);
            res.status(500).json({ success: false, message: 'Error al listar perfiles' });
        }
    }

    static async createPosition(req, res) {
        try {
            const { code, title, description, department_code, level } = req.body;
            if (!code || !title) {
                return res.status(400).json({ success: false, message: 'code y title son requeridos' });
            }
            if (!/^[a-z][a-z0-9_]{1,31}$/.test(code)) {
                return res.status(400).json({
                    success: false,
                    message: 'code debe ser snake_case (a-z, 0-9, _)'
                });
            }
            const exists = await db.queryOne(
                'SELECT id FROM hr_positions WHERE code = ?', [code]
            );
            if (exists) {
                return res.status(409).json({ success: false, message: 'Ya existe ese code' });
            }
            const r = await db.execute(
                'INSERT INTO hr_positions (code, title, description, department_code, level) VALUES (?, ?, ?, ?, ?)',
                [code, title, description || null, department_code || null, level || null]
            );
            res.status(201).json({ success: true, data: { id: r.lastInsertId, code } });
        } catch (err) {
            console.error('createPosition:', err);
            res.status(500).json({ success: false, message: 'Error al crear perfil' });
        }
    }

    // -------- Empleados --------
    static async listEmployees(req, res) {
        try {
            const visibleIds = await getVisibleEmployeeIds(req.user.id);
            const ctx = await getUserContext(req.user.id, req);

            let where = 'WHERE 1=1';
            const params = [];
            if (visibleIds !== null) {
                if (visibleIds.length === 0) {
                    return res.json({ success: true, data: { employees: [], total: 0 } });
                }
                where += ` AND e.id IN (${visibleIds.map(() => '?').join(',')})`;
                params.push(...visibleIds);
            }
            // Filtro opcional por departamento.
            if (req.query.department_id) {
                where += ' AND e.department_id = ?';
                params.push(req.query.department_id);
            }

            const employees = await db.query(`
                SELECT e.id, e.user_id, e.full_name, e.doc_id, e.position_id, e.department_id,
                       e.manager_id, e.hire_date, e.status, e.created_at,
                       p.title AS position_title,
                       d.name AS department_name,
                       u.username AS user_username
                FROM hr_employees e
                LEFT JOIN hr_positions p ON e.position_id = p.id
                LEFT JOIN departments d  ON e.department_id = d.id
                LEFT JOIN users u        ON e.user_id = u.id
                ${where}
                ORDER BY e.full_name
            `, params);

            res.json({ success: true, data: { employees, total: employees.length } });
        } catch (err) {
            console.error('listEmployees:', err);
            res.status(500).json({ success: false, message: 'Error al listar empleados' });
        }
    }

    static async getEmployeeById(req, res) {
        try {
            const { id } = req.params;
            const visibleIds = await getVisibleEmployeeIds(req.user.id);
            if (visibleIds !== null && !visibleIds.includes(Number(id))) {
                return res.status(404).json({ success: false, message: 'Empleado no encontrado o sin permisos' });
            }
            const employee = await db.queryOne(`
                SELECT e.*, p.title AS position_title, p.code AS position_code,
                       d.name AS department_name, d.code AS department_code,
                       u.username AS user_username
                FROM hr_employees e
                LEFT JOIN hr_positions p ON e.position_id = p.id
                LEFT JOIN departments d  ON e.department_id = d.id
                LEFT JOIN users u        ON e.user_id = u.id
                WHERE e.id = ?
            `, [id]);
            if (!employee) {
                return res.status(404).json({ success: false, message: 'Empleado no encontrado' });
            }
            // Defensa PII: ocultar datos sensibles si el caller NO es el
            // propio empleado y NO tiene hr.read.all
            const ctx = await getUserContext(req.user.id, req);
            const isSelf = employee.user_id === req.user.id;
            if (!isSelf && !ctx.isAdmin && !ctx.permissions.has('hr.read.all')) {
                delete employee.doc_id;
                delete employee.email_personal;
                delete employee.address;
                delete employee.base_salary;
            } else if (!ctx.isAdmin && !ctx.permissions.has('hr.read.all') && isSelf) {
                // Self ve sus datos pero no su salario hasta que la nómina se habilite.
                delete employee.base_salary;
            }
            res.json({ success: true, data: { employee } });
        } catch (err) {
            console.error('getEmployeeById:', err);
            res.status(500).json({ success: false, message: 'Error al obtener empleado' });
        }
    }

    static async getDirectReports(req, res) {
        try {
            const managerId = Number(req.params.id);
            // Validación de entrada: el id debe ser un entero positivo.
            if (!Number.isInteger(managerId) || managerId <= 0) {
                return res.status(400).json({ success: false, message: 'ID de empleado inválido' });
            }
            // Autorización (cierra IDOR): este endpoint devolvía el equipo de
            // CUALQUIER jefe sin verificar permiso. Ahora reutilizamos la misma
            // visibilidad RRHH que el resto del módulo (getVisibleEmployeeIds):
            //   - devuelve null  → admin / hr.read.all → ve todo.
            //   - en otro caso, el id del jefe debe estar dentro de su scope visible
            //     (un jefe ve su propio equipo; un empleado sólo su propio id).
            // getVisibleEmployeeIds devuelve un Array (o null si ve todo); por eso
            // usamos .includes() — mismo patrón que getEmployeeById.
            const visibleIds = await getVisibleEmployeeIds(req.user.id);
            if (visibleIds !== null && !visibleIds.includes(managerId)) {
                return res.status(403).json({ success: false, message: 'No autorizado para ver el equipo de este empleado' });
            }
            const reports = await db.query(`
                SELECT e.id, e.full_name, p.title AS position_title, e.status
                FROM hr_employees e
                LEFT JOIN hr_positions p ON e.position_id = p.id
                WHERE e.manager_id = ?
                ORDER BY e.full_name
            `, [managerId]);
            res.json({ success: true, data: { reports } });
        } catch (err) {
            console.error('getDirectReports:', err);
            res.status(500).json({ success: false, message: 'Error al obtener equipo' });
        }
    }

    static async getMyEmployee(req, res) {
        try {
            const employee = await db.queryOne(`
                SELECT e.*, p.title AS position_title, p.code AS position_code,
                       d.name AS department_name, d.code AS department_code
                FROM hr_employees e
                LEFT JOIN hr_positions p ON e.position_id = p.id
                LEFT JOIN departments d  ON e.department_id = d.id
                WHERE e.user_id = ?
            `, [req.user.id]);
            if (!employee) {
                return res.json({ success: true, data: { employee: null } });
            }
            // Self: ocultar base_salary hasta Fase 6.
            delete employee.base_salary;
            res.json({ success: true, data: { employee } });
        } catch (err) {
            console.error('getMyEmployee:', err);
            res.status(500).json({ success: false, message: 'Error al obtener mi perfil' });
        }
    }

    // PR-3a: backfill de hr_employees a partir de users existentes.
    // Recorre todos los users que NO tienen un registro en hr_employees y
    // crea uno mínimo (full_name, user_id, status='active'). Idempotente:
    // si todos los users ya tienen empleado, devuelve { created: 0 }.
    // El primer departamento del user (via user_departments) se asocia
    // como department_id del empleado para que la lista por depto funcione.
    static async syncEmployeesFromUsers(req, res) {
        try {
            // user_departments tiene PK compuesta (user_id, dept_id) — sin
            // columna `id` autoincrement. Ordenamos por granted_at que sí existe.
            const users = await db.query(`
                SELECT u.id, u.full_name,
                       (SELECT department_id FROM user_departments
                        WHERE user_id = u.id
                        ORDER BY granted_at ASC LIMIT 1) AS first_dept
                FROM users u
                LEFT JOIN hr_employees e ON e.user_id = u.id
                WHERE e.id IS NULL AND u.is_active = 1
            `);
            let created = 0;
            const errors = [];
            for (const u of users) {
                try {
                    await db.execute(
                        `INSERT INTO hr_employees (user_id, full_name, department_id, status)
                         VALUES (?, ?, ?, 'active')`,
                        [u.id, u.full_name, u.first_dept || null]
                    );
                    created++;
                } catch (e) {
                    console.warn(`sync skip user ${u.id} (${u.full_name}):`, e.message);
                    errors.push({ user_id: u.id, name: u.full_name, error: e.message });
                }
            }
            res.json({
                success: true,
                data: {
                    created,
                    total_scanned: users.length,
                    errors: errors.length > 0 ? errors : undefined
                }
            });
        } catch (err) {
            console.error('syncEmployeesFromUsers FATAL:', err);
            res.status(500).json({
                success: false,
                message: 'Error en backfill de empleados: ' + (err.message || 'desconocido')
            });
        }
    }

    static async createEmployee(req, res) {
        try {
            const { user_id, full_name, doc_id, email_personal, phone,
                    position_id, department_id, manager_id, hire_date, address, notes } = req.body;
            if (!full_name) {
                return res.status(400).json({ success: false, message: 'full_name es requerido' });
            }
            if (user_id) {
                const u = await db.queryOne('SELECT id FROM users WHERE id = ?', [user_id]);
                if (!u) {
                    return res.status(400).json({ success: false, message: 'user_id inexistente' });
                }
                const dup = await db.queryOne('SELECT id FROM hr_employees WHERE user_id = ?', [user_id]);
                if (dup) {
                    return res.status(409).json({ success: false, message: 'Ese user ya tiene perfil de empleado' });
                }
            }
            const r = await db.execute(
                `INSERT INTO hr_employees
                 (user_id, full_name, doc_id, email_personal, phone,
                  position_id, department_id, manager_id, hire_date, address, notes)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [user_id || null, full_name, doc_id || null, email_personal || null,
                 phone || null, position_id || null, department_id || null,
                 manager_id || null, hire_date || null, address || null, notes || null]
            );
            res.status(201).json({ success: true, data: { id: r.lastInsertId } });
        } catch (err) {
            console.error('createEmployee:', err);
            res.status(500).json({ success: false, message: 'Error al crear empleado' });
        }
    }

    // ============================================================
    // PR-3b: Feriados y banco de días compensados
    // ============================================================
    // Reemplaza el FERIADOS.xlsx del usuario. Cada attendance suma 1 día
    // al banco del empleado; al pedir un día libre tipo 'feriado_compensado'
    // (PR-3c) se descuenta de ese banco.

    // Listar feriados (cualquier user logueado puede consultar el calendario).
    // Filtros: ?year=2026, ?from=2026-01-01, ?to=2026-12-31.
    static async listHolidays(req, res) {
        try {
            const { year, from, to } = req.query;
            const conditions = ['is_active = 1'];
            const params = [];
            if (year) {
                conditions.push("strftime('%Y', holiday_date) = ?");
                params.push(String(year));
            }
            if (from) { conditions.push('holiday_date >= ?'); params.push(from); }
            if (to)   { conditions.push('holiday_date <= ?'); params.push(to); }

            // PG no tiene strftime — usamos extract.
            let sql;
            if (db.driver === 'postgres') {
                const pgConditions = conditions.map(c =>
                    c.replace("strftime('%Y', holiday_date) = ?", "EXTRACT(YEAR FROM holiday_date)::text = ?")
                );
                sql = `SELECT id, holiday_date, name, description, is_national, is_active, created_at
                       FROM holidays
                       WHERE ${pgConditions.join(' AND ')}
                       ORDER BY holiday_date`;
            } else {
                sql = `SELECT id, holiday_date, name, description, is_national, is_active, created_at
                       FROM holidays
                       WHERE ${conditions.join(' AND ')}
                       ORDER BY holiday_date`;
            }
            const holidays = await db.query(sql, params);
            res.json({ success: true, data: { holidays } });
        } catch (err) {
            console.error('listHolidays:', err);
            res.status(500).json({ success: false, message: 'Error al listar feriados' });
        }
    }

    // Crear feriado (custom decretado o nacional faltante).
    // Body: { holiday_date, name, description?, is_national? }
    static async createHoliday(req, res) {
        try {
            const { holiday_date, name, description, is_national } = req.body;
            if (!holiday_date || !name) {
                return res.status(400).json({ success: false, message: 'holiday_date y name son requeridos' });
            }
            if (!/^\d{4}-\d{2}-\d{2}$/.test(holiday_date)) {
                return res.status(400).json({ success: false, message: 'holiday_date debe ser YYYY-MM-DD' });
            }
            const r = await db.execute(
                `INSERT INTO holidays (holiday_date, name, description, is_national, created_by)
                 VALUES (?, ?, ?, ?, ?)`,
                [holiday_date, name, description || null,
                 is_national === false || is_national === 0 ? 0 : 1, req.user.id]
            );
            res.status(201).json({ success: true, data: { id: r.lastInsertId } });
        } catch (err) {
            console.error('createHoliday:', err);
            const msg = err && err.message && err.message.includes('UNIQUE')
                ? 'Ya existe un feriado con esa fecha y nombre'
                : 'Error al crear feriado';
            res.status(500).json({ success: false, message: msg });
        }
    }

    static async deleteHoliday(req, res) {
        try {
            const { id } = req.params;
            const h = await db.queryOne('SELECT id FROM holidays WHERE id = ?', [id]);
            if (!h) return res.status(404).json({ success: false, message: 'Feriado no encontrado' });
            // Soft-delete preservando histórico (holiday_attendance no se borra).
            await db.execute('UPDATE holidays SET is_active = 0 WHERE id = ?', [id]);
            res.json({ success: true, message: 'Feriado archivado' });
        } catch (err) {
            console.error('deleteHoliday:', err);
            res.status(500).json({ success: false, message: 'Error al archivar' });
        }
    }

    // Listar quién trabajó en un feriado dado.
    // Permite a RRHH/Gerencia ver cualquier holiday; a empleados solo si
    // su attendance está dentro (hr.read.own).
    static async listAttendance(req, res) {
        try {
            const { id } = req.params;  // holiday_id
            const ctx = await getUserContext(req.user.id, req);
            const canSeeAll = ctx.isAdmin
                || ctx.permissions.has('hr.read.all')
                || ctx.permissions.has('hr.attendance.manage');

            let where = 'a.holiday_id = ?';
            const params = [id];
            if (!canSeeAll) {
                // Solo su propia attendance.
                const me = await db.queryOne('SELECT id FROM hr_employees WHERE user_id = ?', [req.user.id]);
                if (!me) return res.json({ success: true, data: { attendance: [] } });
                where += ' AND a.employee_id = ?';
                params.push(me.id);
            }

            const rows = await db.query(`
                SELECT a.id, a.holiday_id, a.employee_id, a.schedule_text,
                       a.hours_worked, a.days_credit, a.notes, a.created_at,
                       e.full_name AS employee_name,
                       d.name AS department_name
                FROM holiday_attendance a
                JOIN hr_employees e ON e.id = a.employee_id
                LEFT JOIN departments d ON d.id = e.department_id
                WHERE ${where}
                ORDER BY e.full_name
            `, params);

            res.json({ success: true, data: { attendance: rows } });
        } catch (err) {
            console.error('listAttendance:', err);
            res.status(500).json({ success: false, message: 'Error al listar asistencia' });
        }
    }

    // Registrar (o actualizar) que un empleado trabajó un feriado.
    // Suma 1 día (o days_credit personalizado) al banco compensado.
    static async upsertAttendance(req, res) {
        try {
            const { id } = req.params;  // holiday_id
            const { employee_id, schedule_text, hours_worked, days_credit, notes } = req.body;
            if (!employee_id) {
                return res.status(400).json({ success: false, message: 'employee_id es requerido' });
            }
            // El crédito alimenta el banco; la columna es NUMERIC(5,2) en Postgres
            // (tope 999.99, 2 decimales) y REAL en SQLite. Sin validar: un valor
            // enorme tira 500 SÓLO en Postgres (numeric field overflow) y uno
            // negativo/0 corrompe el banco. Acotamos a un rango sano y a 2 decimales.
            let credit = 1; // default: 1 día por feriado trabajado
            if (days_credit !== undefined && days_credit !== null && String(days_credit).trim() !== '') {
                const c = Number(days_credit);
                if (!Number.isFinite(c) || c <= 0 || c > 30) {
                    return res.status(400).json({ success: false, message: 'days_credit debe ser un número mayor a 0 y hasta 30' });
                }
                credit = Math.round(c * 100) / 100; // máx 2 decimales (igual que NUMERIC(5,2))
            }
            // hours_worked es opcional/informativo; si viene, lo acotamos a 0–24
            // para no romper la columna numérica en Postgres ni guardar absurdos.
            let hours = null;
            if (hours_worked !== undefined && hours_worked !== null && String(hours_worked).trim() !== '') {
                const h = Number(hours_worked);
                if (!Number.isFinite(h) || h < 0 || h > 24) {
                    return res.status(400).json({ success: false, message: 'hours_worked debe ser un número entre 0 y 24' });
                }
                hours = Math.round(h * 100) / 100;
            }

            const upsertSql = db.driver === 'sqlite'
                ? `INSERT INTO holiday_attendance
                   (holiday_id, employee_id, schedule_text, hours_worked, days_credit, notes, created_by)
                   VALUES (?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT(holiday_id, employee_id)
                   DO UPDATE SET schedule_text = excluded.schedule_text,
                                 hours_worked  = excluded.hours_worked,
                                 days_credit   = excluded.days_credit,
                                 notes         = excluded.notes`
                : `INSERT INTO holiday_attendance
                   (holiday_id, employee_id, schedule_text, hours_worked, days_credit, notes, created_by)
                   VALUES (?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT(holiday_id, employee_id)
                   DO UPDATE SET schedule_text = EXCLUDED.schedule_text,
                                 hours_worked  = EXCLUDED.hours_worked,
                                 days_credit   = EXCLUDED.days_credit,
                                 notes         = EXCLUDED.notes`;
            await db.execute(upsertSql, [
                id, employee_id, schedule_text || null,
                hours, credit, notes || null, req.user.id
            ]);
            res.status(201).json({ success: true, message: 'Asistencia registrada' });
        } catch (err) {
            console.error('upsertAttendance:', err);
            res.status(500).json({ success: false, message: 'Error al registrar asistencia' });
        }
    }

    static async deleteAttendance(req, res) {
        try {
            const { attendanceId } = req.params;
            const r = await db.queryOne('SELECT id, employee_id, days_credit FROM holiday_attendance WHERE id = ?', [attendanceId]);
            if (!r) return res.status(404).json({ success: false, message: 'Registro no encontrado' });

            // Integridad del banco: borrar este registro resta `days_credit` del
            // saldo. Si el disponible actual es MENOR a ese crédito, el banco quedaría
            // negativo (ya hay días consumidos por solicitudes feriado_compensado en
            // vuelo/aprobadas que dependen de él). Lo bloqueamos con 409; RRHH debe
            // cancelar primero esas solicitudes.
            const { balance } = await computeCompensatedBalance(db, r.employee_id);
            if (balance < Number(r.days_credit || 0)) {
                return res.status(409).json({
                    success: false,
                    message: 'No se puede borrar: el empleado ya usó días compensados que dependen de este crédito. Cancelá primero esas solicitudes de feriado compensado.'
                });
            }
            await db.execute('DELETE FROM holiday_attendance WHERE id = ?', [attendanceId]);
            res.json({ success: true, message: 'Asistencia eliminada' });
        } catch (err) {
            console.error('deleteAttendance:', err);
            res.status(500).json({ success: false, message: 'Error al eliminar' });
        }
    }

    // Banco de días compensados de un empleado.
    // Hoy: solo cuenta créditos (PR-3c sumará el debe de time_off_requests).
    static async getCompensatedBalance(req, res) {
        try {
            const { id } = req.params;  // employee_id
            const ctx = await getUserContext(req.user.id, req);
            // El propio empleado siempre puede ver su saldo; otros necesitan
            // hr.read.all o hr.read.team (si es de su equipo).
            const me = await db.queryOne('SELECT id FROM hr_employees WHERE user_id = ?', [req.user.id]);
            const isSelf = me && me.id === Number(id);
            const canSeeAll = ctx.isAdmin || ctx.permissions.has('hr.read.all');

            if (!isSelf && !canSeeAll) {
                // Para hr.read.team verificamos vía getVisibleEmployeeIds.
                const visible = await getVisibleEmployeeIds(req.user.id);
                if (visible !== null && !visible.includes(Number(id))) {
                    return res.status(403).json({ success: false, message: 'Sin permisos para este empleado' });
                }
            }

            // Saldo = créditos por asistencia − días ocupados por solicitudes
            // feriado_compensado activas (incluye las EN VUELO del workflow, que
            // nacen en 'pending_tthh': si no se contaran, el empleado gastaría dos
            // veces el mismo crédito). Cálculo centralizado en computeCompensatedBalance.
            const { accrued, used, balance } = await computeCompensatedBalance(db, id);
            res.json({
                success: true,
                data: {
                    employee_id: Number(id),
                    days_accrued: accrued,
                    days_used: used,
                    balance
                }
            });
        } catch (err) {
            console.error('getCompensatedBalance:', err);
            res.status(500).json({ success: false, message: 'Error al obtener saldo' });
        }
    }

    // ============================================================
    // PR-3c: Solicitudes de tiempo libre (vacaciones, permisos, etc.)
    // ============================================================
    // Workflow: pending → approved | rejected | cancelled.
    // Si tipo='feriado_compensado' y se aprueba, getCompensatedBalance lo
    // descuenta del banco automáticamente (no se modifica el banco como
    // tabla separada — se calcula on-the-fly).

    // Listar solicitudes. Visibilidad mismo modelo que listEmployees:
    //   - hr.read.all → todas
    //   - hr.read.team → de su equipo (jefe / depto donde es head)
    //   - hr.read.own → solo las propias
    static async listTimeOffRequests(req, res) {
        try {
            const visibleIds = await getVisibleEmployeeIds(req.user.id);

            const conditions = [];
            const params = [];

            if (visibleIds !== null) {
                if (visibleIds.length === 0) {
                    return res.json({ success: true, data: { requests: [], total: 0 } });
                }
                conditions.push(`r.employee_id IN (${visibleIds.map(() => '?').join(',')})`);
                params.push(...visibleIds);
            }
            if (req.query.status) {
                conditions.push('r.status = ?');
                params.push(req.query.status);
            }
            if (req.query.request_type) {
                conditions.push('r.request_type = ?');
                params.push(req.query.request_type);
            }
            const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

            const rows = await db.query(`
                SELECT r.id, r.employee_id, r.request_type, r.date_from, r.date_to,
                       r.days_count, r.reason, r.status,
                       r.requested_by, r.approved_by, r.approved_at,
                       r.rejection_reason, r.created_at,
                       e.full_name AS employee_name,
                       d.name AS department_name,
                       ub.username AS approved_by_username
                FROM time_off_requests r
                JOIN hr_employees e ON e.id = r.employee_id
                LEFT JOIN departments d ON d.id = e.department_id
                LEFT JOIN users ub ON ub.id = r.approved_by
                ${where}
                ORDER BY r.created_at DESC
            `, params);
            res.json({ success: true, data: { requests: rows, total: rows.length } });
        } catch (err) {
            console.error('listTimeOffRequests:', err);
            res.status(500).json({ success: false, message: 'Error al listar solicitudes' });
        }
    }

    // El dueño (o RRHH/admin) cancela su solicitud mientras siga PENDIENTE.
    // F1: el guard se amplió de `=== 'pending'` al conjunto pendiente del
    // workflow multinivel (una solicitud nueva nace en pending_jefe/pending_tthh
    // y jamás en 'pending'), y el código de error pasó de 400 a 409 (conflicto
    // de estado, coherente con el resto del workflow).
    static async cancelTimeOffRequest(req, res) {
        try {
            const { id } = req.params;
            const r = await db.queryOne(`
                SELECT r.id, r.status, e.user_id AS owner_user_id
                FROM time_off_requests r
                JOIN hr_employees e ON e.id = r.employee_id
                WHERE r.id = ?
            `, [id]);
            if (!r) return res.status(404).json({ success: false, message: 'Solicitud no encontrada' });

            // La regla de owner se evalúa ANTES del estado: quien no es dueño ni
            // RRHH/admin recibe 403 aunque la solicitud ya esté en estado terminal.
            const ctx = await getUserContext(req.user.id, req);
            const isOwner = r.owner_user_id === req.user.id;
            const canManage = ctx.isAdmin || ctx.permissions.has('hr.timeoff.approve');
            if (!isOwner && !canManage) {
                return res.status(403).json({ success: false, message: 'Sin permisos para cancelar esta solicitud' });
            }

            if (!HrController.PENDING_STATUSES.includes(r.status)) {
                return res.status(409).json({
                    success: false,
                    message: `La solicitud ya está en estado '${r.status}' y no puede cancelarse`
                });
            }
            await db.execute(
                `UPDATE time_off_requests
                 SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP
                 WHERE id = ?`,
                [id]
            );
            // DecisionResponse: en cancel se omiten step_level/action (no es un
            // paso de aprobador), sólo se devuelve el estado resultante.
            res.json({
                success: true,
                message: 'Solicitud cancelada',
                data: { id: Number(id), status: 'cancelled', action: 'cancel' }
            });
        } catch (err) {
            console.error('cancelTimeOffRequest:', err);
            res.status(500).json({ success: false, message: 'Error al cancelar' });
        }
    }

    // Hard-delete de un empleado. Cascadea (FK ON DELETE CASCADE):
    //   - hr_documents.employee_id
    //   - holiday_attendance.employee_id
    //   - time_off_requests.employee_id
    // Reportes directos quedan con manager_id=NULL (ON DELETE SET NULL).
    // Si el empleado tiene user vinculado, el user NO se borra: solo se
    // desvincula (hr_employees.user_id quedaba en SET NULL pero como
    // borramos el empleado, queda sin efecto). Usalo solo para datos
    // de prueba o errores de carga; para bajas reales preferí status='terminated'.
    static async deleteEmployee(req, res) {
        try {
            const { id } = req.params;
            const employee = await db.queryOne(
                'SELECT id, full_name FROM hr_employees WHERE id = ?', [id]
            );
            if (!employee) {
                return res.status(404).json({ success: false, message: 'Empleado no encontrado' });
            }
            await db.execute('DELETE FROM hr_employees WHERE id = ?', [id]);
            res.json({
                success: true,
                message: `Empleado "${employee.full_name}" eliminado (con sus asistencias y solicitudes)`
            });
        } catch (err) {
            console.error('deleteEmployee:', err);
            res.status(500).json({ success: false, message: 'Error al eliminar empleado' });
        }
    }

    static async updateEmployee(req, res) {
        try {
            const { id } = req.params;
            const employee = await db.queryOne('SELECT id FROM hr_employees WHERE id = ?', [id]);
            if (!employee) {
                return res.status(404).json({ success: false, message: 'Empleado no encontrado' });
            }
            // Separación de funciones: editar el SALARIO BASE exige un permiso
            // dedicado (hr.salary.write), además del hr.write que ya pide la ruta.
            // Motivo: cuando la nómina entre en operación, alguien con hr.write
            // podrá corregir datos del empleado (teléfono, dirección) SIN poder
            // tocar sueldos. El salario es PII crítica → principio de menor privilegio.
            const ctx = await getUserContext(req.user.id, req);
            const canEditSalary = ctx.isAdmin || ctx.permissions.has('hr.salary.write');
            if (req.body.base_salary !== undefined && !canEditSalary) {
                return res.status(403).json({ success: false, message: 'No autorizado para modificar el salario base' });
            }
            const allowed = ['full_name', 'doc_id', 'email_personal', 'phone',
                             'position_id', 'department_id', 'manager_id',
                             'hire_date', 'status', 'address', 'notes', 'user_id'];
            // base_salary sólo entra al allowlist si el caller tiene el permiso dedicado.
            if (canEditSalary) allowed.push('base_salary');
            const updates = [];
            const values = [];
            for (const k of allowed) {
                if (req.body[k] !== undefined) {
                    updates.push(`${k} = ?`);
                    values.push(req.body[k]);
                }
            }
            if (updates.length === 0) {
                return res.status(400).json({ success: false, message: 'No hay campos para actualizar' });
            }
            updates.push('updated_at = CURRENT_TIMESTAMP');
            values.push(id);
            await db.execute(
                `UPDATE hr_employees SET ${updates.join(', ')} WHERE id = ?`,
                values
            );
            res.json({ success: true, message: 'Empleado actualizado' });
        } catch (err) {
            console.error('updateEmployee:', err);
            res.status(500).json({ success: false, message: 'Error al actualizar empleado' });
        }
    }

    // ============================================================
    // F1: Firma electrónica + aprobación multinivel + adjuntos
    // ============================================================

    // Estados en los que una solicitud sigue "pendiente" (cancelable / accionable).
    // 'pending' sólo aparece en filas históricas (PR-3c); las nuevas nacen en
    // pending_jefe (vacaciones) o pending_tthh (resto).
    static get PENDING_STATUSES() {
        return ['pending', 'pending_jefe', 'pending_tthh'];
    }

    // Deriva el estado inicial server-side a partir del tipo (el cliente nunca
    // lo envía). SÓLO 'vacaciones' pasa por el jefe; el resto es RRHH-directo.
    static deriveInitialStatus(requestType) {
        return requestType === 'vacaciones' ? 'pending_jefe' : 'pending_tthh';
    }

    // Resuelve quiénes pueden aprobar el PASO JEFE (sólo vacaciones) de una
    // solicitud: el jefe inmediato (hr_employees.manager_id → su user_id) y,
    // como fallback, los jefes del departamento del solicitante
    // (user_departments.is_head=1). Cualquiera de varios heads sirve.
    // Devuelve un Set<user_id>. El solicitante se EXCLUYE para bloquear
    // auto-aprobación: un jefe que pide sus propias vacaciones y es su único
    // aprobador-jefe no debe poder aprobarse a sí mismo (su solicitud, además,
    // ya habrá nacido en pending_tthh — ver canRouteThroughJefe).
    static async resolveJefeApproverUserIds(employee) {
        const approverUserIds = new Set();

        // 1. Jefe inmediato directo (manager_id → user_id del manager).
        if (employee.manager_id) {
            const manager = await db.queryOne(
                'SELECT user_id FROM hr_employees WHERE id = ?',
                [employee.manager_id]
            );
            if (manager && manager.user_id) approverUserIds.add(manager.user_id);
        }

        // 2. Fallback: jefes (is_head) del departamento del solicitante.
        if (employee.department_id) {
            const heads = await db.query(
                'SELECT user_id FROM user_departments WHERE department_id = ? AND is_head = 1',
                [employee.department_id]
            );
            for (const h of heads) {
                if (h.user_id) approverUserIds.add(h.user_id);
            }
        }

        // Bloqueo de auto-aprobación: el solicitante nunca es su propio aprobador-jefe.
        if (employee.user_id) approverUserIds.delete(employee.user_id);

        return approverUserIds;
    }

    // Decide si una solicitud de vacaciones DEBE pasar por el jefe. Si no hay
    // ningún aprobador-jefe válido (sin manager y sin head distinto del propio
    // solicitante), el paso jefe se salta y la solicitud va directo a TTHH.
    static async canRouteThroughJefe(employee) {
        const approvers = await HrController.resolveJefeApproverUserIds(employee);
        return approvers.size > 0;
    }

    // POST /api/hr/time-off — crear y FIRMAR una solicitud en un solo paso.
    // La firma se valida server-side (nombre exacto en mayúsculas, cédula
    // numérica, checkbox true); si no valida → 422 y NO se crea nada (atómico).
    // El estado inicial se deriva del tipo. El content_hash ata el payload
    // sustantivo + identidad. Regla de autoría: un empleado sólo firma para
    // sí mismo; RRHH/admin pueden crear en nombre de otro.
    static async crearSolicitudFirmada(req, res) {
        try {
            const { employee_id, request_type, date_from, date_to, days_count, reason, signature } = req.body;

            // ---- Validación de los campos de la solicitud (tipos/rangos) ----
            const validTypes = ['vacaciones', 'feriado_compensado', 'permiso_personal', 'enfermedad', 'otro'];
            if (!validTypes.includes(request_type)) {
                return res.status(400).json({ success: false, message: `request_type inválido. Válidos: ${validTypes.join(', ')}` });
            }
            if (!/^\d{4}-\d{2}-\d{2}$/.test(date_from || '') || !/^\d{4}-\d{2}-\d{2}$/.test(date_to || '')) {
                return res.status(400).json({ success: false, message: 'date_from y date_to deben ser fechas YYYY-MM-DD' });
            }
            if (date_from > date_to) {
                return res.status(400).json({ success: false, message: 'date_from no puede ser posterior a date_to' });
            }
            const days = Number(days_count);
            if (!Number.isFinite(days) || days < 0.5 || days > 365) {
                return res.status(400).json({ success: false, message: 'days_count debe estar entre 0.5 y 365' });
            }
            if (reason !== undefined && (typeof reason !== 'string' || reason.length > 1000)) {
                return res.status(400).json({ success: false, message: 'reason debe ser texto de hasta 1000 caracteres' });
            }

            // ---- Validación estructural de la firma (forma) ----
            if (!signature || typeof signature !== 'object') {
                return res.status(400).json({ success: false, message: 'signature es obligatoria' });
            }
            const { accepted, signer_name, signer_doc_id } = signature;
            if (typeof signer_name !== 'string' || typeof signer_doc_id !== 'string') {
                return res.status(400).json({ success: false, message: 'signer_name y signer_doc_id son obligatorios' });
            }

            // ---- Resolver el empleado objetivo (empleado para sí mismo; RRHH/admin por otro) ----
            const ctx = await getUserContext(req.user.id, req);
            const canCreateForOthers = ctx.isAdmin || ctx.permissions.has('hr.read.all');
            let targetEmployee;
            if (!employee_id) {
                targetEmployee = await db.queryOne('SELECT * FROM hr_employees WHERE user_id = ?', [req.user.id]);
                if (!targetEmployee) {
                    return res.status(400).json({ success: false, message: 'No tienes perfil de empleado. Pedí a RRHH que te lo cree.' });
                }
            } else {
                targetEmployee = await db.queryOne('SELECT * FROM hr_employees WHERE id = ?', [employee_id]);
                if (!targetEmployee) {
                    return res.status(404).json({ success: false, message: 'Empleado no encontrado' });
                }
                const me = await db.queryOne('SELECT id FROM hr_employees WHERE user_id = ?', [req.user.id]);
                const isSelf = me && me.id === Number(employee_id);
                if (!isSelf && !canCreateForOthers) {
                    return res.status(403).json({ success: false, message: 'Solo podés solicitar días libres para vos mismo.' });
                }
            }

            // Defensa: firmar electrónicamente exige una identidad de login. Un
            // empleado sólo-ficha (sin user_id vinculado) no puede ser firmante →
            // 422 limpio en vez de un 500 por la FK NOT NULL de hr_signatures.signer_user_id.
            if (targetEmployee.user_id == null) {
                return res.status(422).json({ success: false, message: 'El empleado no tiene cuenta de usuario; no puede firmarse en su nombre' });
            }

            // ---- Validación SUSTANTIVA de la firma (semántica) → 422 si falla ----
            // accepted debe ser exactamente true; el nombre tecleado debe coincidir
            // con full_name del empleado tras normalizar a mayúsculas; la cédula
            // debe ser numérica (6-13 dígitos). Cualquier incumplimiento: 422 y la
            // entidad NO se crea.
            if (accepted !== true) {
                return res.status(422).json({ success: false, message: 'Debés aceptar los términos para firmar (checkbox)' });
            }
            if (!/^[0-9]{6,13}$/.test(signer_doc_id)) {
                return res.status(422).json({ success: false, message: 'La cédula de la firma debe ser numérica (6 a 13 dígitos)' });
            }
            const fullNameUpper = String(targetEmployee.full_name || '').trim().toUpperCase();
            if (signer_name.trim().toUpperCase() !== fullNameUpper) {
                return res.status(422).json({ success: false, message: 'El nombre firmado no coincide con el nombre del empleado' });
            }

            // ---- Saldo del banco (feriado_compensado no puede dejar el banco en negativo) ----
            if (request_type === 'feriado_compensado') {
                const { balance } = await computeCompensatedBalance(db, targetEmployee.id);
                if (days > balance) {
                    return res.status(400).json({ success: false, message: `Saldo insuficiente. Disponible: ${balance} día(s), pediste ${days}.` });
                }
            }

            // ---- Derivar estado inicial: vacaciones → jefe SÓLO si hay aprobador-jefe ----
            let initialStatus = HrController.deriveInitialStatus(request_type);
            if (initialStatus === 'pending_jefe') {
                const routesThroughJefe = await HrController.canRouteThroughJefe(targetEmployee);
                if (!routesThroughJefe) initialStatus = 'pending_tthh'; // sin jefe válido → RRHH cubre
            }

            const requiresAttachment = ATTACHMENT_REQUIRED_TYPES.includes(request_type);
            const normalizedName = signer_name.trim().toUpperCase();
            const reasonValue = (typeof reason === 'string' && reason.length > 0) ? reason : null;

            // ---- Persistir solicitud + firma ATÓMICAMENTE ----
            // La firma necesita el id de la solicitud para el hash (entity_id),
            // así que insertamos la solicitud, calculamos el hash y luego la firma
            // dentro de la misma transacción. Si algo falla, rollback total.
            const result = await db.transaction(async (tx) => {
                // TOCTOU-safe: el chequeo de saldo de arriba es PRE-transacción (UX
                // rápida y mensaje claro), pero dos solicitudes concurrentes del MISMO
                // empleado podrían pasarlo a la vez y gastar el crédito dos veces. Acá,
                // ya dentro de la tx, RE-validamos el saldo de forma autoritativa.
                if (request_type === 'feriado_compensado') {
                    // En Postgres (READ COMMITTED) tomamos un advisory lock por empleado
                    // para serializar estas creaciones; se libera solo al cerrar la tx.
                    // En SQLite no hace falta: better-sqlite3 es sync y de conexión única,
                    // así que la transacción ya serializa el proceso.
                    if (db.driver === 'postgres') {
                        await tx.query('SELECT pg_advisory_xact_lock(?::bigint)', [targetEmployee.id]);
                    }
                    // Re-lectura AUTORITATIVA del saldo dentro de la tx (misma fuente
                    // de verdad que el resto del banco), ya serializada por el lock.
                    const { balance: txBalance } = await computeCompensatedBalance(tx, targetEmployee.id);
                    if (days > txBalance) {
                        const e = new Error(`Saldo insuficiente. Disponible: ${txBalance} día(s), pediste ${days}.`);
                        e.statusCode = 400; // lo honra el catch → 400 limpio, no 500
                        throw e;
                    }
                }

                const reqInsert = await tx.execute(
                    `INSERT INTO time_off_requests
                     (employee_id, request_type, date_from, date_to, days_count, reason, status, discount_decision, requested_by)
                     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
                    [targetEmployee.id, request_type, date_from, date_to, days, reasonValue, initialStatus, req.user.id]
                );
                const requestId = reqInsert.lastInsertId;

                // signed_at lo fija la app (no CURRENT_TIMESTAMP) porque entra en
                // el hash y necesitamos el MISMO valor exacto al recomputar.
                const signedAt = new Date().toISOString();
                const contentHash = computeSignatureHash({
                    entity_id: requestId,
                    request_type,
                    date_from,
                    date_to,
                    days_count: days,
                    reason: reasonValue,
                    signer_user_id: targetEmployee.user_id,
                    signer_name: normalizedName,
                    signer_doc_id,
                    signed_at: signedAt
                });

                // accepted es BOOLEAN en Postgres e INTEGER 0/1 en SQLite:
                // valor driver-aware para no depender de coerciones implícitas.
                const acceptedValue = db.driver === 'postgres' ? true : 1;
                await tx.execute(
                    `INSERT INTO hr_signatures
                     (entity_type, entity_id, signer_user_id, signer_name, signer_doc_id, accepted, content_hash, signed_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                    [SIGNATURE_ENTITY_TYPE, requestId, targetEmployee.user_id, normalizedName, signer_doc_id, acceptedValue, contentHash, signedAt]
                );

                return { requestId, contentHash, signedAt };
            });

            return res.status(201).json({
                success: true,
                message: 'Solicitud creada y firmada',
                data: {
                    id: result.requestId,
                    status: initialStatus,
                    request_type,
                    requires_attachment: requiresAttachment,
                    discount_decision: 'pending',
                    content_hash: result.contentHash,
                    signed_at: result.signedAt
                }
            });
        } catch (err) {
            // Errores con statusCode explícito (ej. saldo insuficiente detectado
            // dentro de la transacción TOCTOU-safe) se devuelven tal cual; el resto
            // es un 500 genérico (sin filtrar detalles internos).
            if (err && err.statusCode) {
                return res.status(err.statusCode).json({ success: false, message: err.message });
            }
            console.error('crearSolicitudFirmada:', err);
            res.status(500).json({ success: false, message: 'Error al crear la solicitud firmada' });
        }
    }

    // POST /api/hr/time-off/:id/attachment — adjunta un justificativo al
    // filesystem (storage_key, NO BLOB). Sólo el dueño (o RRHH/admin) y sólo
    // mientras la solicitud siga pendiente. Múltiples adjuntos acumulan.
    // El archivo ya viene validado por multer (tamaño/tipo) → req.file.
    static async subirJustificativo(req, res) {
        try {
            const { id } = req.params;
            const file = req.file;
            if (!file) {
                return res.status(400).json({ success: false, message: 'No se recibió ningún archivo (campo "file")' });
            }
            // Doble validación de MIME (defensa en profundidad; multer ya filtró).
            if (!ALLOWED_ATTACHMENT_MIME.includes(file.mimetype)) {
                return res.status(415).json({ success: false, message: 'Tipo de archivo no permitido (solo PDF/PNG/JPEG)' });
            }

            const reqRow = await db.queryOne(`
                SELECT r.id, r.status, r.discount_decision, e.user_id AS owner_user_id
                FROM time_off_requests r
                JOIN hr_employees e ON e.id = r.employee_id
                WHERE r.id = ?
            `, [id]);
            if (!reqRow) return res.status(404).json({ success: false, message: 'Solicitud no encontrada' });

            // Autorización: dueño o RRHH/admin.
            const ctx = await getUserContext(req.user.id, req);
            const isOwner = reqRow.owner_user_id === req.user.id;
            const canManage = ctx.isAdmin || ctx.permissions.has('hr.read.all');
            if (!isOwner && !canManage) {
                return res.status(403).json({ success: false, message: 'Sin permisos para adjuntar a esta solicitud' });
            }

            // Sólo se adjunta mientras la solicitud sigue pendiente.
            if (!HrController.PENDING_STATUSES.includes(reqRow.status)) {
                return res.status(409).json({ success: false, message: `No se puede adjuntar: la solicitud está en estado '${reqRow.status}'` });
            }

            // Persistir al volumen y registrar metadatos (NO BLOB en DB).
            const storageKey = storage.newStorageKey(file.originalname);
            storage.writeBufferToStorage(storageKey, file.buffer);

            const ins = await db.execute(
                `INSERT INTO hr_request_attachments
                 (request_id, storage_key, file_name, mime_type, file_size, uploaded_by)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [reqRow.id, storageKey, file.originalname, file.mimetype, file.size, req.user.id]
            );

            return res.status(201).json({
                success: true,
                message: 'Justificativo guardado',
                data: {
                    id: ins.lastInsertId,
                    request_id: reqRow.id,
                    file_name: file.originalname,
                    mime_type: file.mimetype,
                    file_size: file.size,
                    discount_decision: reqRow.discount_decision
                }
            });
        } catch (err) {
            console.error('subirJustificativo:', err);
            res.status(500).json({ success: false, message: 'Error al guardar el justificativo' });
        }
    }

    // POST /api/hr/time-off/:id/approve — aprueba en el nivel que corresponde
    // al actor (resuelto server-side por estado + relación). Delega en el helper
    // compartido con reject.
    static async aprobarSolicitud(req, res) {
        return HrController._decideTimeOff(req, res, 'approve');
    }

    // POST /api/hr/time-off/:id/reject — rechaza (comentario obligatorio).
    static async rechazarSolicitud(req, res) {
        return HrController._decideTimeOff(req, res, 'reject');
    }

    // Lógica compartida approve/reject. El NIVEL se decide server-side:
    //   - pending_jefe (sólo vacaciones): el actor debe ser jefe del solicitante
    //     (manager_id o is_head del depto). Approve → pending_tthh. Reject → rejected.
    //   - pending_tthh: el actor debe ser TTHH (rol rrhh/gerencia/admin; el guard
    //     de ruta ya exige hr.timeoff.approve). Approve → approved + marca descuento.
    // Orden forzado: TTHH no puede aprobar una vacación que sigue en pending_jefe → 409.
    static async _decideTimeOff(req, res, action) {
        try {
            const { id } = req.params;
            const comment = req.body && typeof req.body.comment === 'string' ? req.body.comment : null;

            // Reject exige comentario (3-1000 chars).
            if (action === 'reject') {
                if (!comment || comment.trim().length < 3 || comment.length > 1000) {
                    return res.status(400).json({ success: false, message: 'El comentario del rechazo es obligatorio (3 a 1000 caracteres)' });
                }
            } else if (comment !== null && comment.length > 1000) {
                return res.status(400).json({ success: false, message: 'El comentario no puede superar 1000 caracteres' });
            }

            // Se traen tanto user_id (lo usa resolveJefeApproverUserIds para la
            // exclusión de auto-aprobación) como owner_user_id (alias explícito
            // que dejan claro los chequeos de dueño). Son la misma columna.
            const reqRow = await db.queryOne(`
                SELECT r.id, r.status, r.request_type, r.employee_id, r.discount_decision,
                       e.user_id, e.user_id AS owner_user_id, e.manager_id, e.department_id, e.full_name
                FROM time_off_requests r
                JOIN hr_employees e ON e.id = r.employee_id
                WHERE r.id = ?
            `, [id]);
            if (!reqRow) return res.status(404).json({ success: false, message: 'Solicitud no encontrada' });

            const ctx = await getUserContext(req.user.id, req);
            // "TTHH" = quien decide el paso de RRHH: admin o el permiso de aprobación
            // a nivel RRHH. El permiso hr.timeoff.approve lo tienen también los jefes
            // de área por seed, por eso el paso TTHH exige ADEMÁS no depender sólo de
            // ser jefe: usamos hr.read.all (lo tiene rrhh/gerencia/admin) como marca
            // de "rol RRHH/gerencia", coherente con canCreateForOthers del módulo.
            const isTthh = ctx.isAdmin || ctx.permissions.has('hr.read.all');

            if (reqRow.status === 'pending_jefe') {
                // Paso JEFE (sólo ocurre en vacaciones). Autorización POR DATOS:
                // el actor debe ser jefe del solicitante. TTHH no puede saltarse
                // el orden aquí: si es una vacación aún en pending_jefe, el paso
                // TTHH todavía no aplica → 409 (orden forzado), salvo que el actor
                // sea efectivamente el jefe.
                const jefeApprovers = await HrController.resolveJefeApproverUserIds(reqRow);
                const isJefe = jefeApprovers.has(req.user.id);
                if (!isJefe) {
                    // Si quien intenta es TTHH (no jefe), el conflicto es de ORDEN:
                    // debe esperar a que el jefe actúe primero → 409. Si no es ni
                    // jefe ni TTHH, es falta de relación → 403.
                    if (isTthh) {
                        return res.status(409).json({ success: false, message: 'El jefe inmediato debe aprobar antes que TTHH (orden forzado)' });
                    }
                    return res.status(403).json({ success: false, message: 'No sos el jefe del solicitante para esta aprobación' });
                }
                return HrController._applyDecision(res, reqRow, 'jefe', action, comment, req.user.id);
            }

            if (reqRow.status === 'pending_tthh') {
                // Paso TTHH. Exige rol RRHH/gerencia/admin (no basta ser jefe de otro área).
                if (!isTthh) {
                    return res.status(403).json({ success: false, message: 'Solo TTHH (RRHH/Gerencia) puede aprobar en este nivel' });
                }
                return HrController._applyDecision(res, reqRow, 'tthh', action, comment, req.user.id);
            }

            // Estado terminal o 'pending' histórico → no hay paso pendiente del actor.
            return res.status(409).json({ success: false, message: `La solicitud ya está en estado '${reqRow.status}' y no admite esta acción` });
        } catch (err) {
            console.error('_decideTimeOff:', err);
            res.status(500).json({ success: false, message: 'Error al procesar la decisión' });
        }
    }

    // Aplica la transición de approve/reject de forma atómica: actualiza la
    // solicitud, registra el paso inmutable en hr_approval_steps y (sólo en la
    // aprobación FINAL de TTHH) sella balance_marked_at + fija discount_decision.
    static async _applyDecision(res, reqRow, level, action, comment, actorUserId) {
        // step_order: 1=jefe; para tthh es 2 si la vacación pasó por el jefe, 1 si
        // nació RRHH-directa. Lo derivamos contando pasos previos de la solicitud.
        const prev = await db.queryOne(
            'SELECT COUNT(*) AS c FROM hr_approval_steps WHERE request_id = ?',
            [reqRow.id]
        );
        const stepOrder = Number(prev.c || 0) + 1;

        let newStatus;
        let balanceMarked = false;

        if (action === 'reject') {
            newStatus = 'rejected';
        } else if (level === 'jefe') {
            newStatus = 'pending_tthh'; // el jefe aprobó → ahora decide TTHH
        } else {
            newStatus = 'approved';     // aprobación FINAL de TTHH
            balanceMarked = true;
        }

        await db.transaction(async (tx) => {
            if (action === 'reject') {
                await tx.execute(
                    `UPDATE time_off_requests
                     SET status = 'rejected', approved_by = ?, approved_at = CURRENT_TIMESTAMP,
                         rejection_reason = ?, updated_at = CURRENT_TIMESTAMP
                     WHERE id = ?`,
                    [actorUserId, comment, reqRow.id]
                );
            } else if (level === 'jefe') {
                await tx.execute(
                    `UPDATE time_off_requests
                     SET status = 'pending_tthh', updated_at = CURRENT_TIMESTAMP
                     WHERE id = ?`,
                    [reqRow.id]
                );
            } else {
                // Aprobación final de TTHH. Si la decisión de descuento sigue en
                // 'pending', la fijamos en 'discount' por defecto (TTHH puede luego
                // hacer waive vía /discount-decision). balance_marked_at es el
                // gancho que F3/F4 leerá para ejecutar el descuento numérico.
                const nextDiscount = reqRow.discount_decision === 'pending' ? 'discount' : reqRow.discount_decision;
                await tx.execute(
                    `UPDATE time_off_requests
                     SET status = 'approved', approved_by = ?, approved_at = CURRENT_TIMESTAMP,
                         discount_decision = ?, balance_marked_at = CURRENT_TIMESTAMP,
                         updated_at = CURRENT_TIMESTAMP
                     WHERE id = ?`,
                    [actorUserId, nextDiscount, reqRow.id]
                );
            }

            await tx.execute(
                `INSERT INTO hr_approval_steps
                 (request_id, step_order, step_level, approver_user_id, action, comment)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [reqRow.id, stepOrder, level, actorUserId, action, comment]
            );
        });

        return res.json({
            success: true,
            message: action === 'approve' ? 'Solicitud aprobada' : 'Solicitud rechazada',
            data: {
                id: reqRow.id,
                status: newStatus,
                step_level: level,
                action,
                balance_marked_for_discount: balanceMarked
            }
        });
    }

    // POST /api/hr/time-off/:id/discount-decision — decisión EXCLUSIVA de TTHH
    // sobre si la solicitud descuenta saldo. El guard de ruta exige el permiso
    // nuevo hr.timeoff.waive_discount. waive (discount=false) sólo aplica a
    // tipos que descuentan vacaciones/días-ley; sobre feriado_compensado → 400.
    static async decidirDescuento(req, res) {
        try {
            const { id } = req.params;
            const { discount, reason } = req.body || {};

            if (typeof discount !== 'boolean') {
                return res.status(400).json({ success: false, message: 'discount (boolean) es obligatorio' });
            }
            // reason obligatorio cuando NO descuenta (waive).
            if (discount === false) {
                if (typeof reason !== 'string' || reason.trim().length < 3 || reason.length > 1000) {
                    return res.status(400).json({ success: false, message: 'reason es obligatorio (3 a 1000 caracteres) cuando discount=false' });
                }
            }

            const reqRow = await db.queryOne(
                'SELECT id, status, request_type FROM time_off_requests WHERE id = ?',
                [id]
            );
            if (!reqRow) return res.status(404).json({ success: false, message: 'Solicitud no encontrada' });

            // waive sobre feriado_compensado no tiene semántica (su saldo es el banco).
            if (discount === false && !WAIVABLE_TYPES.includes(reqRow.request_type)) {
                return res.status(400).json({ success: false, message: `El tipo '${reqRow.request_type}' no admite "justificado sin descuento"` });
            }

            // Sólo aplicable cuando está aprobada o pendiente de TTHH; sobre
            // rejected/cancelled (o aún en pending_jefe) → 409.
            if (!['approved', 'pending_tthh'].includes(reqRow.status)) {
                return res.status(409).json({ success: false, message: `No se puede decidir el descuento con la solicitud en estado '${reqRow.status}'` });
            }

            const newDecision = discount ? 'discount' : 'waived';
            const waivedBy = discount ? null : req.user.id;
            const waivedReason = discount ? null : reason;

            await db.execute(
                `UPDATE time_off_requests
                 SET discount_decision = ?, waived_by = ?, waived_reason = ?, updated_at = CURRENT_TIMESTAMP
                 WHERE id = ?`,
                [newDecision, waivedBy, waivedReason, id]
            );

            return res.json({
                success: true,
                message: 'Decisión de descuento registrada',
                data: {
                    id: Number(id),
                    discount_decision: newDecision,
                    waived_by: waivedBy,
                    waived_reason: waivedReason
                }
            });
        } catch (err) {
            console.error('decidirDescuento:', err);
            res.status(500).json({ success: false, message: 'Error al registrar la decisión de descuento' });
        }
    }

    // GET /api/hr/time-off/:id/approval-history — trazabilidad completa:
    // pasos del workflow + firma (con verificación de integridad) + decisión de
    // descuento + metadatos de adjuntos. Visibilidad: mismo modelo que
    // listTimeOffRequests (own/team/all); fuera de scope → 404. La cédula del
    // firmante se OMITE a quien no sea dueño/hr.read.all/admin.
    static async obtenerHistorialAprobacion(req, res) {
        try {
            const { id } = req.params;

            const reqRow = await db.queryOne(`
                SELECT r.id, r.employee_id, r.request_type, r.status, r.discount_decision,
                       r.date_from, r.date_to, r.days_count, r.reason,
                       r.waived_by, r.waived_reason,
                       e.user_id AS owner_user_id
                FROM time_off_requests r
                JOIN hr_employees e ON e.id = r.employee_id
                WHERE r.id = ?
            `, [id]);
            if (!reqRow) return res.status(404).json({ success: false, message: 'Solicitud no encontrada' });

            // Visibilidad: own/team/all. Fuera de scope → 404 (no revelar existencia).
            const visibleIds = await getVisibleEmployeeIds(req.user.id);
            if (visibleIds !== null && !visibleIds.includes(reqRow.employee_id)) {
                return res.status(404).json({ success: false, message: 'Solicitud no encontrada o sin permisos' });
            }

            const ctx = await getUserContext(req.user.id, req);
            const isOwner = reqRow.owner_user_id === req.user.id;
            const canSeeDocId = isOwner || ctx.isAdmin || ctx.permissions.has('hr.read.all');

            // ---- Firma + verificación de integridad ----
            const sigRow = await db.queryOne(
                `SELECT signer_user_id, signer_name, signer_doc_id, accepted, content_hash, signed_at
                 FROM hr_signatures WHERE entity_type = ? AND entity_id = ?`,
                [SIGNATURE_ENTITY_TYPE, reqRow.id]
            );
            let signature = null;
            if (sigRow) {
                // Recomputar el hash sobre el payload SUSTANTIVO ACTUAL de la
                // solicitud + identidad. Si alguien tocó fechas/días/motivo en DB,
                // no coincidirá → signature_integrity=false (tamper detectado).
                const recomputed = computeSignatureHash({
                    entity_id: reqRow.id,
                    request_type: reqRow.request_type,
                    date_from: reqRow.date_from,
                    date_to: reqRow.date_to,
                    days_count: reqRow.days_count,
                    reason: reqRow.reason,
                    signer_user_id: sigRow.signer_user_id,
                    signer_name: sigRow.signer_name,
                    signer_doc_id: sigRow.signer_doc_id,
                    signed_at: sigRow.signed_at
                });
                signature = {
                    signer_user_id: sigRow.signer_user_id,
                    signer_name: sigRow.signer_name,
                    accepted: !!sigRow.accepted,
                    content_hash: sigRow.content_hash,
                    signature_integrity: recomputed === sigRow.content_hash,
                    signed_at: sigRow.signed_at
                };
                // Cédula: presente SÓLO para dueño/hr.read.all/admin; OMITIDA (no
                // enmascarada) para el resto — mismo criterio que delete employee.doc_id.
                if (canSeeDocId) signature.signer_doc_id = sigRow.signer_doc_id;
            }

            // ---- Pasos del workflow (orden cronológico) ----
            const steps = await db.query(`
                SELECT s.id, s.step_order, s.step_level, s.approver_user_id, s.action, s.comment, s.acted_at,
                       u.full_name AS approver_name
                FROM hr_approval_steps s
                LEFT JOIN users u ON u.id = s.approver_user_id
                WHERE s.request_id = ?
                ORDER BY s.step_order ASC, s.acted_at ASC
            `, [reqRow.id]);

            // ---- Adjuntos (metadatos, sin binario) ----
            const attachments = await db.query(`
                SELECT id, file_name, mime_type, file_size, uploaded_by, uploaded_at
                FROM hr_request_attachments
                WHERE request_id = ?
                ORDER BY uploaded_at ASC
            `, [reqRow.id]);

            return res.json({
                success: true,
                data: {
                    request: {
                        id: reqRow.id,
                        employee_id: reqRow.employee_id,
                        request_type: reqRow.request_type,
                        status: reqRow.status,
                        discount_decision: reqRow.discount_decision,
                        waived_by: reqRow.waived_by != null ? reqRow.waived_by : null,
                        waived_reason: reqRow.waived_reason != null ? reqRow.waived_reason : null
                    },
                    signature,
                    steps,
                    attachments
                }
            });
        } catch (err) {
            console.error('obtenerHistorialAprobacion:', err);
            res.status(500).json({ success: false, message: 'Error al obtener el historial' });
        }
    }
}

module.exports = HrController;
