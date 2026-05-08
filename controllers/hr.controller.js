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
                SELECT e.id, e.user_id, e.full_name, e.position_id, e.department_id,
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
