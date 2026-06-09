/**
 * Nómina v1.2 — Generador del PDF del rol de pago por empleado.
 *
 * Mismo patrón que cotizador-pdf.js: pdfkit, doc.pipe(res), SIN persistir.
 * El comprobante refleja el SNAPSHOT de la corrida (los % congelados que vienen
 * en payroll_details), NUNCA recomputa contra payroll_parameters actuales.
 *
 * PRIVACIDAD: el PDF muestra SÓLO el renglón del empleado (su recibo). NUNCA los
 * total_* agregados de la corrida (esos son masa salarial de toda la empresa,
 * con independencia de hr.payroll.read.all). Por eso buildRolPagoPDF recibe el
 * run ya proyectado SIN totales (shapeRun(run, false)) y sólo usa de él el
 * período / estado / sbu_snapshot.
 */

const PDFDocument = require('pdfkit');
const path = require('path');
const fs = require('fs');

// Tonos coherentes con el design-system (mismos que cotizador-pdf.js).
const COLOR = {
    text:   '#1f2937',
    muted:  '#6b7280',
    border: '#e5e7eb',
    brandPrimary: '#6366f1',
    ingreso: '#10b981',  // verde para ingresos
    descuento: '#ef4444', // rojo para descuentos
    bg:     '#f9fafb'
};

const MESES_ES = [
    'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
    'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'
];

// Formato de dinero en USD (igual estilo que el cotizador).
function fmtMoney(n) {
    if (n === null || n === undefined || !Number.isFinite(+n)) return '$0.00';
    return '$' + (+n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Formato de porcentaje con hasta 4 decimales pero sin ceros sobrantes.
function fmtPct(n) {
    if (n === null || n === undefined || !Number.isFinite(+n)) return '0%';
    return `${(+n)}%`;
}

function nombreMes(month) {
    return MESES_ES[(Number(month) - 1)] || String(month);
}

/**
 * Construye el PDF del rol de pago de un empleado.
 * @param {Object} detail - renglón ya shape-ado (PayrollController.shapeDetail).
 * @param {Object} run    - cabecera SIN totales (período, estado, sbu_snapshot).
 * @param {Object} meta   - { employee_name, generated_at }.
 * @returns {PDFDocument} stream listo para .pipe(res).
 */
function buildRolPagoPDF(detail, run, meta = {}) {
    const doc = new PDFDocument({ size: 'A4', margin: 40 });
    const generatedAt = meta.generated_at || new Date().toISOString();
    const empName = meta.employee_name || detail.employee_name || `Empleado #${detail.employee_id}`;

    // ---------- Header con logo ----------
    try {
        const logoPath = path.join(__dirname, '..', 'public', 'img', 'logo-bg complete.png');
        if (fs.existsSync(logoPath)) {
            doc.image(logoPath, 40, 35, { width: 110 });
        }
    } catch (e) { /* sin logo no rompe */ }

    doc.fontSize(9).fillColor(COLOR.muted)
       .text('Helper Ecualand · Talento Humano', 40, 95, { align: 'left' });

    doc.fontSize(16).fillColor(COLOR.text).font('Helvetica-Bold')
       .text('ROL DE PAGO', 0, 40, { align: 'right' });
    doc.fontSize(10).fillColor(COLOR.brandPrimary).font('Helvetica-Bold')
       .text(`${nombreMes(run.period_month)} ${run.period_year}`, 0, 60, { align: 'right' });
    doc.fontSize(8).fillColor(COLOR.muted).font('Helvetica')
       .text(`Estado: ${run.status === 'finalized' ? 'Finalizado' : 'Borrador'}`, 0, 76, { align: 'right' });
    doc.text(`Generado: ${new Date(generatedAt).toLocaleString('es-EC')}`, 0, 88, { align: 'right' });

    // ---------- Línea divisoria ----------
    doc.moveTo(40, 120).lineTo(555, 120).strokeColor(COLOR.border).lineWidth(0.5).stroke();

    // ---------- Datos del empleado ----------
    let y = 134;
    doc.fontSize(13).fillColor(COLOR.text).font('Helvetica-Bold')
       .text(empName, 40, y);
    y += 22;
    doc.fontSize(9).fillColor(COLOR.muted).font('Helvetica')
       .text(`Período: ${nombreMes(run.period_month)} de ${run.period_year}`, 40, y);
    y += 22;

    // ---------- Tabla Ingresos ----------
    y = drawSeccion(doc, y, 'INGRESOS', COLOR.ingreso, [
        ['Sueldo base', detail.sueldo_base],
        ['Fondos de reserva', detail.fondos_reserva],
        ['Décimo tercero (mensualizado)', detail.decimo_tercero],
        ['Décimo cuarto (mensualizado)', detail.decimo_cuarto],
        ['Horas extra', detail.horas_extra],
        ['Otros ingresos', detail.otros_ingresos]
    ], 'Total ingresos', detail.total_ingresos);

    y += 10;

    // ---------- Tabla Descuentos ----------
    y = drawSeccion(doc, y, 'DESCUENTOS', COLOR.descuento, [
        [`Aporte personal IESS (${fmtPct(detail.iess_personal_pct_snapshot)})`, detail.aporte_personal],
        ['Otros descuentos', detail.otros_descuentos]
    ], 'Total descuentos', detail.total_descuentos);

    y += 16;

    // ---------- Neto a pagar (destacado) ----------
    doc.roundedRect(40, y, 515, 40, 6).fillColor(COLOR.bg).fill();
    doc.fillColor(COLOR.text).font('Helvetica-Bold').fontSize(13)
       .text('NETO A PAGAR', 56, y + 13);
    doc.fillColor(COLOR.brandPrimary).font('Helvetica-Bold').fontSize(16)
       .text(fmtMoney(detail.neto_a_pagar), 40, y + 11, { width: 499, align: 'right' });
    y += 56;

    // ---------- Costo empresa (informativo) ----------
    doc.fontSize(8).fillColor(COLOR.muted).font('Helvetica')
       .text('Costo empresa (informativo, no afecta el neto del empleado):', 40, y);
    y += 14;
    drawRow(doc, y, `Aporte patronal IESS (${fmtPct(detail.iess_patronal_pct_snapshot)})`, detail.aporte_patronal, COLOR.muted);
    y += 14;
    drawRow(doc, y, 'Costo empresa total', detail.costo_empresa, COLOR.muted);
    y += 24;

    // ---------- Warnings (avisos no fatales del cálculo) ----------
    if (Array.isArray(detail.warnings) && detail.warnings.length > 0) {
        doc.fontSize(8).fillColor(COLOR.descuento).font('Helvetica-Oblique')
           .text('Avisos: ' + detail.warnings.join(' · '), 40, y, { width: 515 });
    }

    // ---------- Footer ----------
    doc.fontSize(8).fillColor(COLOR.muted).font('Helvetica-Oblique')
       .text(
           'Documento generado automáticamente por Helper Ecualand. Refleja los parámetros vigentes ' +
           'al momento de generar la corrida (snapshot inmutable). Comprobante individual: no incluye la ' +
           'masa salarial agregada de la empresa.',
           40, 790, { width: 515, align: 'center' }
       );

    return doc;
}

// Dibuja una sección (Ingresos / Descuentos): título de color, filas y un total.
// Sólo lista filas con monto > 0 para no llenar de ceros, pero el total siempre
// se muestra. Devuelve la nueva coordenada Y.
function drawSeccion(doc, y, titulo, color, filas, totalLabel, totalValue) {
    doc.fontSize(10).fillColor(color).font('Helvetica-Bold').text(titulo, 40, y);
    y += 18;
    doc.font('Helvetica').fontSize(9);
    for (const [label, value] of filas) {
        if (Number(value) > 0) {
            drawRow(doc, y, label, value, COLOR.text);
            y += 16;
        }
    }
    // Línea + total de la sección.
    doc.moveTo(40, y).lineTo(555, y).strokeColor(COLOR.border).lineWidth(0.5).stroke();
    y += 6;
    doc.font('Helvetica-Bold').fontSize(10).fillColor(COLOR.text).text(totalLabel, 56, y);
    doc.font('Helvetica-Bold').fontSize(10).fillColor(color)
       .text(fmtMoney(totalValue), 40, y, { width: 499, align: 'right' });
    return y + 18;
}

// Dibuja una fila etiqueta → monto alineado a la derecha.
function drawRow(doc, y, label, value, labelColor) {
    doc.font('Helvetica').fontSize(9).fillColor(labelColor).text(label, 56, y, { width: 320 });
    doc.fillColor(COLOR.text).text(fmtMoney(value), 40, y, { width: 499, align: 'right' });
}

module.exports = { buildRolPagoPDF };
