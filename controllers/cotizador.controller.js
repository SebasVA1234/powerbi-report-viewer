/**
 * Motor de cálculo Landed Cost — integrado al Portal Ecualand.
 *
 * Lee las tarifas de la BD usando lookup SCD Tipo 2 (vigencia por fecha de proyección).
 * Funciona en SQLite y PostgreSQL gracias a la capa de abstracción config/db.
 *
 * Reglas de negocio (resumen):
 *   - Factor de conversión: 1 tallo = 0.056 kg (si no se da peso)
 *   - Cajas: ceil(tallos / tallos_por_caja)
 *   - Tarifa flete: lookup por carguera + destino + rango de peso + fecha vigente
 *   - Costos fijos (documentación + aduana) se diluyen entre todos los tallos
 *   - Transporte interno: por caja
 *   - Se calculan 2 escenarios de precio en paralelo
 */
const db = require('../config/db');

const FACTOR_CONVERSION_KG = 0.056;

/**
 * Lista destinos activos para el dropdown.
 */
exports.listDestinos = async (req, res) => {
    try {
        const rows = await db.query(
            `SELECT id, codigo_iata, nombre, pais,
                    porcentaje_arancel, porcentaje_impuesto_consumo
             FROM destinos
             WHERE is_active = 1
             ORDER BY nombre`
        );
        res.json({ success: true, data: rows });
    } catch (e) {
        console.error('Error listando destinos:', e);
        res.status(500).json({ success: false, message: 'Error al listar destinos' });
    }
};

/**
 * Lista cargueras activas para el dropdown.
 */
exports.listCargueras = async (req, res) => {
    try {
        const rows = await db.query(
            'SELECT id, nombre FROM cargueras WHERE is_active = 1 ORDER BY nombre'
        );
        res.json({ success: true, data: rows });
    } catch (e) {
        console.error('Error listando cargueras:', e);
        res.status(500).json({ success: false, message: 'Error al listar cargueras' });
    }
};

/**
 * Lookup SCD Tipo 2 de tarifa de flete vigente.
 * Devuelve la fila de tarifas_carguera que aplica para
 * (carguera, destino, peso, fecha_proyeccion).
 */
async function lookupTarifaCarguera({ id_carguera, id_destino, peso, fecha }) {
    return db.queryOne(
        `SELECT *
         FROM tarifas_carguera
         WHERE id_carguera = ?
           AND id_destino  = ?
           AND ? BETWEEN peso_minimo AND peso_maximo
           AND fecha_inicio <= ?
           AND (fecha_fin IS NULL OR fecha_fin >= ?)
         ORDER BY fecha_inicio DESC
         LIMIT 1`,
        [id_carguera, id_destino, peso, fecha, fecha]
    );
}

/**
 * Lookup SCD Tipo 2 de tarifa de destino vigente.
 */
async function lookupTarifaDestino({ id_destino, fecha }) {
    return db.queryOne(
        `SELECT *
         FROM tarifas_destino
         WHERE id_destino = ?
           AND fecha_inicio <= ?
           AND (fecha_fin IS NULL OR fecha_fin >= ?)
         ORDER BY fecha_inicio DESC
         LIMIT 1`,
        [id_destino, fecha, fecha]
    );
}

/**
 * Calcula la cotización con los datos de input. Devuelve el snapshot completo.
 * No guarda nada en DB.
 */
async function computarCotizacion(input) {
    const {
        cantidad_tallos,
        precio_tallo_escenario_1,
        precio_tallo_escenario_2,
        kilos_totales,
        tallos_por_caja,
        id_carguera,
        id_destino,
        fecha_proyeccion
    } = input;

    // ---- Validaciones ----
    if (!cantidad_tallos || !tallos_por_caja
        || precio_tallo_escenario_1 == null || precio_tallo_escenario_2 == null
        || !id_carguera || !id_destino) {
        const e = new Error('Faltan parámetros requeridos.');
        e.status = 400;
        throw e;
    }

    const tallos = parseInt(cantidad_tallos, 10);
    const tallosCaja = parseInt(tallos_por_caja, 10);
    const fecha = fecha_proyeccion || new Date().toISOString().split('T')[0];

    // ---- 1) Peso final ----
    const pesoFinalKg = (kilos_totales != null && kilos_totales !== '')
        ? parseFloat(kilos_totales)
        : tallos * FACTOR_CONVERSION_KG;

    // ---- 2) Cajas ----
    const numeroCajas = Math.ceil(tallos / tallosCaja);

    // ---- 3) Lookup de tarifas vigentes ----
    const destino = await db.queryOne(
        'SELECT * FROM destinos WHERE id = ? AND is_active = 1',
        [id_destino]
    );
    if (!destino) { const e = new Error('Destino no encontrado o inactivo.'); e.status = 404; throw e; }

    const tarifaCarguera = await lookupTarifaCarguera({
        id_carguera, id_destino, peso: pesoFinalKg, fecha
    });
    if (!tarifaCarguera) {
        const e = new Error(`No existe tarifa de carguera vigente para peso ${pesoFinalKg.toFixed(2)} kg en la fecha ${fecha}.`);
        e.status = 404;
        throw e;
    }

    const tarifaDestino = await lookupTarifaDestino({ id_destino, fecha });
    if (!tarifaDestino) {
        const e = new Error(`No existe tarifa de destino vigente para la fecha ${fecha}.`);
        e.status = 404;
        throw e;
    }

    // Convertir a número (PG devuelve NUMERIC como string)
    const tarifaFlete = parseFloat(tarifaCarguera.tarifa_kilo);
    const costoDocumentacion = parseFloat(tarifaCarguera.costo_documentacion_fijo) || 0;
    const costoCuartoFrioKilo = parseFloat(tarifaCarguera.costo_cuarto_frio_kilo) || 0;
    const aduanaFija = parseFloat(tarifaDestino.aduana_fija) || 0;
    const transporteInternoCaja = parseFloat(tarifaDestino.transporte_interno_caja) || 0;
    const porcentajeArancel = parseFloat(destino.porcentaje_arancel) || 0;
    const porcentajeImpuesto = parseFloat(destino.porcentaje_impuesto_consumo) || 0;

    // ---- 4) Costos derivados ----
    const totalFijos = costoDocumentacion + aduanaFija;
    const incidenciaFijosPorTallo = totalFijos / tallos;

    const costoCuartoFrioTotal = pesoFinalKg * costoCuartoFrioKilo;
    const costoFleteTotal = pesoFinalKg * tarifaFlete;
    const costoFletePorTallo = costoFleteTotal / tallos;

    const costoTransporteTotal = numeroCajas * transporteInternoCaja;
    const costoTransportePorTallo = costoTransporteTotal / tallos;

    // ---- 5) Función para escenario ----
    const calcularEscenario = (precioFob) => {
        const precio = parseFloat(precioFob);
        const fobTotal = tallos * precio;
        const subtotal = fobTotal + costoFleteTotal + totalFijos
                       + costoTransporteTotal + costoCuartoFrioTotal;
        const impuestos = subtotal * (porcentajeArancel + porcentajeImpuesto);
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
            destino: { id: destino.id, codigo_iata: destino.codigo_iata, nombre: destino.nombre },
            id_carguera: parseInt(id_carguera, 10),
            tarifa_flete_aplicada: tarifaFlete,
            tarifa_carguera_id: tarifaCarguera.id,
            tarifa_destino_id: tarifaDestino.id
        },
        escenarios: {
            escenario_1: calcularEscenario(precio_tallo_escenario_1),
            escenario_2: calcularEscenario(precio_tallo_escenario_2)
        }
    };
}

function round(n, decimals = 2) {
    if (!Number.isFinite(n)) return 0;
    const f = Math.pow(10, decimals);
    return Math.round(n * f) / f;
}

/**
 * POST /api/cotizador/cotizar
 * Calcula sin guardar.
 */
exports.calcular = async (req, res) => {
    try {
        const result = await computarCotizacion(req.body);
        res.json({ success: true, data: result });
    } catch (e) {
        const status = e.status || 500;
        res.status(status).json({
            success: false,
            message: e.message || 'Error interno del motor de cálculo'
        });
        if (status >= 500) console.error('Error calcular:', e);
    }
};

/**
 * POST /api/cotizador/cotizaciones
 * Calcula Y guarda el snapshot inmutable en cotizaciones_historico.
 */
exports.guardarCotizacion = async (req, res) => {
    try {
        const result = await computarCotizacion(req.body);
        const userId = req.user ? req.user.id : null;
        const fecha = result.metadata.fecha_proyeccion;
        const snapshotJson = JSON.stringify(result);

        const r = await db.execute(
            `INSERT INTO cotizaciones_historico (user_id, fecha_proyeccion, snapshot)
             VALUES (?, ?, ?)`,
            [userId, fecha, snapshotJson]
        );

        res.status(201).json({
            success: true,
            message: 'Cotización guardada',
            data: {
                id: r.lastInsertId,
                ...result
            }
        });
    } catch (e) {
        const status = e.status || 500;
        res.status(status).json({
            success: false,
            message: e.message || 'Error al guardar cotización'
        });
        if (status >= 500) console.error('Error guardarCotizacion:', e);
    }
};

/**
 * GET /api/cotizador/cotizaciones
 * Histórico de cotizaciones del usuario actual (admin ve todas).
 */
exports.listarCotizaciones = async (req, res) => {
    try {
        const isAdmin = req.user.role === 'admin';
        const userId = req.user.id;
        const { limit = 50 } = req.query;

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

        // SQLite devuelve snapshot como string, PG como objeto JSONB ya parseado.
        const items = rows.map(r => ({
            ...r,
            snapshot: typeof r.snapshot === 'string' ? JSON.parse(r.snapshot) : r.snapshot
        }));

        res.json({ success: true, data: items });
    } catch (e) {
        console.error('Error listando cotizaciones:', e);
        res.status(500).json({ success: false, message: 'Error al listar cotizaciones' });
    }
};
