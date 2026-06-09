/**
 * Payroll Controller — Nómina / Roles de Pago v1.2 (backend)
 *
 * Tres recursos bajo /api/hr/payroll:
 *   - params : parámetros legales/operativos (key-value auditado).
 *   - runs   : corridas mensuales (cabecera) — snapshot inmutable.
 *   - details: renglón por empleado dentro de una corrida (parte del run).
 *
 * Arquitectura (igual que el resto del repo): routes → controller (clase con
 * métodos static async) → config/db. SIN service/repository/DTO. Acceso a datos
 * directo con placeholders ? (dual-driver SQLite/Postgres).
 *
 * Reglas CRÍTICAS implementadas acá (ver 13-notes.md):
 *   - INMUTABILIDAD (§0/§4): al generar un run congelamos en CADA payroll_details
 *     los % de parámetros + SBU + las 2 banderas del empleado. La lectura y el
 *     PDF usan ese snapshot, nunca payroll_parameters actuales.
 *   - PRIVACIDAD / PII (§0): los total_* del run son masa salarial de TODA la
 *     empresa. Se devuelven SÓLO si ctx.isAdmin || permissions.has('hr.payroll.read.all').
 *     Sin ese permiso: total_* OMITIDOS y details filtrado a los renglones propios
 *     (getVisibleEmployeeIds). El gate es el permiso DEDICADO de nómina, NO hr.read.all.
 *   - RANGOS (§5): SQLite REAL no acota; validamos app-side para no romper Postgres
 *     (numeric field overflow). Montos por-renglón → [0, 9999999999.99]; totales →
 *     [0, 999999999999.99]; porcentajes → [0,100]; value de parámetro → [0, 99999999.9999].
 */
const db = require('../config/db');
const { getUserContext } = require('./rbac.controller');

// ============================================================
// Constantes nombradas (cero magic numbers / strings)
// ============================================================

// Permiso DEDICADO que decide la PROYECCIÓN (totales + todos los renglones).
// Desacoplado de hr.read.all a propósito (mínimo privilegio; ver §0). El permiso
// que HABILITA el endpoint (hr.payroll.read) se exige en la ruta, no acá.
const PERM_PAYROLL_READ_ALL = 'hr.payroll.read.all';

// Patrón canónico de la `key` de un parámetro (igual que el contrato OpenAPI).
const PARAM_KEY_PATTERN = /^[a-z][a-z0-9_]{1,49}$/;

// Las 4 keys de parámetros que el cálculo necesita leer (y congelar).
const PARAM_IESS_PERSONAL = 'iess_personal_pct';
const PARAM_IESS_PATRONAL = 'iess_patronal_pct';
const PARAM_SBU = 'sbu';
const PARAM_FONDOS_RESERVA = 'fondos_reserva_pct';

// Rangos por tipo de columna (para caber en el tipo Postgres más estricto).
const MAX_ROW_AMOUNT = 9999999999.99;       // NUMERIC(12,2) por-renglón
const MAX_TOTAL_AMOUNT = 999999999999.99;   // NUMERIC(14,2) agregado del run
const MAX_PCT = 100;                         // porcentaje
const MAX_PARAM_VALUE = 99999999.9999;      // NUMERIC(12,4) value de parámetro

// Estados de una corrida (máquina de estados draft → finalized).
const RUN_STATUS_DRAFT = 'draft';
const RUN_STATUS_FINALIZED = 'finalized';

// Límites de período y de la lista de empleados (coinciden con el contrato).
const MIN_YEAR = 2000;
const MAX_YEAR = 2100;
const MAX_EMPLOYEE_IDS = 5000;

// Constantes del cálculo legal (Ecuador).
const MESES_DEL_ANIO = 12;       // décimos mensualizados se dividen por 12
const PORCENTAJE_BASE = 100;     // los % se aplican como valor/100


// ============================================================
// Helpers a nivel módulo (funciones chicas, junior-friendly)
// ============================================================

// Redondeo a 2 decimales, idéntico al criterio del repo (upsertAttendance usa
// Math.round(x*100)/100). Se aplica por componente Y por total para que el
// desglose y el total del PDF no descuadren centavos.
function round2(x) {
    const n = Number(x) || 0;
    // Half-up a 2 decimales, ROBUSTO al error de representación IEEE754. Sin el
    // factor relativo (1+EPSILON), p.ej. 1.005*100 = 100.4999... bajaría mal a 1.00
    // → −1 centavo vs la planilla de Contabilidad. El factor corrige ese sesgo en
    // TODO el rango de sueldos (los montos de nómina son siempre >= 0).
    return Math.round(n * 100 * (1 + Number.EPSILON)) / 100;
}

// ¿El solicitante puede ver los total_* y TODOS los renglones? Gate único de PII.
function canSeeAllPayroll(ctx) {
    return ctx.isAdmin || ctx.permissions.has(PERM_PAYROLL_READ_ALL);
}

// Las columnas booleanas se guardan como INTEGER 0/1 en AMBOS drivers; al leer
// pueden venir como número. Las normalizamos a boolean para la respuesta del API
// (el contrato declara mensualiza_decimos_snapshot / paga_fondos_mensual_snapshot
// como boolean y required).
function toBool(value) {
    return value === 1 || value === true || value === '1';
}

// Normaliza el value numérico de un parámetro (PG NUMERIC llega como string,
// SQLite REAL como number) a Number para usarlo en el cálculo.
function toNumber(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
}

// Lee warnings_json (TEXT en ambos drivers) de forma segura: string → parse;
// si ya viniera como objeto/array (defensa), lo devolvemos tal cual; null → [].
function parseWarnings(raw) {
    if (raw == null) return [];
    if (typeof raw === 'string') {
        try {
            const parsed = JSON.parse(raw);
            return Array.isArray(parsed) ? parsed : [];
        } catch (_) {
            return [];
        }
    }
    return Array.isArray(raw) ? raw : [];
}

// ¿El empleado superó (estricto) 1 año de antigüedad para la fecha de corte?
// Comparación por FECHAS CALENDARIO (NO por días/365.25): el primer aniversario
// (hire_date + 1 año) debe ser ANTERIOR al último día del período. Así maneja
// bisiestos y meses de distinto largo sin el sesgo de centésimas de año, y un rol
// pasado es reproducible (la antigüedad se mide al fin del período, no a "hoy").
// Dual-driver + TZ-safe: SQLite da 'YYYY-MM-DD' (string), Postgres da Date;
// comparamos claves enteras YYYYMMDD para no depender de husos horarios.
function superoUnAnio(hireDate, cutoffDate) {
    if (!hireDate) return false;
    let hy, hm, hd;
    if (typeof hireDate === 'string') {
        const mt = hireDate.match(/^(\d{4})-(\d{2})-(\d{2})/);
        if (!mt) return false;
        hy = +mt[1]; hm = +mt[2]; hd = +mt[3];
    } else {
        const dt = new Date(hireDate);
        if (Number.isNaN(dt.getTime())) return false;
        hy = dt.getUTCFullYear(); hm = dt.getUTCMonth() + 1; hd = dt.getUTCDate();
    }
    const annivKey = (hy + 1) * 10000 + hm * 100 + hd;  // YYYYMMDD del 1er aniversario
    const cutKey = cutoffDate.getFullYear() * 10000 + (cutoffDate.getMonth() + 1) * 100 + cutoffDate.getDate();
    return annivKey < cutKey;  // estricto: aniversario ANTES del corte ⇒ > 1 año
}

// Último día del período (mes/año) como Date — fecha de corte de la antigüedad.
// new Date(year, month, 0) da el último día del mes anterior a `month` (1-based),
// es decir el último día del mes pedido.
function ultimoDiaDelPeriodo(periodMonth, periodYear) {
    return new Date(periodYear, periodMonth, 0);
}

// ¿Un monto por-renglón cabe en NUMERIC(12,2)? Lo usamos para abortar con 422
// ANTES de insertar (no dejar que Postgres tire 500 por overflow).
function excedeRangoRenglon(x) {
    return Number(x) < 0 || Number(x) > MAX_ROW_AMOUNT;
}

// Replica EXACTA del helper de hr.controller (no se exporta desde ahí). Devuelve
// los employee_id visibles para el user, o null si ve TODO (admin / hr.read.all).
// Es el mecanismo para acotar `details` de quien no tiene hr.payroll.read.all.
// Se mantiene idéntico al de HR a propósito: misma semántica de visibilidad.
async function getVisibleEmployeeIds(userId) {
    const ctx = await getUserContext(userId);
    if (ctx.isAdmin || ctx.permissions.has('hr.read.all')) return null;

    const ids = new Set();

    // hr.read.own: su propio empleado.
    if (ctx.permissions.has('hr.read.own')) {
        const own = await db.queryOne('SELECT id FROM hr_employees WHERE user_id = ?', [userId]);
        if (own) ids.add(own.id);
    }

    // hr.read.team: empleados de deptos donde es jefe + reportes directos.
    if (ctx.permissions.has('hr.read.team')) {
        const headDeptIds = ctx.departments.filter(d => d.is_head).map(d => d.id);
        if (headDeptIds.length > 0) {
            const placeholders = headDeptIds.map(() => '?').join(',');
            const team = await db.query(
                `SELECT id FROM hr_employees WHERE department_id IN (${placeholders})`,
                headDeptIds
            );
            team.forEach(e => ids.add(e.id));
        }
        const myEmp = await db.queryOne('SELECT id FROM hr_employees WHERE user_id = ?', [userId]);
        if (myEmp) {
            const reports = await db.query('SELECT id FROM hr_employees WHERE manager_id = ?', [myEmp.id]);
            reports.forEach(e => ids.add(e.id));
        }
    }

    return Array.from(ids);
}

// Lee y normaliza los 4 parámetros de nómina vigentes (numeradores/factores del
// cálculo). Devuelve { iess_personal_pct, iess_patronal_pct, sbu, fondos_reserva_pct }.
// Si una key faltara (no debería: se siembra en init-db), usa 0 — el cálculo da 0
// sin romper (los parámetros nunca son denominadores; ver §6.3).
async function leerParametrosVigentes() {
    const rows = await db.query(
        'SELECT key, value FROM payroll_parameters WHERE key IN (?, ?, ?, ?)',
        [PARAM_IESS_PERSONAL, PARAM_IESS_PATRONAL, PARAM_SBU, PARAM_FONDOS_RESERVA]
    );
    const byKey = {};
    for (const r of rows) byKey[r.key] = toNumber(r.value);
    return {
        iess_personal_pct: byKey[PARAM_IESS_PERSONAL] || 0,
        iess_patronal_pct: byKey[PARAM_IESS_PATRONAL] || 0,
        sbu: byKey[PARAM_SBU] || 0,
        fondos_reserva_pct: byKey[PARAM_FONDOS_RESERVA] || 0
    };
}

// Calcula el renglón de UN empleado (flowchart (b) del spec). NO toca la DB:
// es pura aritmética sobre el empleado + los parámetros congelados. Devuelve el
// objeto listo para insertar en payroll_details (más `warnings`). El caller
// valida rangos y persiste.
//
// `params` son los % vigentes (ya leídos UNA vez al iniciar la corrida) → se
// congelan idénticos en cada renglón (snapshot inmutable).
function calcularRenglonEmpleado(employee, params, periodMonth, periodYear) {
    const warnings = [];

    // sueldo_base = base_salary ?? 0 (edge case §6.1: NULL → 0 + warning).
    let sueldoBase = 0;
    if (employee.base_salary == null) {
        warnings.push('sin sueldo base');
    } else {
        sueldoBase = toNumber(employee.base_salary);
    }

    // Banderas del empleado (INTEGER 0/1 en la columna) → boolean para la lógica.
    const mensualizaDecimos = toBool(employee.mensualiza_decimos);
    const pagaFondosMensual = toBool(employee.paga_fondos_mensual);

    // v1: horas extra y otros ingresos/descuentos no se calculan (campos en 0).
    const horasExtra = 0;
    const otrosIngresos = 0;
    const otrosDescuentos = 0;

    // remuneración mensual = sueldo_base + horas_extra → base del décimo 13.
    const remunMensual = sueldoBase + horasExtra;

    // Fondos de reserva: sólo si paga_fondos_mensual Y antigüedad > 1 año (estricto).
    // La antigüedad se mide al ÚLTIMO día del período (reproducible).
    let fondosReserva = 0;
    const cutoff = ultimoDiaDelPeriodo(periodMonth, periodYear);
    if (pagaFondosMensual) {
        if (superoUnAnio(employee.hire_date, cutoff)) {
            fondosReserva = round2(sueldoBase * params.fondos_reserva_pct / PORCENTAJE_BASE);
        } else {
            // Edge case §6.2: pidió fondos pero aún no superó 1 año → 0 + warning.
            warnings.push('antiguedad <= 1 anio: fondos de reserva en 0');
        }
    }

    // Décimos mensualizados (si el empleado lo tiene activado).
    let decimoTercero = 0;
    let decimoCuarto = 0;
    if (mensualizaDecimos) {
        decimoTercero = round2(remunMensual / MESES_DEL_ANIO);   // (sueldo_base + horas_extra)/12
        decimoCuarto = round2(params.sbu / MESES_DEL_ANIO);      // sbu/12
    }

    // total_ingresos = suma de componentes YA redondeados (evita descuadres §6.4).
    const totalIngresos = round2(
        sueldoBase + fondosReserva + decimoTercero + decimoCuarto + horasExtra + otrosIngresos
    );

    // base_aportable = sueldo_base + horas_extra (NO décimos ni fondos; criterio Ecuador).
    const baseAportable = round2(sueldoBase + horasExtra);
    const aportePersonal = round2(baseAportable * params.iess_personal_pct / PORCENTAJE_BASE);
    const totalDescuentos = round2(aportePersonal + otrosDescuentos);

    const netoAPagar = round2(totalIngresos - totalDescuentos);

    // Costo empresa (informativo; no afecta el neto).
    const aportePatronal = round2(baseAportable * params.iess_patronal_pct / PORCENTAJE_BASE);
    const provisiones = 0; // v1: no se informan provisiones de décimos/fondos no mensualizados
    const costoEmpresa = round2(aportePatronal + provisiones);

    return {
        employee_id: employee.id,
        sueldo_base: sueldoBase,
        fondos_reserva: fondosReserva,
        decimo_tercero: decimoTercero,
        decimo_cuarto: decimoCuarto,
        horas_extra: horasExtra,
        otros_ingresos: otrosIngresos,
        total_ingresos: totalIngresos,
        base_aportable: baseAportable,
        aporte_personal: aportePersonal,
        otros_descuentos: otrosDescuentos,
        total_descuentos: totalDescuentos,
        neto_a_pagar: netoAPagar,
        aporte_patronal: aportePatronal,
        provisiones: provisiones,
        costo_empresa: costoEmpresa,
        // Snapshot de parámetros (INMUTABILIDAD).
        iess_personal_pct_snapshot: params.iess_personal_pct,
        iess_patronal_pct_snapshot: params.iess_patronal_pct,
        fondos_reserva_pct_snapshot: params.fondos_reserva_pct,
        sbu_snapshot: params.sbu,
        // Banderas congeladas, como 0/1 para la columna INTEGER.
        mensualiza_decimos_snapshot: mensualizaDecimos ? 1 : 0,
        paga_fondos_mensual_snapshot: pagaFondosMensual ? 1 : 0,
        warnings
    };
}

// Da forma a una fila de payroll_parameters para la respuesta del API
// (normaliza tipos numéricos y deja la auditoría tal cual).
function shapeParameter(row) {
    return {
        key: row.key,
        label: row.label,
        value_type: row.value_type,
        value: toNumber(row.value),
        unit: row.unit ?? null,
        description: row.description ?? null,
        updated_by: row.updated_by ?? null,
        updated_by_username: row.updated_by_username ?? null,
        updated_at: row.updated_at ?? null
    };
}

// Da forma a una fila de payroll_runs para la respuesta. `includeTotals` decide
// si se incluyen los total_* (gate de PII): si es false, se OMITEN (no se
// enmascaran, se quitan del objeto), tal como exige el contrato.
function shapeRun(row, includeTotals) {
    const run = {
        id: row.id,
        period_month: row.period_month,
        period_year: row.period_year,
        status: row.status,
        sbu_snapshot: toNumber(row.sbu_snapshot),
        employee_count: row.employee_count != null ? Number(row.employee_count) : undefined,
        notes: row.notes ?? null,
        generated_by: row.generated_by,
        generated_by_username: row.generated_by_username ?? null,
        finalized_by: row.finalized_by ?? null,
        finalized_at: row.finalized_at ?? null,
        created_at: row.created_at
    };
    if (includeTotals) {
        run.total_ingresos = toNumber(row.total_ingresos);
        run.total_descuentos = toNumber(row.total_descuentos);
        run.total_neto = toNumber(row.total_neto);
        run.total_costo_empresa = toNumber(row.total_costo_empresa);
    }
    return run;
}

// Da forma a una fila de payroll_details para la respuesta (normaliza números,
// booleanos del snapshot y parsea warnings_json).
function shapeDetail(row) {
    return {
        id: row.id,
        run_id: row.run_id,
        employee_id: row.employee_id,
        employee_name: row.employee_name ?? null,
        sueldo_base: toNumber(row.sueldo_base),
        fondos_reserva: toNumber(row.fondos_reserva),
        decimo_tercero: toNumber(row.decimo_tercero),
        decimo_cuarto: toNumber(row.decimo_cuarto),
        horas_extra: toNumber(row.horas_extra),
        otros_ingresos: toNumber(row.otros_ingresos),
        total_ingresos: toNumber(row.total_ingresos),
        base_aportable: toNumber(row.base_aportable),
        aporte_personal: toNumber(row.aporte_personal),
        otros_descuentos: toNumber(row.otros_descuentos),
        total_descuentos: toNumber(row.total_descuentos),
        neto_a_pagar: toNumber(row.neto_a_pagar),
        aporte_patronal: toNumber(row.aporte_patronal),
        provisiones: toNumber(row.provisiones),
        costo_empresa: toNumber(row.costo_empresa),
        iess_personal_pct_snapshot: toNumber(row.iess_personal_pct_snapshot),
        iess_patronal_pct_snapshot: toNumber(row.iess_patronal_pct_snapshot),
        fondos_reserva_pct_snapshot: toNumber(row.fondos_reserva_pct_snapshot),
        sbu_snapshot: toNumber(row.sbu_snapshot),
        mensualiza_decimos_snapshot: toBool(row.mensualiza_decimos_snapshot),
        paga_fondos_mensual_snapshot: toBool(row.paga_fondos_mensual_snapshot),
        warnings: parseWarnings(row.warnings_json)
    };
}

// SELECT canónico de un detalle + el nombre del empleado (join informativo).
const DETAIL_SELECT = `
    SELECT d.*, e.full_name AS employee_name
    FROM payroll_details d
    LEFT JOIN hr_employees e ON e.id = d.employee_id
`;

// Columnas de payroll_details en el orden del INSERT (una sola fuente de verdad
// para construir el INSERT y no desalinear valores).
const DETAIL_INSERT_COLUMNS = [
    'run_id', 'employee_id',
    'sueldo_base', 'fondos_reserva', 'decimo_tercero', 'decimo_cuarto',
    'horas_extra', 'otros_ingresos', 'total_ingresos',
    'base_aportable', 'aporte_personal', 'otros_descuentos', 'total_descuentos',
    'neto_a_pagar', 'aporte_patronal', 'provisiones', 'costo_empresa',
    'iess_personal_pct_snapshot', 'iess_patronal_pct_snapshot',
    'fondos_reserva_pct_snapshot', 'sbu_snapshot',
    'mensualiza_decimos_snapshot', 'paga_fondos_mensual_snapshot',
    'warnings_json'
];


class PayrollController {
    // =========================================================================
    // GET /api/hr/payroll/params — lista los parámetros vigentes.
    // Acceso: hr.payroll.read (en la ruta). Los parámetros NO son PII → se
    // devuelven completos a cualquiera con el permiso.
    // =========================================================================
    static async listParams(req, res) {
        try {
            const rows = await db.query(`
                SELECT p.id, p.key, p.label, p.value_type, p.value, p.unit, p.description,
                       p.updated_by, p.updated_at,
                       u.username AS updated_by_username
                FROM payroll_parameters p
                LEFT JOIN users u ON u.id = p.updated_by
                ORDER BY p.key
            `);
            const parameters = rows.map(shapeParameter);
            return res.json({ success: true, data: { parameters } });
        } catch (err) {
            console.error('listParams:', err);
            return res.status(500).json({ success: false, message: 'Error al listar parámetros de nómina' });
        }
    }

    // =========================================================================
    // PUT /api/hr/payroll/params/:key — edita el value de UN parámetro (auditado).
    // Acceso: hr.payroll.params.write (en la ruta). NO crea keys nuevas (404 si
    // no existe). Valida value contra value_type (percentage 0-100; money/number
    // no negativo y <= 99999999.9999). Fuera de rango → 422 (no modifica nada).
    // =========================================================================
    static async updateParam(req, res) {
        try {
            const { key } = req.params;
            const { value } = req.body || {};

            // La key debe respetar el patrón canónico del contrato (snake_case).
            // Una key malformada es entrada inválida (400), no un 404 de recurso.
            if (typeof key !== 'string' || !PARAM_KEY_PATTERN.test(key)) {
                return res.status(400).json({ success: false, message: 'key inválida (snake_case, a-z 0-9 _)' });
            }

            // value debe venir y ser numérico finito y no negativo.
            const numValue = Number(value);
            if (value === undefined || value === null || !Number.isFinite(numValue)) {
                return res.status(400).json({ success: false, message: 'value es obligatorio y debe ser numérico' });
            }
            if (numValue < 0) {
                return res.status(400).json({ success: false, message: 'value no puede ser negativo' });
            }
            // Tope duro de la columna NUMERIC(12,4) (4 decimales).
            if (numValue > MAX_PARAM_VALUE) {
                return res.status(400).json({ success: false, message: `value excede el máximo permitido (${MAX_PARAM_VALUE})` });
            }

            // El parámetro debe existir (no se autocrea).
            const param = await db.queryOne(
                'SELECT id, key, value_type FROM payroll_parameters WHERE key = ?',
                [key]
            );
            if (!param) {
                return res.status(404).json({ success: false, message: 'Parámetro no encontrado' });
            }

            // Validación de NEGOCIO según value_type → 422 (no modifica nada).
            if (param.value_type === 'percentage' && numValue > MAX_PCT) {
                return res.status(422).json({ success: false, message: 'Un porcentaje no puede ser mayor a 100' });
            }
            // money / number ya quedaron acotados a [0, 99999999.9999] arriba.

            // UPDATE sella la auditoría (updated_by = req.user.id, updated_at = now).
            await db.execute(
                `UPDATE payroll_parameters
                 SET value = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP
                 WHERE key = ?`,
                [numValue, req.user.id, key]
            );

            // Devolvemos el estado NUEVO (incluida la auditoría con el username).
            const updated = await db.queryOne(`
                SELECT p.id, p.key, p.label, p.value_type, p.value, p.unit, p.description,
                       p.updated_by, p.updated_at,
                       u.username AS updated_by_username
                FROM payroll_parameters p
                LEFT JOIN users u ON u.id = p.updated_by
                WHERE p.key = ?
            `, [key]);

            return res.json({
                success: true,
                message: 'Parámetro actualizado',
                data: { parameter: shapeParameter(updated) }
            });
        } catch (err) {
            console.error('updateParam:', err);
            return res.status(500).json({ success: false, message: 'Error al actualizar el parámetro' });
        }
    }

    // =========================================================================
    // POST /api/hr/payroll/runs — genera la corrida de un mes.
    // Acceso: hr.payroll.run (en la ruta). Idempotencia: una corrida por
    // (period_month, period_year) → re-POST devuelve 409.
    // Inmutabilidad: congela el snapshot de % + SBU + banderas en cada renglón.
    // Atomicidad: run + N details se insertan en una transacción.
    // =========================================================================
    static async generateRun(req, res) {
        try {
            const { period_month, period_year, employee_ids, notes } = req.body || {};

            // ---- Validación de entrada (tipos / rangos) ----
            const month = Number(period_month);
            const year = Number(period_year);
            if (!Number.isInteger(month) || month < 1 || month > 12) {
                return res.status(400).json({ success: false, message: 'period_month debe ser un entero entre 1 y 12' });
            }
            if (!Number.isInteger(year) || year < MIN_YEAR || year > MAX_YEAR) {
                return res.status(400).json({ success: false, message: `period_year debe ser un entero entre ${MIN_YEAR} y ${MAX_YEAR}` });
            }
            if (notes !== undefined && notes !== null && (typeof notes !== 'string' || notes.length > 500)) {
                return res.status(400).json({ success: false, message: 'notes debe ser texto de hasta 500 caracteres' });
            }

            // employee_ids: opcional; si viene debe ser array de enteros > 0, sin
            // duplicados y hasta MAX_EMPLOYEE_IDS.
            let requestedIds = null;
            if (employee_ids !== undefined && employee_ids !== null) {
                if (!Array.isArray(employee_ids)) {
                    return res.status(400).json({ success: false, message: 'employee_ids debe ser un array' });
                }
                if (employee_ids.length > MAX_EMPLOYEE_IDS) {
                    return res.status(400).json({ success: false, message: `employee_ids no puede tener más de ${MAX_EMPLOYEE_IDS} elementos` });
                }
                const cleaned = [];
                const seen = new Set();
                for (const raw of employee_ids) {
                    const id = Number(raw);
                    if (!Number.isInteger(id) || id <= 0) {
                        return res.status(400).json({ success: false, message: 'Cada employee_id debe ser un entero positivo' });
                    }
                    if (seen.has(id)) {
                        return res.status(400).json({ success: false, message: 'employee_ids no puede tener duplicados' });
                    }
                    seen.add(id);
                    cleaned.push(id);
                }
                requestedIds = cleaned.length > 0 ? cleaned : null; // array vacío == "todos"
            }

            // ---- Idempotencia: ¿ya existe corrida para ese período? → 409 ----
            const existing = await db.queryOne(
                'SELECT id FROM payroll_runs WHERE period_month = ? AND period_year = ?',
                [month, year]
            );
            if (existing) {
                return res.status(409).json({
                    success: false,
                    message: `Ya existe una corrida para ${month}/${year}. Re-generar no está permitido (rol inmutable).`
                });
            }

            // ---- Resolver empleados ----
            // Con employee_ids: cada uno debe existir (si falta alguno → 404) y se
            // permite cualquier status (RRHH puede querer el rol de alguien on_leave,
            // §6.10). Sin employee_ids: todos los status='active'.
            let employees;
            if (requestedIds) {
                const placeholders = requestedIds.map(() => '?').join(',');
                employees = await db.query(
                    `SELECT id, full_name, hire_date, base_salary, status,
                            mensualiza_decimos, paga_fondos_mensual
                     FROM hr_employees
                     WHERE id IN (${placeholders})`,
                    requestedIds
                );
                if (employees.length !== requestedIds.length) {
                    const found = new Set(employees.map(e => e.id));
                    const missing = requestedIds.find(id => !found.has(id));
                    return res.status(404).json({ success: false, message: `El empleado ${missing} no existe` });
                }
            } else {
                employees = await db.query(
                    `SELECT id, full_name, hire_date, base_salary, status,
                            mensualiza_decimos, paga_fondos_mensual
                     FROM hr_employees
                     WHERE status = 'active'
                     ORDER BY full_name`
                );
                if (employees.length === 0) {
                    return res.status(422).json({ success: false, message: 'No hay empleados activos para generar la corrida' });
                }
            }

            // ---- Leer parámetros vigentes UNA vez (se congelan en cada renglón) ----
            const params = await leerParametrosVigentes();

            // ---- Calcular todos los renglones (en memoria) + validar rangos ----
            const rows = [];
            const totals = { ingresos: 0, descuentos: 0, neto: 0, costo: 0 };
            for (const emp of employees) {
                const row = calcularRenglonEmpleado(emp, params, month, year);

                // Rango §5: si algún monto por-renglón excede NUMERIC(12,2),
                // abortamos con 422 y NO persistimos nada (no dejar 500 en Postgres).
                const montos = [
                    row.sueldo_base, row.fondos_reserva, row.decimo_tercero, row.decimo_cuarto,
                    row.horas_extra, row.otros_ingresos, row.total_ingresos,
                    row.base_aportable, row.aporte_personal, row.otros_descuentos, row.total_descuentos,
                    row.neto_a_pagar, row.aporte_patronal, row.provisiones, row.costo_empresa
                ];
                if (montos.some(excedeRangoRenglon)) {
                    return res.status(422).json({
                        success: false,
                        message: `El empleado ${emp.id} produce un monto fuera del rango permitido (revisá su sueldo base)`
                    });
                }

                rows.push(row);
                totals.ingresos = round2(totals.ingresos + row.total_ingresos);
                totals.descuentos = round2(totals.descuentos + row.total_descuentos);
                totals.neto = round2(totals.neto + row.neto_a_pagar);
                totals.costo = round2(totals.costo + row.costo_empresa);
            }

            // Rango de totales agregados §5 → si excede NUMERIC(14,2), 422.
            const totalsArr = [totals.ingresos, totals.descuentos, totals.neto, totals.costo];
            if (totalsArr.some(t => t < 0 || t > MAX_TOTAL_AMOUNT)) {
                return res.status(422).json({ success: false, message: 'Los totales de la corrida exceden el rango permitido' });
            }

            const notesValue = (typeof notes === 'string' && notes.length > 0) ? notes : null;

            // ---- Persistir run + details ATÓMICAMENTE ----
            // Insertamos la cabecera (para tener run_id), luego cada renglón con
            // ese run_id. Si algo falla, rollback total (no queda media corrida).
            const runId = await db.transaction(async (tx) => {
                const runInsert = await tx.execute(
                    `INSERT INTO payroll_runs
                     (period_month, period_year, status, sbu_snapshot,
                      total_ingresos, total_descuentos, total_neto, total_costo_empresa,
                      notes, generated_by)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [month, year, RUN_STATUS_DRAFT, params.sbu,
                     totals.ingresos, totals.descuentos, totals.neto, totals.costo,
                     notesValue, req.user.id]
                );
                const newRunId = runInsert.lastInsertId;

                const placeholders = DETAIL_INSERT_COLUMNS.map(() => '?').join(', ');
                const insertDetailSql =
                    `INSERT INTO payroll_details (${DETAIL_INSERT_COLUMNS.join(', ')}) VALUES (${placeholders})`;
                for (const row of rows) {
                    await tx.execute(insertDetailSql, [
                        newRunId, row.employee_id,
                        row.sueldo_base, row.fondos_reserva, row.decimo_tercero, row.decimo_cuarto,
                        row.horas_extra, row.otros_ingresos, row.total_ingresos,
                        row.base_aportable, row.aporte_personal, row.otros_descuentos, row.total_descuentos,
                        row.neto_a_pagar, row.aporte_patronal, row.provisiones, row.costo_empresa,
                        row.iess_personal_pct_snapshot, row.iess_patronal_pct_snapshot,
                        row.fondos_reserva_pct_snapshot, row.sbu_snapshot,
                        row.mensualiza_decimos_snapshot, row.paga_fondos_mensual_snapshot,
                        JSON.stringify(row.warnings)
                    ]);
                }
                return newRunId;
            });

            // ---- Responder 201 con la proyección según PII (read.all) ----
            return await PayrollController.respondRunWithDetails(req, res, runId, 201, 'Corrida generada');
        } catch (err) {
            // Carrera de idempotencia: si dos POST del mismo período pasan el
            // pre-check y uno gana el INSERT, el otro viola UNIQUE(period_month,
            // period_year). Lo traducimos a 409 (no 500), coherente con el resto
            // del contrato (mensaje genérico; no filtramos err.message al cliente).
            const msg = (err && err.message) ? err.message : '';
            if (/unique|duplicate key|payroll_runs_period_month/i.test(msg)) {
                return res.status(409).json({
                    success: false,
                    message: 'Ya existe una corrida para ese período (rol inmutable).'
                });
            }
            console.error('generateRun:', err);
            return res.status(500).json({ success: false, message: 'Error al generar la corrida' });
        }
    }

    // =========================================================================
    // GET /api/hr/payroll/runs — lista corridas (sólo cabecera). Filtros opcionales
    // year/month/status. PII: los total_* de cada run sólo si read.all/admin.
    // =========================================================================
    static async listRuns(req, res) {
        try {
            const ctx = await getUserContext(req.user.id, req);
            const includeTotals = canSeeAllPayroll(ctx);

            const conditions = [];
            const queryParams = [];

            if (req.query.period_year !== undefined) {
                const y = Number(req.query.period_year);
                if (!Number.isInteger(y) || y < MIN_YEAR || y > MAX_YEAR) {
                    return res.status(400).json({ success: false, message: 'period_year inválido' });
                }
                conditions.push('r.period_year = ?');
                queryParams.push(y);
            }
            if (req.query.period_month !== undefined) {
                const m = Number(req.query.period_month);
                if (!Number.isInteger(m) || m < 1 || m > 12) {
                    return res.status(400).json({ success: false, message: 'period_month inválido' });
                }
                conditions.push('r.period_month = ?');
                queryParams.push(m);
            }
            if (req.query.status !== undefined) {
                if (![RUN_STATUS_DRAFT, RUN_STATUS_FINALIZED].includes(req.query.status)) {
                    return res.status(400).json({ success: false, message: 'status inválido' });
                }
                conditions.push('r.status = ?');
                queryParams.push(req.query.status);
            }
            const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

            // employee_count se calcula con subconsulta (sin traer los renglones).
            const runRows = await db.query(`
                SELECT r.*,
                       u.username AS generated_by_username,
                       (SELECT COUNT(*) FROM payroll_details d WHERE d.run_id = r.id) AS employee_count
                FROM payroll_runs r
                LEFT JOIN users u ON u.id = r.generated_by
                ${where}
                ORDER BY r.period_year DESC, r.period_month DESC, r.id DESC
            `, queryParams);

            const runs = runRows.map(row => shapeRun(row, includeTotals));
            return res.json({ success: true, data: { runs, total: runs.length } });
        } catch (err) {
            console.error('listRuns:', err);
            return res.status(500).json({ success: false, message: 'Error al listar corridas' });
        }
    }

    // =========================================================================
    // GET /api/hr/payroll/runs/:id — corrida + detalle. Doble control de PII
    // gobernado por hr.payroll.read.all: totales del header Y filtrado de details.
    // =========================================================================
    static async getRun(req, res) {
        try {
            const runId = Number(req.params.id);
            if (!Number.isInteger(runId) || runId <= 0) {
                return res.status(400).json({ success: false, message: 'ID de corrida inválido' });
            }
            return await PayrollController.respondRunWithDetails(req, res, runId, 200);
        } catch (err) {
            console.error('getRun:', err);
            return res.status(500).json({ success: false, message: 'Error al obtener la corrida' });
        }
    }

    // =========================================================================
    // POST /api/hr/payroll/runs/:id/finalize — draft → finalized (sella el rol).
    // Acceso: hr.payroll.run (en la ruta). Re-finalize sobre una corrida que ya
    // no está en 'draft' → 409 (transición inválida). El UPDATE filtra por
    // status='draft' en el WHERE (defensa de concurrencia).
    // =========================================================================
    static async finalizeRun(req, res) {
        try {
            const runId = Number(req.params.id);
            if (!Number.isInteger(runId) || runId <= 0) {
                return res.status(400).json({ success: false, message: 'ID de corrida inválido' });
            }

            const run = await db.queryOne('SELECT id, status FROM payroll_runs WHERE id = ?', [runId]);
            if (!run) {
                return res.status(404).json({ success: false, message: 'Corrida no encontrada' });
            }
            if (run.status !== RUN_STATUS_DRAFT) {
                return res.status(409).json({ success: false, message: `La corrida ya está '${run.status}' y no puede finalizarse de nuevo` });
            }

            // UPDATE condicionado a status='draft': si dos requests compiten, sólo
            // una cambia la fila; la otra obtiene changes=0 → la tratamos como 409.
            const result = await db.execute(
                `UPDATE payroll_runs
                 SET status = ?, finalized_by = ?, finalized_at = CURRENT_TIMESTAMP
                 WHERE id = ? AND status = ?`,
                [RUN_STATUS_FINALIZED, req.user.id, runId, RUN_STATUS_DRAFT]
            );
            if (!result.changes) {
                return res.status(409).json({ success: false, message: 'La corrida ya fue finalizada por otra operación' });
            }

            // Responder sólo la cabecera (proyección de total_* según read.all).
            const ctx = await getUserContext(req.user.id, req);
            const includeTotals = canSeeAllPayroll(ctx);
            const finalized = await db.queryOne(`
                SELECT r.*,
                       u.username AS generated_by_username,
                       (SELECT COUNT(*) FROM payroll_details d WHERE d.run_id = r.id) AS employee_count
                FROM payroll_runs r
                LEFT JOIN users u ON u.id = r.generated_by
                WHERE r.id = ?
            `, [runId]);

            return res.json({
                success: true,
                message: 'Corrida finalizada',
                data: { run: shapeRun(finalized, includeTotals) }
            });
        } catch (err) {
            console.error('finalizeRun:', err);
            return res.status(500).json({ success: false, message: 'Error al finalizar la corrida' });
        }
    }

    // =========================================================================
    // GET /api/hr/payroll/runs/:id/employee/:employeeId/pdf — recibo en PDF.
    // Acceso: hr.payroll.read (en la ruta). Scope IDOR: si el solicitante NO tiene
    // hr.payroll.read.all y el employeeId no está en su getVisibleEmployeeIds →
    // 404 (no se filtra existencia). El PDF lee del snapshot (payroll_details),
    // nunca de payroll_parameters. NUNCA incluye los total_* del run.
    // =========================================================================
    static async employeePdf(req, res) {
        try {
            const runId = Number(req.params.id);
            const employeeId = Number(req.params.employeeId);
            if (!Number.isInteger(runId) || runId <= 0 || !Number.isInteger(employeeId) || employeeId <= 0) {
                return res.status(400).json({ success: false, message: 'IDs inválidos' });
            }

            const run = await db.queryOne('SELECT * FROM payroll_runs WHERE id = ?', [runId]);
            if (!run) {
                return res.status(404).json({ success: false, message: 'Corrida no encontrada' });
            }

            // Scope: quien no ve toda la nómina sólo accede a empleados visibles.
            const ctx = await getUserContext(req.user.id, req);
            if (!canSeeAllPayroll(ctx)) {
                let visibleIds = await getVisibleEmployeeIds(req.user.id);
                // Defensa de PII §0: tener hr.read.all NO habilita ver el rol de otro;
                // sin hr.payroll.read.all restringimos al empleado PROPIO (aunque el
                // scope general devuelva null por un override RBAC inusual).
                if (visibleIds === null) {
                    const me = await db.queryOne('SELECT id FROM hr_employees WHERE user_id = ?', [req.user.id]);
                    visibleIds = me ? [me.id] : [];
                }
                if (!visibleIds.includes(employeeId)) {
                    // 404 (no 403) para no filtrar existencia del empleado/renglón.
                    return res.status(404).json({ success: false, message: 'Rol de pago no encontrado' });
                }
            }

            const detailRow = await db.queryOne(`${DETAIL_SELECT} WHERE d.run_id = ? AND d.employee_id = ?`, [runId, employeeId]);
            if (!detailRow) {
                return res.status(404).json({ success: false, message: 'Rol de pago no encontrado' });
            }

            const detail = shapeDetail(detailRow);
            const { buildRolPagoPDF } = require('./payroll-pdf');
            const doc = buildRolPagoPDF(detail, shapeRun(run, false), {
                employee_name: detailRow.employee_name || null,
                generated_at: new Date().toISOString()
            });
            const fileLabel = `rol-pago-${run.period_year}-${String(run.period_month).padStart(2, '0')}-emp${employeeId}`;
            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Disposition', `attachment; filename="${fileLabel}.pdf"`);
            doc.pipe(res);
            doc.end();
        } catch (err) {
            console.error('employeePdf:', err);
            // Si el PDF ya empezó a streamear (headers enviados), no se puede mandar
            // JSON: cerramos la respuesta para no tirar ERR_HTTP_HEADERS_SENT.
            if (res.headersSent) { return res.end(); }
            return res.status(500).json({ success: false, message: 'Error al generar el PDF del rol de pago' });
        }
    }

    // =========================================================================
    // Helper interno: responde { run, details } aplicando la regla de PII.
    // Lo usan POST /runs (201) y GET /runs/:id (200) para no duplicar la lógica
    // de proyección. statusCode y message son del caller.
    // =========================================================================
    static async respondRunWithDetails(req, res, runId, statusCode, message) {
        const runRow = await db.queryOne(`
            SELECT r.*,
                   u.username AS generated_by_username,
                   (SELECT COUNT(*) FROM payroll_details d WHERE d.run_id = r.id) AS employee_count
            FROM payroll_runs r
            LEFT JOIN users u ON u.id = r.generated_by
            WHERE r.id = ?
        `, [runId]);
        if (!runRow) {
            return res.status(404).json({ success: false, message: 'Corrida no encontrada' });
        }

        const ctx = await getUserContext(req.user.id, req);
        const seeAll = canSeeAllPayroll(ctx);

        // Details: todos si ve todo; si no, sólo los renglones propios del solicitante.
        let detailRows;
        if (seeAll) {
            detailRows = await db.query(`${DETAIL_SELECT} WHERE d.run_id = ? ORDER BY e.full_name`, [runId]);
        } else {
            let visibleIds = await getVisibleEmployeeIds(req.user.id);
            // Defensa de PII §0: tener hr.read.all (que hace null al scope general de
            // RRHH) NO habilita ver nómina ajena. Sin hr.payroll.read.all, restringimos
            // al renglón PROPIO. Así, aunque admin otorgue un override RBAC inusual
            // (hr.read.all sin hr.payroll.read.all), nunca se filtran salarios de otros.
            if (visibleIds === null) {
                const me = await db.queryOne('SELECT id FROM hr_employees WHERE user_id = ?', [req.user.id]);
                visibleIds = me ? [me.id] : [];
            }
            if (visibleIds.length === 0) {
                detailRows = [];
            } else {
                const placeholders = visibleIds.map(() => '?').join(',');
                detailRows = await db.query(
                    `${DETAIL_SELECT} WHERE d.run_id = ? AND d.employee_id IN (${placeholders}) ORDER BY e.full_name`,
                    [runId, ...visibleIds]
                );
            }
        }

        const payload = {
            success: true,
            data: {
                run: shapeRun(runRow, seeAll),       // total_* sólo si seeAll
                details: detailRows.map(shapeDetail)
            }
        };
        if (message) payload.message = message;
        return res.status(statusCode).json(payload);
    }
}

module.exports = PayrollController;
