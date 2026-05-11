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
const db = require('../config/db');
const { getUserContext } = require('./rbac.controller');

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
            const { id } = req.params;
            const reports = await db.query(`
                SELECT e.id, e.full_name, p.title AS position_title, e.status
                FROM hr_employees e
                LEFT JOIN hr_positions p ON e.position_id = p.id
                WHERE e.manager_id = ?
                ORDER BY e.full_name
            `, [id]);
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
            const users = await db.query(`
                SELECT u.id, u.full_name,
                       (SELECT department_id FROM user_departments
                        WHERE user_id = u.id ORDER BY id LIMIT 1) AS first_dept
                FROM users u
                LEFT JOIN hr_employees e ON e.user_id = u.id
                WHERE e.id IS NULL AND u.is_active = 1
            `);
            let created = 0;
            for (const u of users) {
                try {
                    await db.execute(
                        `INSERT INTO hr_employees (user_id, full_name, department_id, status)
                         VALUES (?, ?, ?, 'active')`,
                        [u.id, u.full_name, u.first_dept || null]
                    );
                    created++;
                } catch (e) {
                    console.warn(`sync skip user ${u.id}:`, e.message);
                }
            }
            res.json({ success: true, data: { created, total_scanned: users.length } });
        } catch (err) {
            console.error('syncEmployeesFromUsers:', err);
            res.status(500).json({ success: false, message: 'Error en backfill de empleados' });
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
            const credit = (days_credit !== undefined && !isNaN(Number(days_credit)))
                ? Number(days_credit) : 1;

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
                hours_worked || null, credit, notes || null, req.user.id
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
            const r = await db.queryOne('SELECT id FROM holiday_attendance WHERE id = ?', [attendanceId]);
            if (!r) return res.status(404).json({ success: false, message: 'Registro no encontrado' });
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

            const credit = await db.queryOne(`
                SELECT COALESCE(SUM(days_credit), 0) AS total
                FROM holiday_attendance
                WHERE employee_id = ?
            `, [id]);

            // PR-3c: descontar solicitudes aprobadas de tipo 'feriado_compensado'.
            const usedRow = await db.queryOne(`
                SELECT COALESCE(SUM(days_count), 0) AS total
                FROM time_off_requests
                WHERE employee_id = ?
                  AND request_type = 'feriado_compensado'
                  AND status = 'approved'
            `, [id]);
            const used = Number(usedRow.total || 0);
            const accrued = Number(credit.total || 0);

            res.json({
                success: true,
                data: {
                    employee_id: Number(id),
                    days_accrued: accrued,
                    days_used: used,
                    balance: accrued - used
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

    // Crear solicitud. Empleado pide para sí mismo; RRHH/Gerencia pueden
    // crear en nombre de cualquier empleado.
    static async createTimeOffRequest(req, res) {
        try {
            const { employee_id, request_type, date_from, date_to, days_count, reason } = req.body;
            if (!request_type || !date_from || !date_to || !days_count) {
                return res.status(400).json({
                    success: false,
                    message: 'request_type, date_from, date_to y days_count son requeridos'
                });
            }
            const validTypes = ['vacaciones','feriado_compensado','permiso_personal','enfermedad','otro'];
            if (!validTypes.includes(request_type)) {
                return res.status(400).json({
                    success: false,
                    message: `request_type inválido. Válidos: ${validTypes.join(', ')}`
                });
            }
            if (date_from > date_to) {
                return res.status(400).json({
                    success: false,
                    message: 'date_from no puede ser posterior a date_to'
                });
            }

            // Resolver el employee_id objetivo.
            let targetEmpId = employee_id;
            const ctx = await getUserContext(req.user.id, req);
            const canCreateForOthers = ctx.isAdmin || ctx.permissions.has('hr.read.all');

            if (!targetEmpId) {
                // Sin employee_id explícito: solicitar para sí mismo.
                const me = await db.queryOne('SELECT id FROM hr_employees WHERE user_id = ?', [req.user.id]);
                if (!me) {
                    return res.status(400).json({
                        success: false,
                        message: 'No tienes perfil de empleado. Pedí a RRHH que te lo cree.'
                    });
                }
                targetEmpId = me.id;
            } else if (!canCreateForOthers) {
                // Tiene employee_id explícito pero no es admin/RRHH: solo puede ser él mismo.
                const me = await db.queryOne('SELECT id FROM hr_employees WHERE user_id = ?', [req.user.id]);
                if (!me || me.id !== Number(targetEmpId)) {
                    return res.status(403).json({
                        success: false,
                        message: 'Solo podés solicitar días libres para vos mismo.'
                    });
                }
            }

            // Si tipo='feriado_compensado', validar saldo (no permite ir a negativo).
            if (request_type === 'feriado_compensado') {
                const credit = await db.queryOne(
                    'SELECT COALESCE(SUM(days_credit), 0) AS total FROM holiday_attendance WHERE employee_id = ?',
                    [targetEmpId]
                );
                const usedApproved = await db.queryOne(`
                    SELECT COALESCE(SUM(days_count), 0) AS total
                    FROM time_off_requests
                    WHERE employee_id = ?
                      AND request_type = 'feriado_compensado'
                      AND status IN ('approved','pending')
                `, [targetEmpId]);
                const balance = Number(credit.total || 0) - Number(usedApproved.total || 0);
                if (Number(days_count) > balance) {
                    return res.status(400).json({
                        success: false,
                        message: `Saldo insuficiente. Disponible: ${balance} día(s), pediste ${days_count}.`
                    });
                }
            }

            const r = await db.execute(
                `INSERT INTO time_off_requests
                 (employee_id, request_type, date_from, date_to, days_count, reason, requested_by)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [targetEmpId, request_type, date_from, date_to, days_count, reason || null, req.user.id]
            );
            res.status(201).json({ success: true, data: { id: r.lastInsertId } });
        } catch (err) {
            console.error('createTimeOffRequest:', err);
            res.status(500).json({ success: false, message: 'Error al crear solicitud' });
        }
    }

    static async approveTimeOffRequest(req, res) {
        try {
            const { id } = req.params;
            const r = await db.queryOne('SELECT id, status FROM time_off_requests WHERE id = ?', [id]);
            if (!r) return res.status(404).json({ success: false, message: 'Solicitud no encontrada' });
            if (r.status !== 'pending') {
                return res.status(400).json({
                    success: false,
                    message: `La solicitud ya está en estado '${r.status}'`
                });
            }
            await db.execute(
                `UPDATE time_off_requests
                 SET status = 'approved', approved_by = ?, approved_at = CURRENT_TIMESTAMP,
                     updated_at = CURRENT_TIMESTAMP
                 WHERE id = ?`,
                [req.user.id, id]
            );
            res.json({ success: true, message: 'Solicitud aprobada' });
        } catch (err) {
            console.error('approveTimeOffRequest:', err);
            res.status(500).json({ success: false, message: 'Error al aprobar' });
        }
    }

    static async rejectTimeOffRequest(req, res) {
        try {
            const { id } = req.params;
            const { reason } = req.body || {};
            const r = await db.queryOne('SELECT id, status FROM time_off_requests WHERE id = ?', [id]);
            if (!r) return res.status(404).json({ success: false, message: 'Solicitud no encontrada' });
            if (r.status !== 'pending') {
                return res.status(400).json({
                    success: false,
                    message: `La solicitud ya está en estado '${r.status}'`
                });
            }
            await db.execute(
                `UPDATE time_off_requests
                 SET status = 'rejected', approved_by = ?, approved_at = CURRENT_TIMESTAMP,
                     rejection_reason = ?, updated_at = CURRENT_TIMESTAMP
                 WHERE id = ?`,
                [req.user.id, reason || null, id]
            );
            res.json({ success: true, message: 'Solicitud rechazada' });
        } catch (err) {
            console.error('rejectTimeOffRequest:', err);
            res.status(500).json({ success: false, message: 'Error al rechazar' });
        }
    }

    // El propio solicitante puede cancelar su solicitud si está pending.
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
            if (r.status !== 'pending') {
                return res.status(400).json({
                    success: false,
                    message: `La solicitud ya está en estado '${r.status}'`
                });
            }
            const ctx = await getUserContext(req.user.id, req);
            const isOwner = r.owner_user_id === req.user.id;
            const canManage = ctx.isAdmin || ctx.permissions.has('hr.timeoff.approve');
            if (!isOwner && !canManage) {
                return res.status(403).json({ success: false, message: 'Sin permisos para cancelar esta solicitud' });
            }
            await db.execute(
                `UPDATE time_off_requests
                 SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP
                 WHERE id = ?`,
                [id]
            );
            res.json({ success: true, message: 'Solicitud cancelada' });
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
            const allowed = ['full_name', 'doc_id', 'email_personal', 'phone',
                             'position_id', 'department_id', 'manager_id',
                             'hire_date', 'status', 'address', 'notes', 'user_id', 'base_salary'];
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
}

module.exports = HrController;
