/**
 * Motor de cálculo Landed Cost — v2 (refactor PR-finalize-prototype).
 *
 * Cambios vs v1:
 *   - Lookup de tarifa por (carguera + aerolinea + origen + destino + peso)
 *     en lugar de (carguera + destino + fecha SCD2).
 *   - Costos del país de destino (aduana, transporte interno, % impuestos)
 *     viven en tarifas_pais (key por country_code), no por aeropuerto.
 *   - Sin SCD2: las tarifas se editan in-place. Auditoría en tariff_changes_log.
 *   - Endpoints CRUD para los 5 catálogos + permission gating.
 */
const db = require('../config/db');
const { getUserContext } = require('./rbac.controller');

const FACTOR_CONVERSION_KG = 0.056;

// ============================================================
// AUDIT LOG HELPER
// ============================================================
// Cada cambio en tarifas/catálogos deja huella append-only.
// Si el insert al log falla, NO falla la operación principal — solo
// loggeamos y seguimos.
async function audit(table, recordId, action, before, after, userId) {
    try {
        await db.execute(
            `INSERT INTO tariff_changes_log
             (table_name, record_id, action, before_json, after_json, changed_by)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [
                table, recordId, action,
                before ? JSON.stringify(before) : null,
                after  ? JSON.stringify(after)  : null,
                userId
            ]
        );
    } catch (e) {
        console.warn('audit log insert failed (no-fatal):', e.message);
    }
}

function ok(res, data, status = 200) {
    res.status(status).json({ success: true, data });
}
function fail(res, message, status = 400) {
    res.status(status).json({ success: false, message });
}

// ============================================================
// CATÁLOGOS — listings (lectura amplia, requiere cotizador.use)
// ============================================================

exports.listAirports = async (req, res) => {
    try {
        const rows = await db.query(
            `SELECT id, iata_code, name, city, country, country_code, is_active
             FROM airports
             WHERE is_active = 1
             ORDER BY country, city`
        );
        ok(res, rows);
    } catch (e) {
        console.error('listAirports:', e);
        fail(res, 'Error al listar aeropuertos', 500);
    }
};

exports.listAerolineas = async (req, res) => {
    try {
        const rows = await db.query(
            `SELECT id, nombre, codigo_iata, codigo_pais, is_active
             FROM aerolineas
             WHERE is_active = 1
             ORDER BY nombre`
        );
        ok(res, rows);
    } catch (e) {
        console.error('listAerolineas:', e);
        fail(res, 'Error al listar aerolíneas', 500);
    }
};

exports.listCargueras = async (req, res) => {
    try {
        const rows = await db.query(
            `SELECT id, nombre, pais, email, contacto, is_active
             FROM cargueras
             WHERE is_active = 1
             ORDER BY nombre`
        );
        ok(res, rows);
    } catch (e) {
        console.error('listCargueras:', e);
        fail(res, 'Error al listar cargueras', 500);
    }
};

exports.listTarifas = async (req, res) => {
    try {
        const rows = await db.query(`
            SELECT t.*,
                   c.nombre AS carguera_nombre, c.pais AS carguera_pais,
                   a.nombre AS aerolinea_nombre, a.codigo_iata AS aerolinea_iata,
                   o.iata_code AS origen_iata, o.city AS origen_city, o.country AS origen_country,
                   d.iata_code AS destino_iata, d.city AS destino_city, d.country AS destino_country
            FROM tarifas_carguera t
            JOIN cargueras  c ON c.id = t.carguera_id
            JOIN aerolineas a ON a.id = t.aerolinea_id
            JOIN airports   o ON o.id = t.origen_airport_id
            JOIN airports   d ON d.id = t.destino_airport_id
            WHERE t.is_active = 1
            ORDER BY c.nombre, a.nombre, o.iata_code, d.iata_code, t.peso_minimo
        `);
        ok(res, rows);
    } catch (e) {
        console.error('listTarifas:', e);
        fail(res, 'Error al listar tarifas', 500);
    }
};

exports.listTarifasPais = async (req, res) => {
    try {
        const rows = await db.query(
            `SELECT id, country_code, country_name, aduana_fija, transporte_interno_caja,
                    porcentaje_arancel, porcentaje_impuesto_consumo, rubros_dinamicos,
                    notas, updated_by, updated_at
             FROM tarifas_pais
             ORDER BY country_name`
        );
        const items = rows.map(r => ({
            ...r,
            rubros_dinamicos: typeof r.rubros_dinamicos === 'string'
                ? JSON.parse(r.rubros_dinamicos || '[]')
                : (r.rubros_dinamicos || [])
        }));
        ok(res, items);
    } catch (e) {
        console.error('listTarifasPais:', e);
        fail(res, 'Error al listar costos por país', 500);
    }
};

// ============================================================
// CRUD AIRPORTS
// ============================================================
exports.createAirport = async (req, res) => {
    try {
        const { iata_code, name, city, country, country_code } = req.body;
        if (!iata_code || !name || !city || !country || !country_code) {
            return fail(res, 'iata_code, name, city, country y country_code son requeridos');
        }
        const r = await db.execute(
            `INSERT INTO airports (iata_code, name, city, country, country_code)
             VALUES (?, ?, ?, ?, ?)`,
            [iata_code.toUpperCase(), name, city, country, country_code.toUpperCase()]
        );
        const row = await db.queryOne('SELECT * FROM airports WHERE id = ?', [r.lastInsertId]);
        await audit('airports', r.lastInsertId, 'CREATE', null, row, req.user.id);
        ok(res, row, 201);
    } catch (e) {
        if (/UNIQUE|duplicate/i.test(e.message)) return fail(res, 'Ya existe un aeropuerto con ese IATA', 409);
        console.error('createAirport:', e);
        fail(res, 'Error al crear aeropuerto', 500);
    }
};
exports.updateAirport = async (req, res) => {
    try {
        const { id } = req.params;
        const before = await db.queryOne('SELECT * FROM airports WHERE id = ?', [id]);
        if (!before) return fail(res, 'Aeropuerto no encontrado', 404);
        const { name, city, country, country_code, is_active } = req.body;
        const updates = [], values = [];
        if (name !== undefined)         { updates.push('name = ?');         values.push(name); }
        if (city !== undefined)         { updates.push('city = ?');         values.push(city); }
        if (country !== undefined)      { updates.push('country = ?');      values.push(country); }
        if (country_code !== undefined) { updates.push('country_code = ?'); values.push(country_code.toUpperCase()); }
        if (is_active !== undefined)    { updates.push('is_active = ?');    values.push(is_active ? 1 : 0); }
        if (updates.length === 0) return fail(res, 'Sin cambios');
        values.push(id);
        await db.execute(`UPDATE airports SET ${updates.join(', ')} WHERE id = ?`, values);
        const after = await db.queryOne('SELECT * FROM airports WHERE id = ?', [id]);
        await audit('airports', id, 'UPDATE', before, after, req.user.id);
        ok(res, after);
    } catch (e) {
        console.error('updateAirport:', e);
        fail(res, 'Error al actualizar aeropuerto', 500);
    }
};
exports.deleteAirport = async (req, res) => {
    try {
        const { id } = req.params;
        const before = await db.queryOne('SELECT * FROM airports WHERE id = ?', [id]);
        if (!before) return fail(res, 'Aeropuerto no encontrado', 404);
        // Soft-delete: marca inactivo (las tarifas que lo referencian no se rompen).
        await db.execute('UPDATE airports SET is_active = 0 WHERE id = ?', [id]);
        await audit('airports', id, 'DELETE', before, null, req.user.id);
        ok(res, { archived: true });
    } catch (e) {
        console.error('deleteAirport:', e);
        fail(res, 'Error al eliminar aeropuerto', 500);
    }
};

// ============================================================
// CRUD AEROLINEAS
// ============================================================
exports.createAerolinea = async (req, res) => {
    try {
        const { nombre, codigo_iata, codigo_pais } = req.body;
        if (!nombre) return fail(res, 'nombre es requerido');
        const r = await db.execute(
            'INSERT INTO aerolineas (nombre, codigo_iata, codigo_pais) VALUES (?, ?, ?)',
            [nombre, codigo_iata ? codigo_iata.toUpperCase() : null, codigo_pais ? codigo_pais.toUpperCase() : null]
        );
        const row = await db.queryOne('SELECT * FROM aerolineas WHERE id = ?', [r.lastInsertId]);
        await audit('aerolineas', r.lastInsertId, 'CREATE', null, row, req.user.id);
        ok(res, row, 201);
    } catch (e) {
        if (/UNIQUE|duplicate/i.test(e.message)) return fail(res, 'Ya existe una aerolínea con ese código IATA', 409);
        console.error('createAerolinea:', e);
        fail(res, 'Error al crear aerolínea', 500);
    }
};
exports.updateAerolinea = async (req, res) => {
    try {
        const { id } = req.params;
        const before = await db.queryOne('SELECT * FROM aerolineas WHERE id = ?', [id]);
        if (!before) return fail(res, 'Aerolínea no encontrada', 404);
        const { nombre, codigo_iata, codigo_pais, is_active } = req.body;
        const updates = [], values = [];
        if (nombre !== undefined)      { updates.push('nombre = ?');      values.push(nombre); }
        if (codigo_iata !== undefined) { updates.push('codigo_iata = ?'); values.push(codigo_iata ? codigo_iata.toUpperCase() : null); }
        if (codigo_pais !== undefined) { updates.push('codigo_pais = ?'); values.push(codigo_pais ? codigo_pais.toUpperCase() : null); }
        if (is_active !== undefined)   { updates.push('is_active = ?');   values.push(is_active ? 1 : 0); }
        if (updates.length === 0) return fail(res, 'Sin cambios');
        values.push(id);
        await db.execute(`UPDATE aerolineas SET ${updates.join(', ')} WHERE id = ?`, values);
        const after = await db.queryOne('SELECT * FROM aerolineas WHERE id = ?', [id]);
        await audit('aerolineas', id, 'UPDATE', before, after, req.user.id);
        ok(res, after);
    } catch (e) {
        console.error('updateAerolinea:', e);
        fail(res, 'Error al actualizar aerolínea', 500);
    }
};
exports.deleteAerolinea = async (req, res) => {
    try {
        const { id } = req.params;
        const before = await db.queryOne('SELECT * FROM aerolineas WHERE id = ?', [id]);
        if (!before) return fail(res, 'Aerolínea no encontrada', 404);
        await db.execute('UPDATE aerolineas SET is_active = 0 WHERE id = ?', [id]);
        await audit('aerolineas', id, 'DELETE', before, null, req.user.id);
        ok(res, { archived: true });
    } catch (e) {
        console.error('deleteAerolinea:', e);
        fail(res, 'Error al eliminar aerolínea', 500);
    }
};

// ============================================================
// CRUD CARGUERAS
// ============================================================
exports.createCarguera = async (req, res) => {
    try {
        const { nombre, pais, email, contacto } = req.body;
        if (!nombre) return fail(res, 'nombre es requerido');
        const r = await db.execute(
            'INSERT INTO cargueras (nombre, pais, email, contacto) VALUES (?, ?, ?, ?)',
            [nombre, pais || null, email || null, contacto || null]
        );
        const row = await db.queryOne('SELECT * FROM cargueras WHERE id = ?', [r.lastInsertId]);
        await audit('cargueras', r.lastInsertId, 'CREATE', null, row, req.user.id);
        ok(res, row, 201);
    } catch (e) {
        if (/UNIQUE|duplicate/i.test(e.message)) return fail(res, 'Ya existe una carguera con ese nombre', 409);
        console.error('createCarguera:', e);
        fail(res, 'Error al crear carguera', 500);
    }
};
exports.updateCarguera = async (req, res) => {
    try {
        const { id } = req.params;
        const before = await db.queryOne('SELECT * FROM cargueras WHERE id = ?', [id]);
        if (!before) return fail(res, 'Carguera no encontrada', 404);
        const { nombre, pais, email, contacto, is_active } = req.body;
        const updates = [], values = [];
        if (nombre !== undefined)    { updates.push('nombre = ?');    values.push(nombre); }
        if (pais !== undefined)      { updates.push('pais = ?');      values.push(pais); }
        if (email !== undefined)     { updates.push('email = ?');     values.push(email); }
        if (contacto !== undefined)  { updates.push('contacto = ?');  values.push(contacto); }
        if (is_active !== undefined) { updates.push('is_active = ?'); values.push(is_active ? 1 : 0); }
        if (updates.length === 0) return fail(res, 'Sin cambios');
        values.push(id);
        await db.execute(`UPDATE cargueras SET ${updates.join(', ')} WHERE id = ?`, values);
        const after = await db.queryOne('SELECT * FROM cargueras WHERE id = ?', [id]);
        await audit('cargueras', id, 'UPDATE', before, after, req.user.id);
        ok(res, after);
    } catch (e) {
        console.error('updateCarguera:', e);
        fail(res, 'Error al actualizar carguera', 500);
    }
};
exports.deleteCarguera = async (req, res) => {
    try {
        const { id } = req.params;
        const before = await db.queryOne('SELECT * FROM cargueras WHERE id = ?', [id]);
        if (!before) return fail(res, 'Carguera no encontrada', 404);
        await db.execute('UPDATE cargueras SET is_active = 0 WHERE id = ?', [id]);
        await audit('cargueras', id, 'DELETE', before, null, req.user.id);
        ok(res, { archived: true });
    } catch (e) {
        console.error('deleteCarguera:', e);
        fail(res, 'Error al eliminar carguera', 500);
    }
};

// ============================================================
// CRUD TARIFAS DE FLETE (tarifas_carguera)
// ============================================================
exports.createTarifa = async (req, res) => {
    try {
        const {
            carguera_id, aerolinea_id, origen_airport_id, destino_airport_id,
            peso_minimo = 0, peso_maximo = 999999,
            tarifa_kilo, costo_cuarto_frio_kilo = 0, costo_documentacion_fijo = 0,
            tariff_type = 'contract', currency = 'USD',
            validity_from = null, validity_to = null,
            surcharges_json = null, notas = null
        } = req.body;
        if (!carguera_id || !aerolinea_id || !origen_airport_id || !destino_airport_id || tarifa_kilo == null) {
            return fail(res, 'carguera_id, aerolinea_id, origen_airport_id, destino_airport_id y tarifa_kilo son requeridos');
        }
        const r = await db.execute(
            `INSERT INTO tarifas_carguera
             (carguera_id, aerolinea_id, origen_airport_id, destino_airport_id,
              peso_minimo, peso_maximo, tarifa_kilo, costo_cuarto_frio_kilo,
              costo_documentacion_fijo, tariff_type, currency, validity_from,
              validity_to, surcharges_json, notas, updated_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [carguera_id, aerolinea_id, origen_airport_id, destino_airport_id,
             peso_minimo, peso_maximo, tarifa_kilo, costo_cuarto_frio_kilo,
             costo_documentacion_fijo, tariff_type, currency, validity_from,
             validity_to, surcharges_json ? JSON.stringify(surcharges_json) : null,
             notas, req.user.id]
        );
        const row = await db.queryOne('SELECT * FROM tarifas_carguera WHERE id = ?', [r.lastInsertId]);
        await audit('tarifas_carguera', r.lastInsertId, 'CREATE', null, row, req.user.id);
        ok(res, row, 201);
    } catch (e) {
        if (/UNIQUE|duplicate/i.test(e.message)) {
            return fail(res, 'Ya existe una tarifa para esa combinación (carguera + aerolínea + ruta + rango de peso + tipo)', 409);
        }
        console.error('createTarifa:', e);
        fail(res, 'Error al crear tarifa', 500);
    }
};
exports.updateTarifa = async (req, res) => {
    try {
        const { id } = req.params;
        const before = await db.queryOne('SELECT * FROM tarifas_carguera WHERE id = ?', [id]);
        if (!before) return fail(res, 'Tarifa no encontrada', 404);
        const allowed = ['peso_minimo','peso_maximo','tarifa_kilo','costo_cuarto_frio_kilo',
                         'costo_documentacion_fijo','tariff_type','currency',
                         'validity_from','validity_to','notas','is_active'];
        const updates = [], values = [];
        for (const k of allowed) {
            if (req.body[k] !== undefined) {
                updates.push(`${k} = ?`);
                values.push(k === 'is_active' ? (req.body[k] ? 1 : 0) : req.body[k]);
            }
        }
        if (req.body.surcharges_json !== undefined) {
            updates.push('surcharges_json = ?');
            values.push(req.body.surcharges_json ? JSON.stringify(req.body.surcharges_json) : null);
        }
        if (updates.length === 0) return fail(res, 'Sin cambios');
        updates.push('updated_by = ?'); values.push(req.user.id);
        updates.push('updated_at = CURRENT_TIMESTAMP');
        values.push(id);
        await db.execute(`UPDATE tarifas_carguera SET ${updates.join(', ')} WHERE id = ?`, values);
        const after = await db.queryOne('SELECT * FROM tarifas_carguera WHERE id = ?', [id]);
        // No-op detection: si los valores relevantes no cambiaron, no logueamos
        // (cumple "si no cambia, no se cambian esos valores").
        const sameValues = ['tarifa_kilo','costo_cuarto_frio_kilo','costo_documentacion_fijo']
            .every(k => Number(before[k]) === Number(after[k]));
        if (!sameValues) {
            await audit('tarifas_carguera', id, 'UPDATE', before, after, req.user.id);
        }
        ok(res, after);
    } catch (e) {
        console.error('updateTarifa:', e);
        fail(res, 'Error al actualizar tarifa', 500);
    }
};
exports.deleteTarifa = async (req, res) => {
    try {
        const { id } = req.params;
        const before = await db.queryOne('SELECT * FROM tarifas_carguera WHERE id = ?', [id]);
        if (!before) return fail(res, 'Tarifa no encontrada', 404);
        await db.execute('DELETE FROM tarifas_carguera WHERE id = ?', [id]);
        await audit('tarifas_carguera', id, 'DELETE', before, null, req.user.id);
        ok(res, { deleted: true });
    } catch (e) {
        console.error('deleteTarifa:', e);
        fail(res, 'Error al eliminar tarifa', 500);
    }
};

// ============================================================
// CRUD TARIFAS POR PAÍS
// ============================================================
exports.upsertTarifaPais = async (req, res) => {
    try {
        const {
            country_code, country_name, aduana_fija = 0, transporte_interno_caja = 0,
            porcentaje_arancel = 0, porcentaje_impuesto_consumo = 0,
            rubros_dinamicos = [], notas = null
        } = req.body;
        if (!country_code || !country_name) return fail(res, 'country_code y country_name son requeridos');
        const cc = country_code.toUpperCase();
        const before = await db.queryOne('SELECT * FROM tarifas_pais WHERE country_code = ?', [cc]);
        const rubrosStr = JSON.stringify(rubros_dinamicos || []);

        if (before) {
            await db.execute(
                `UPDATE tarifas_pais SET
                   country_name = ?, aduana_fija = ?, transporte_interno_caja = ?,
                   porcentaje_arancel = ?, porcentaje_impuesto_consumo = ?,
                   rubros_dinamicos = ?, notas = ?, updated_by = ?,
                   updated_at = CURRENT_TIMESTAMP
                 WHERE country_code = ?`,
                [country_name, aduana_fija, transporte_interno_caja,
                 porcentaje_arancel, porcentaje_impuesto_consumo,
                 rubrosStr, notas, req.user.id, cc]
            );
            const after = await db.queryOne('SELECT * FROM tarifas_pais WHERE country_code = ?', [cc]);
            const sameValues = ['aduana_fija','transporte_interno_caja','porcentaje_arancel','porcentaje_impuesto_consumo']
                .every(k => Number(before[k]) === Number(after[k]))
                && (before.notas || '') === (after.notas || '');
            if (!sameValues) {
                await audit('tarifas_pais', before.id, 'UPDATE', before, after, req.user.id);
            }
            return ok(res, after);
        }

        const r = await db.execute(
            `INSERT INTO tarifas_pais
             (country_code, country_name, aduana_fija, transporte_interno_caja,
              porcentaje_arancel, porcentaje_impuesto_consumo, rubros_dinamicos,
              notas, updated_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [cc, country_name, aduana_fija, transporte_interno_caja,
             porcentaje_arancel, porcentaje_impuesto_consumo, rubrosStr, notas, req.user.id]
        );
        const row = await db.queryOne('SELECT * FROM tarifas_pais WHERE id = ?', [r.lastInsertId]);
        await audit('tarifas_pais', r.lastInsertId, 'CREATE', null, row, req.user.id);
        ok(res, row, 201);
    } catch (e) {
        console.error('upsertTarifaPais:', e);
        fail(res, 'Error al guardar costo de país', 500);
    }
};

// ============================================================
// AUDIT LOG (lectura)
// ============================================================
exports.listAuditLog = async (req, res) => {
    try {
        const { limit = 100, table, user_id } = req.query;
        const conditions = [];
        const params = [];
        if (table)   { conditions.push('table_name = ?'); params.push(table); }
        if (user_id) { conditions.push('changed_by = ?'); params.push(user_id); }
        const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
        const rows = await db.query(
            `SELECT l.*, u.username, u.full_name AS changed_by_name
             FROM tariff_changes_log l
             LEFT JOIN users u ON u.id = l.changed_by
             ${where}
             ORDER BY l.changed_at DESC
             LIMIT ?`,
            [...params, parseInt(limit, 10)]
        );
        const items = rows.map(r => ({
            ...r,
            before_json: typeof r.before_json === 'string' ? JSON.parse(r.before_json || 'null') : r.before_json,
            after_json:  typeof r.after_json  === 'string' ? JSON.parse(r.after_json  || 'null') : r.after_json
        }));
        ok(res, items);
    } catch (e) {
        console.error('listAuditLog:', e);
        fail(res, 'Error al listar auditoría', 500);
    }
};

// ============================================================
// CÁLCULO LANDED COST · v2
// ============================================================
async function lookupTarifa({ carguera_id, aerolinea_id, origen_airport_id, destino_airport_id, peso, fecha }) {
    return db.queryOne(
        `SELECT *
         FROM tarifas_carguera
         WHERE carguera_id = ?
           AND aerolinea_id = ?
           AND origen_airport_id = ?
           AND destino_airport_id = ?
           AND ? BETWEEN peso_minimo AND peso_maximo
           AND is_active = 1
           AND (validity_from IS NULL OR validity_from <= ?)
           AND (validity_to   IS NULL OR validity_to   >= ?)
         ORDER BY tariff_type = 'spot' DESC, tariff_type = 'promo' DESC
         LIMIT 1`,
        [carguera_id, aerolinea_id, origen_airport_id, destino_airport_id, peso, fecha, fecha]
    );
}

async function lookupTarifaPaisByDestino(destinoAirportId) {
    const dest = await db.queryOne('SELECT country_code FROM airports WHERE id = ?', [destinoAirportId]);
    if (!dest) return null;
    return db.queryOne('SELECT * FROM tarifas_pais WHERE country_code = ?', [dest.country_code]);
}

function round(n, decimals = 2) {
    if (!Number.isFinite(n)) return 0;
    const f = Math.pow(10, decimals);
    return Math.round(n * f) / f;
}

async function computarCotizacion(input) {
    const {
        cantidad_tallos,
        precio_tallo_escenario_1,
        precio_tallo_escenario_2,
        kilos_totales,
        tallos_por_caja,
        carguera_id,
        aerolinea_id,
        origen_airport_id,
        destino_airport_id,
        fecha_proyeccion
    } = input;

    if (!cantidad_tallos || !tallos_por_caja
        || precio_tallo_escenario_1 == null || precio_tallo_escenario_2 == null
        || !carguera_id || !aerolinea_id || !origen_airport_id || !destino_airport_id) {
        const e = new Error('Faltan parámetros: necesita carguera, aerolínea, origen, destino, tallos, tallos por caja y los 2 precios.');
        e.status = 400; throw e;
    }

    const tallos = parseInt(cantidad_tallos, 10);
    const tallosCaja = parseInt(tallos_por_caja, 10);
    const fecha = fecha_proyeccion || new Date().toISOString().split('T')[0];

    const pesoFinalKg = (kilos_totales != null && kilos_totales !== '')
        ? parseFloat(kilos_totales)
        : tallos * FACTOR_CONVERSION_KG;
    const numeroCajas = Math.ceil(tallos / tallosCaja);

    const destAirport = await db.queryOne('SELECT * FROM airports WHERE id = ?', [destino_airport_id]);
    if (!destAirport) { const e = new Error('Aeropuerto destino no encontrado.'); e.status = 404; throw e; }
    const origAirport = await db.queryOne('SELECT * FROM airports WHERE id = ?', [origen_airport_id]);
    if (!origAirport) { const e = new Error('Aeropuerto origen no encontrado.'); e.status = 404; throw e; }

    const tarifa = await lookupTarifa({
        carguera_id, aerolinea_id, origen_airport_id, destino_airport_id,
        peso: pesoFinalKg, fecha
    });
    if (!tarifa) {
        const e = new Error(`No existe tarifa configurada para esa carguera + aerolínea + ruta + peso ${pesoFinalKg.toFixed(2)} kg.`);
        e.status = 404; throw e;
    }

    const tarifaPais = await lookupTarifaPaisByDestino(destino_airport_id);
    if (!tarifaPais) {
        const e = new Error(`No hay costos configurados para el país de destino (${destAirport.country_code}). Configurá los costos en "Configurar tarifas → Costos por país".`);
        e.status = 404; throw e;
    }

    const tarifaFlete = parseFloat(tarifa.tarifa_kilo);
    const costoDocumentacion = parseFloat(tarifa.costo_documentacion_fijo) || 0;
    const costoCuartoFrioKilo = parseFloat(tarifa.costo_cuarto_frio_kilo) || 0;
    const aduanaFija = parseFloat(tarifaPais.aduana_fija) || 0;
    const transporteInternoCaja = parseFloat(tarifaPais.transporte_interno_caja) || 0;
    const porcentajeArancel = parseFloat(tarifaPais.porcentaje_arancel) || 0;
    const porcentajeImpuesto = parseFloat(tarifaPais.porcentaje_impuesto_consumo) || 0;

    // PR-2e: rubros dinámicos. Los rubros 'fijo' suman una vez, 'caja' x numeroCajas,
    // 'porc' suman al porcentaje aplicado al subtotal.
    let rubros = tarifaPais.rubros_dinamicos || [];
    if (typeof rubros === 'string') { try { rubros = JSON.parse(rubros); } catch { rubros = []; } }
    if (!Array.isArray(rubros)) rubros = [];
    const rubrosFijos = rubros.filter(r => r.tipo === 'fijo').reduce((s, r) => s + (Number(r.monto) || 0), 0);
    const rubrosCaja  = rubros.filter(r => r.tipo === 'caja').reduce((s, r) => s + (Number(r.monto) || 0), 0);
    const rubrosPorc  = rubros.filter(r => r.tipo === 'porc').reduce((s, r) => s + (Number(r.monto) || 0), 0) / 100;

    const totalFijos = costoDocumentacion + aduanaFija + rubrosFijos;
    const incidenciaFijosPorTallo = totalFijos / tallos;
    const costoCuartoFrioTotal = pesoFinalKg * costoCuartoFrioKilo;
    const costoFleteTotal = pesoFinalKg * tarifaFlete;
    const costoFletePorTallo = costoFleteTotal / tallos;
    const costoTransporteTotal = numeroCajas * (transporteInternoCaja + rubrosCaja);
    const costoTransportePorTallo = costoTransporteTotal / tallos;

    const calcularEscenario = (precioFob) => {
        const precio = parseFloat(precioFob);
        const fobTotal = tallos * precio;
        const subtotal = fobTotal + costoFleteTotal + totalFijos
                       + costoTransporteTotal + costoCuartoFrioTotal;
        const impuestos = subtotal * (porcentajeArancel + porcentajeImpuesto + rubrosPorc);
        const granTotal = subtotal + impuestos;
        const landedCostPorTallo = granTotal / tallos;
        return {
            precio_fob_tallo: precio,
            fob_total: round(fobTotal),
            incidencia_fijos_por_tallo: round(incidenciaFijosPorTallo, 4),
            flete_por_tallo: round(costoFletePorTallo, 4),
            transporte_interno_por_tallo: round(costoTransportePorTallo, 4),
            landed_cost_por_tallo: round(landedCostPorTallo, 4),
            desglose_totales: {
                fob_total: round(fobTotal),
                costo_flete: round(costoFleteTotal),
                costos_fijos: round(totalFijos),
                transporte_interno: round(costoTransporteTotal),
                cuarto_frio: round(costoCuartoFrioTotal),
                rubros_dinamicos: rubros.length > 0 ? rubros : undefined,
                impuestos: round(impuestos),
                gran_total: round(granTotal)
            }
        };
    };

    return {
        metadata: {
            fecha_proyeccion: fecha,
            cantidad_tallos: tallos,
            tallos_por_caja: tallosCaja,
            kilos_calculados: round(pesoFinalKg, 2),
            factor_conversion_usado: kilos_totales ? 'Usuario (ingresado)' : `Sistema (${FACTOR_CONVERSION_KG} kg/tallo)`,
            numero_cajas: numeroCajas,
            origen:  { id: origAirport.id,  iata: origAirport.iata_code,  ciudad: origAirport.city,  pais: origAirport.country },
            destino: { id: destAirport.id,  iata: destAirport.iata_code,  ciudad: destAirport.city,  pais: destAirport.country },
            carguera_id: parseInt(carguera_id, 10),
            aerolinea_id: parseInt(aerolinea_id, 10),
            tariff_type: tarifa.tariff_type,
            currency: tarifa.currency,
            tarifa_flete_aplicada: tarifaFlete,
            tarifa_carguera_id: tarifa.id,
            tarifa_pais_id: tarifaPais.id
        },
        escenarios: {
            escenario_1: calcularEscenario(precio_tallo_escenario_1),
            escenario_2: calcularEscenario(precio_tallo_escenario_2)
        }
    };
}

exports.calcular = async (req, res) => {
    try {
        const result = await computarCotizacion(req.body);
        ok(res, result);
    } catch (e) {
        const status = e.status || 500;
        if (status >= 500) console.error('Error calcular:', e);
        fail(res, e.message || 'Error interno del motor de cálculo', status);
    }
};

// PR-5c: genera el PDF de una cotización en línea (sin guardar). Reusa el
// motor de cálculo y luego lo serializa via pdfkit.
exports.cotizarPdf = async (req, res) => {
    try {
        const result = await computarCotizacion(req.body);
        const { buildCotizacionPDF } = require('./cotizador-pdf');
        const doc = buildCotizacionPDF(result, {
            user_full_name: req.user && req.user.full_name ? req.user.full_name : null,
            generated_at: new Date().toISOString()
        });
        const ruta = `${result.metadata.origen.iata}-${result.metadata.destino.iata}`;
        const fecha = new Date().toISOString().substring(0, 10);
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition',
            `attachment; filename="cotizacion-${ruta}-${fecha}.pdf"`);
        doc.pipe(res);
        doc.end();
    } catch (e) {
        const status = e.status || 500;
        if (status >= 500) console.error('Error cotizarPdf:', e);
        fail(res, e.message || 'Error al generar PDF', status);
    }
};

exports.guardarCotizacion = async (req, res) => {
    try {
        const result = await computarCotizacion(req.body);
        const userId = req.user ? req.user.id : null;
        const fecha = result.metadata.fecha_proyeccion;
        const r = await db.execute(
            `INSERT INTO cotizaciones_historico (user_id, fecha_proyeccion, snapshot)
             VALUES (?, ?, ?)`,
            [userId, fecha, JSON.stringify(result)]
        );
        ok(res, { id: r.lastInsertId, ...result }, 201);
    } catch (e) {
        const status = e.status || 500;
        if (status >= 500) console.error('Error guardarCotizacion:', e);
        fail(res, e.message || 'Error al guardar cotización', status);
    }
};

exports.listarCotizaciones = async (req, res) => {
    try {
        const ctx = await getUserContext(req.user.id, req);
        const userId = req.user.id;
        const { limit = 50 } = req.query;
        const isAdmin = ctx.isAdmin;

        let rows;
        if (isAdmin) {
            rows = await db.query(
                `SELECT c.id, c.user_id, u.username, c.fecha_proyeccion, c.snapshot, c.created_at
                 FROM cotizaciones_historico c
                 LEFT JOIN users u ON c.user_id = u.id
                 ORDER BY c.created_at DESC
                 LIMIT ?`,
                [parseInt(limit, 10)]
            );
        } else {
            rows = await db.query(
                `SELECT c.id, c.user_id, ? as username, c.fecha_proyeccion, c.snapshot, c.created_at
                 FROM cotizaciones_historico c
                 WHERE c.user_id = ?
                 ORDER BY c.created_at DESC
                 LIMIT ?`,
                [req.user.username, userId, parseInt(limit, 10)]
            );
        }
        const items = rows.map(r => ({
            ...r,
            snapshot: typeof r.snapshot === 'string' ? JSON.parse(r.snapshot) : r.snapshot
        }));
        ok(res, items);
    } catch (e) {
        console.error('Error listando cotizaciones:', e);
        fail(res, 'Error al listar cotizaciones', 500);
    }
};
