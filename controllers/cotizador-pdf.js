/**
 * PR-5c: Generador de PDF de cotizaciones.
 *
 * El endpoint POST /api/cotizador/cotizar-pdf recibe el mismo payload que
 * /cotizar, recalcula, y devuelve el resultado como application/pdf. No
 * persiste nada; si el usuario quiere guardar la cotización debe usar el
 * endpoint /cotizaciones aparte.
 *
 * Diseño del PDF (1 página por cotización):
 *   - Header: logo Ecualand a la izquierda, "COTIZACIÓN LANDED COST"
 *     a la derecha, fecha + número de cotización (timestamp).
 *   - Ruta grande: "UIO → MIA" con destino debajo (ciudad, país).
 *   - Tarjeta de metadata: carguera, aerolínea, tarifa flete, cajas,
 *     tallos, kilos, factor de conversión, tipo de tarifa.
 *   - Dos columnas lado a lado con los escenarios. Cada una con
 *     desglose: FOB total, flete, costos fijos, transporte, cuarto frío,
 *     impuestos, total. Bajo el total: landed cost por tallo.
 *   - Footer: "Helper Ecualand · Generado automáticamente · No requiere firma"
 */

const PDFDocument = require('pdfkit');
const path = require('path');
const fs = require('fs');

function fmtMoney(n) {
    if (n === null || n === undefined || !Number.isFinite(+n)) return '-';
    return '$' + (+n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtNum(n, dec = 2) {
    if (n === null || n === undefined || !Number.isFinite(+n)) return '-';
    return (+n).toFixed(dec);
}

// Tonos coherentes con el design-system (slate dark + violeta brand)
const COLOR = {
    text:   '#1f2937',
    muted:  '#6b7280',
    border: '#e5e7eb',
    brandPrimary: '#6366f1',
    brandAccent:  '#10b981',
    low:    '#3b82f6',
    high:   '#10b981',
    bg:     '#f9fafb'
};

/**
 * Genera el PDF de una cotización ya calculada.
 * @param {Object} result    - El output de `computarCotizacion()`.
 * @param {Object} extraMeta - { user_full_name, generated_at }
 * @returns {PDFDocument} stream listo para .pipe(res)
 */
function buildCotizacionPDF(result, extraMeta = {}) {
    const doc = new PDFDocument({ size: 'A4', margin: 40 });
    const m  = result.metadata;
    const e1 = result.escenarios.escenario_1;
    const e2 = result.escenarios.escenario_2;
    const generatedAt = extraMeta.generated_at || new Date().toISOString();

    // ---------- Header ----------
    // Logo si existe en /public/img/logo-bg complete.png
    try {
        const logoPath = path.join(__dirname, '..', 'public', 'img', 'logo-bg complete.png');
        if (fs.existsSync(logoPath)) {
            doc.image(logoPath, 40, 35, { width: 110 });
        }
    } catch (e) { /* sin logo no rompe */ }

    doc.fontSize(9).fillColor(COLOR.muted)
       .text('Helper Ecualand · Flowers & Logistics', 40, 95, { align: 'left' });

    doc.fontSize(16).fillColor(COLOR.text).font('Helvetica-Bold')
       .text('COTIZACIÓN LANDED COST', 0, 40, { align: 'right' });
    doc.fontSize(9).fillColor(COLOR.muted).font('Helvetica')
       .text(`Generado: ${new Date(generatedAt).toLocaleString('es-EC')}`, 0, 62, { align: 'right' });
    if (extraMeta.user_full_name) {
        doc.text(`Usuario: ${extraMeta.user_full_name}`, 0, 76, { align: 'right' });
    }

    // ---------- Línea divisoria ----------
    doc.moveTo(40, 120).lineTo(555, 120).strokeColor(COLOR.border).lineWidth(0.5).stroke();

    // ---------- Ruta grande ----------
    let y = 140;
    doc.fontSize(28).fillColor(COLOR.brandPrimary).font('Helvetica-Bold')
       .text(`${m.origen.iata}  →  ${m.destino.iata}`, 40, y, { align: 'center' });
    y += 38;
    doc.fontSize(11).fillColor(COLOR.muted).font('Helvetica')
       .text(`${m.destino.ciudad}, ${m.destino.pais}`, 40, y, { align: 'center' });
    y += 20;

    // ---------- Tarjeta de metadata ----------
    const metaRows = [
        ['Carguera',       m.carguera_nombre || '—'],
        ['Aerolínea',      m.aerolinea_nombre || '—'],
        ['Tarifa flete',   `${fmtMoney(m.tarifa_flete_aplicada)}/kg (${m.tariff_type || 'contract'})`],
        ['Cantidad',       `${m.cantidad_tallos.toLocaleString()} tallos en ${m.numero_cajas} cajas`],
        ['Peso',           `${fmtNum(m.kilos_calculados, 2)} kg (${m.factor_conversion_usado || '0.056 kg/tallo'})`],
        ['Fecha cálculo',  m.fecha_proyeccion || generatedAt.substring(0, 10)]
    ];
    const metaX = 60, metaW = 480, metaRowH = 18, metaH = metaRowH * metaRows.length + 20;
    doc.roundedRect(metaX, y, metaW, metaH, 6).fillColor(COLOR.bg).fill();
    doc.fillColor(COLOR.text).font('Helvetica').fontSize(10);
    metaRows.forEach((r, i) => {
        const ry = y + 12 + i * metaRowH;
        doc.fillColor(COLOR.muted).text(r[0], metaX + 14, ry, { width: 130 });
        doc.fillColor(COLOR.text).text(r[1], metaX + 150, ry, { width: metaW - 160 });
    });
    y += metaH + 28;

    // ---------- Dos escenarios lado a lado ----------
    const colW = 247, gap = 16, colX1 = 40, colX2 = colX1 + colW + gap;
    drawEscenario(doc, e1, 'ESCENARIO BAJO', COLOR.low, colX1, y, colW);
    drawEscenario(doc, e2, 'ESCENARIO ALTO', COLOR.high, colX2, y, colW);

    // Footer (al final de la página)
    doc.fontSize(8).fillColor(COLOR.muted).font('Helvetica-Oblique')
       .text(
           'Documento generado automáticamente por Helper Ecualand. ' +
           'Los valores son referenciales basados en las tarifas vigentes al momento del cálculo. ' +
           'No requiere firma manual.',
           40, 780, { width: 515, align: 'center' }
       );

    return doc;
}

function drawEscenario(doc, e, label, headColor, x, y, w) {
    const headH = 36;
    // Header rojo/verde
    doc.roundedRect(x, y, w, headH, 6).fillColor(headColor).fill();
    doc.fillColor('white').font('Helvetica-Bold').fontSize(9)
       .text(label, x + 12, y + 8, { width: w - 24 });
    doc.fontSize(13)
       .text(`${fmtMoney(e.precio_fob_tallo)}/tallo`, x + 12, y + 18, { width: w - 24 });

    // Cuerpo
    const bodyY = y + headH + 4;
    const rows = [
        ['FOB total',           e.desglose_totales.fob_total],
        ['Flete',               e.desglose_totales.costo_flete],
        ['Costos fijos',        e.desglose_totales.costos_fijos],
        ['Transporte interno',  e.desglose_totales.transporte_interno]
    ];
    if (e.desglose_totales.cuarto_frio) rows.push(['Cuarto frío', e.desglose_totales.cuarto_frio]);
    if (e.desglose_totales.impuestos > 0) rows.push(['Impuestos y aranceles', e.desglose_totales.impuestos]);
    const rowH = 16;
    doc.font('Helvetica').fontSize(9);
    rows.forEach((r, i) => {
        const ry = bodyY + i * rowH;
        doc.fillColor(COLOR.muted).text(r[0], x + 12, ry, { width: w * 0.55 });
        doc.fillColor(COLOR.text).text(fmtMoney(r[1]), x + 12, ry, { width: w - 24, align: 'right' });
    });
    const totY = bodyY + rows.length * rowH + 6;

    // Línea divisoria antes del total
    doc.moveTo(x + 12, totY).lineTo(x + w - 12, totY)
       .strokeColor(COLOR.border).lineWidth(0.5).stroke();

    // Total
    const grandTotalY = totY + 8;
    doc.fillColor(COLOR.text).font('Helvetica-Bold').fontSize(10)
       .text('Landed Cost Total', x + 12, grandTotalY, { width: w * 0.55 });
    doc.font('Helvetica-Bold').fontSize(14).fillColor(headColor)
       .text(fmtMoney(e.desglose_totales.gran_total), x + 12, grandTotalY - 2, { width: w - 24, align: 'right' });

    // Por tallo
    const perStemY = grandTotalY + 20;
    doc.font('Helvetica').fontSize(8).fillColor(COLOR.muted)
       .text('Por tallo', x + 12, perStemY, { width: w * 0.55 });
    doc.font('Helvetica-Bold').fontSize(10).fillColor(headColor)
       .text(fmtMoney(e.landed_cost_por_tallo), x + 12, perStemY - 1, { width: w - 24, align: 'right' });
}

module.exports = { buildCotizacionPDF };
