/**
 * Nómina / Roles de Pago v1.2 — UI (PR-nómina-ui)
 *
 * Controlador del frontend para la pestaña "Nómina" dentro de la sección RRHH.
 * Consume el backend ya implementado en /api/hr/payroll/*:
 *   - GET    /params                          (perm hr.payroll.read)        → parámetros vigentes
 *   - PUT    /params/:key                     (perm hr.payroll.params.write)→ editar 1 parámetro
 *   - GET    /runs                            (perm hr.payroll.read)        → cabeceras de corridas
 *   - POST   /runs                            (perm hr.payroll.run)         → generar rol del mes
 *   - GET    /runs/:id                        (perm hr.payroll.read)        → corrida + detalle
 *   - POST   /runs/:id/finalize               (perm hr.payroll.run)         → sellar el rol
 *   - GET    /runs/:id/employee/:empId/pdf    (perm hr.payroll.read)        → recibo PDF
 *
 * Reglas de PII (el backend YA filtra; el front sólo renderiza lo que llega):
 *   - Los total_* del run SÓLO vienen con hr.payroll.read.all. Si no vinieron,
 *     se muestra "—" en la columna Total Neto y NO se dibuja la fila de TOTALES.
 *   - Sin read.all, el detalle trae SÓLO el renglón propio del empleado. La
 *     tabla renderiza lo que llega; no asume que estén todos los empleados.
 *
 * UI: mismo design system que hr-admin.js. Modales con .active / closeModal,
 * formDialog/confirmDialog/infoDialog para los flujos, escapeHtml en TODO dato
 * de servidor, y cero popups nativos (alert/confirm/prompt).
 */

const payrollAdmin = (function () {
    // ------------------------------------------------------------
    // Infra compartida (mismo patrón que hr-admin.js)
    // ------------------------------------------------------------
    function token() { return Utils.getToken(); }
    function authHeader() { return { 'Authorization': 'Bearer ' + token() }; }

    // Base de todos los endpoints de nómina (una sola fuente de verdad).
    const PAYROLL_BASE = '/api/hr/payroll';

    // Permisos que gobiernan los botones de escritura. El gating de UI es
    // COSMÉTICO: la autorización real está en el backend (devuelve 403). Por eso
    // si el user clickea igual y no tiene permiso, mostramos el error que llega.
    const PERM_RUN = 'hr.payroll.run';                 // generar + finalizar
    const PERM_PARAMS_WRITE = 'hr.payroll.params.write'; // editar parámetros

    // Estados de una corrida (los devuelve el backend en crudo; nunca mostramos
    // el code pelado al usuario, lo traducimos con RUN_ESTADO_LABEL).
    const RUN_DRAFT = 'draft';
    const RUN_FINALIZED = 'finalized';

    const RUN_ESTADO_LABEL = {
        draft:     'Borrador',
        finalized: 'Finalizado'
    };
    const RUN_ESTADO_BADGE = {
        draft:     'badge-warning',   // ámbar: editable / sin sellar
        finalized: 'badge-success'    // verde: sellado, inmutable
    };

    // Nombres de los meses (1–12) para selects y para el período legible.
    const NOMBRES_MES = [
        'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
        'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'
    ];

    async function api(method, path, body) {
        const opts = { method, headers: { ...authHeader() } };
        if (body !== undefined) {
            opts.headers['Content-Type'] = 'application/json';
            opts.body = JSON.stringify(body);
        }
        const r = await fetch(PAYROLL_BASE + path, opts);
        let data = null;
        try { data = await r.json(); } catch { data = null; }
        if (!r.ok) {
            // Mensaje del backend tal cual viene saneado; nunca inventamos internals.
            const msg = (data && data.message) || ('HTTP ' + r.status);
            throw new Error(msg);
        }
        return data;
    }

    function escapeHtml(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    // ¿El user tiene este permiso? Reusa el contexto RBAC que auth.js ya cargó
    // en window.__userPerms / window.__userIsAdmin. Admin tiene todo.
    function tienePermiso(code) {
        if (window.__userIsAdmin) return true;
        return !!(window.__userPerms && window.__userPerms.has(code));
    }

    // ------------------------------------------------------------
    // Formato de moneda y fechas
    // ------------------------------------------------------------

    // Formatea un número como moneda USD clara: $1,028.00. Acepta null/undefined
    // (devuelve el guion "—", usado cuando un total no vino por PII).
    function fmtMoney(n) {
        if (n == null || n === '' || isNaN(Number(n))) return '—';
        return '$' + Number(n).toLocaleString('en-US', {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2
        });
    }

    // Período legible a partir de mes (1–12) + año: "Junio 2026".
    function fmtPeriodo(month, year) {
        const nombre = NOMBRES_MES[Number(month) - 1] || ('Mes ' + month);
        return `${nombre} ${year}`;
    }

    // Fecha-hora ISO → legible corta es-EC (sin segundos). "-" si no hay valor.
    function fmtDateTime(s) {
        if (!s) return '-';
        const d = new Date(s);
        if (isNaN(d.getTime())) return String(s);
        return d.toLocaleString('es-EC', {
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit'
        });
    }

    // Badge de estado de la corrida (label legible, nunca el code crudo).
    function estadoRunBadge(status) {
        const cls = RUN_ESTADO_BADGE[status] || 'badge-info';
        const label = RUN_ESTADO_LABEL[status] || status;
        return `<span class="badge ${cls}">${escapeHtml(label)}</span>`;
    }

    // ============================================================
    // Activación de la pestaña (la llama el switcher de tabs de hr-admin.js
    // a través del listener que registramos abajo en setupPayrollTab()).
    // ============================================================

    // Estado mínimo del módulo. Guardamos el último run abierto para que los
    // botones (Finalizar/PDF) pasen sólo el id y releamos lo demás de acá,
    // evitando interpolar datos de servidor dentro de los onclick.
    let _currentRun = null;          // cabecera del run abierto en el detalle
    let _currentRunDetails = [];     // renglones del run abierto
    let _currentRunSeeTotals = false;// ¿el detalle abierto trajo total_* (read.all)?

    // Aplica el gating de los botones de escritura de la barra superior. Se
    // llama cada vez que se entra a la pestaña (el contexto RBAC ya está cargado).
    function applyPayrollGating() {
        const btnGenerar = document.getElementById('payroll-btn-generar');
        if (btnGenerar) btnGenerar.style.display = tienePermiso(PERM_RUN) ? '' : 'none';
        // El botón "Parámetros" es visible para todos (incluye vista de lectura);
        // el botón "Editar" de cada parámetro se gatea dentro del modal.
    }

    // Punto de entrada de la pestaña: monta los filtros y carga la lista.
    function activate() {
        applyPayrollGating();
        ensureFilterOptions();
        loadRuns();
    }

    // Rellena el filtro de Año (una vez) con un rango razonable alrededor del
    // año actual, y deja Mes/Estado con su opción "Todos".
    function ensureFilterOptions() {
        const yearSel = document.getElementById('payroll-filter-year');
        if (yearSel && yearSel.options.length <= 1) {
            const actual = new Date().getFullYear();
            // Un par de años hacia atrás y uno hacia adelante cubre el uso real.
            for (let y = actual + 1; y >= actual - 3; y--) {
                const opt = document.createElement('option');
                opt.value = String(y);
                opt.textContent = String(y);
                if (y === actual) opt.selected = true;
                yearSel.appendChild(opt);
            }
        }
        const monthSel = document.getElementById('payroll-filter-month');
        if (monthSel && monthSel.options.length <= 1) {
            NOMBRES_MES.forEach((nombre, i) => {
                const opt = document.createElement('option');
                opt.value = String(i + 1);
                opt.textContent = nombre;
                monthSel.appendChild(opt);
            });
        }
    }

    // ============================================================
    // Pantalla 2: Lista de corridas (tabla)
    // ============================================================
    async function loadRuns() {
        const tbody = document.getElementById('payroll-runs-tbody');
        if (!tbody) return;
        tbody.innerHTML = '<tr><td colspan="6" class="loading">Cargando roles de pago...</td></tr>';

        // Filtros opcionales. Sólo se mandan si el user eligió algo distinto de "Todos".
        const year = document.getElementById('payroll-filter-year').value;
        const month = document.getElementById('payroll-filter-month').value;
        const status = document.getElementById('payroll-filter-status').value;
        const qs = [];
        if (year) qs.push('period_year=' + encodeURIComponent(year));
        if (month) qs.push('period_month=' + encodeURIComponent(month));
        if (status) qs.push('status=' + encodeURIComponent(status));
        const path = '/runs' + (qs.length ? '?' + qs.join('&') : '');

        try {
            const r = await api('GET', path);
            const runs = (r.data && r.data.runs) || [];
            if (runs.length === 0) {
                tbody.innerHTML = '<tr><td colspan="6" class="empty">No hay roles de pago con ese filtro. Generá el primero con "Generar rol del mes".</td></tr>';
                return;
            }
            tbody.innerHTML = runs.map(renderRunRow).join('');
        } catch (err) {
            tbody.innerHTML = `<tr><td colspan="6" class="error">${escapeHtml(err.message)}</td></tr>`;
        }
    }

    // Una fila de la tabla de corridas. El "Total Neto" sólo se muestra si el
    // backend lo mandó (total_neto presente = el user tiene read.all); si no,
    // "—". El botón Finalizar sólo aparece en borrador Y con permiso de correr.
    function renderRunRow(run) {
        const periodo = fmtPeriodo(run.period_month, run.period_year);
        // total_neto puede no venir (PII). undefined → "—".
        const totalNeto = run.total_neto !== undefined ? fmtMoney(run.total_neto) : '—';
        const generadoPor = run.generated_by_username || '-';
        const empleados = run.employee_count != null ? run.employee_count : '-';

        // Acciones: Ver siempre; Finalizar sólo si está en borrador y el user
        // tiene permiso de correr nómina (cosmético; el backend revalida).
        const puedeFinalizar = run.status === RUN_DRAFT && tienePermiso(PERM_RUN);
        const accionFinalizar = puedeFinalizar
            ? `<button class="btn-edit" onclick="payrollAdmin.finalizeRun(${run.id})">Finalizar</button>`
            : '';

        return `
            <tr>
                <td><strong>${escapeHtml(periodo)}</strong></td>
                <td>${estadoRunBadge(run.status)}</td>
                <td>${escapeHtml(String(empleados))}</td>
                <td>${totalNeto === '—' ? '<span style="color:var(--text-3);">—</span>' : '<strong>' + escapeHtml(totalNeto) + '</strong>'}</td>
                <td>${escapeHtml(generadoPor)}</td>
                <td>
                    <button class="btn-edit" onclick="payrollAdmin.openRunDetail(${run.id})">Ver</button>
                    ${accionFinalizar}
                </td>
            </tr>
        `;
    }

    // ============================================================
    // Pantalla 5: Generar rol del mes
    // ============================================================
    async function openGenerateRun() {
        const ahora = new Date();
        // Pre-seleccionamos el mes ANTERIOR (la nómina suele generarse a mes
        // vencido). getMonth() es 0-based: el mes anterior en base-1 es getMonth().
        let mesDefault = ahora.getMonth();            // 0..11 == mes anterior en base-1 (1..12)
        let anioDefault = ahora.getFullYear();
        if (mesDefault === 0) { mesDefault = 12; anioDefault -= 1; } // enero → diciembre del año pasado

        const data = await formDialog({
            title: 'Generar rol del mes',
            description: 'Se genera el rol de pago para TODOS los empleados activos del período elegido. Una vez generado podés revisarlo; al finalizarlo queda sellado e inmutable.',
            fields: [
                { name: 'period_month', label: 'Mes', type: 'select', required: true, default: String(mesDefault),
                  options: NOMBRES_MES.map((nombre, i) => ({ value: String(i + 1), label: nombre })) },
                { name: 'period_year', label: 'Año', type: 'number', required: true, default: String(anioDefault) }
            ],
            confirmText: 'Generar rol'
        });
        if (!data) return;

        // Validación de cliente para fallar rápido y claro (el backend revalida).
        const month = Number(data.period_month);
        const year = Number(data.period_year);
        if (!Number.isInteger(year) || year < 2000 || year > 2100) {
            Notification.error('Indicá un año válido (entre 2000 y 2100).');
            return;
        }

        try {
            const resp = await api('POST', '/runs', { period_month: month, period_year: year });
            Notification.success(`Rol de ${fmtPeriodo(month, year)} generado`);
            // Refrescamos la lista y abrimos el detalle del rol recién creado.
            await loadRuns();
            const nuevoRun = resp.data && resp.data.run;
            if (nuevoRun && nuevoRun.id) {
                openRunDetailWithData(nuevoRun, (resp.data && resp.data.details) || []);
            }
        } catch (err) {
            // 409 = ya existe un rol para ese período (rol inmutable).
            Notification.error('No se pudo generar: ' + err.message);
        }
    }

    // ============================================================
    // Acción: Eliminar BORRADOR — para corregir datos y regenerar el período.
    // Un rol finalizado nunca se elimina (el backend devuelve 409).
    // ============================================================
    async function deleteDraft(runId) {
        const ok = await confirmDialog({
            title: '¿Eliminar este borrador?',
            message: 'Se elimina el borrador completo (todos los renglones calculados). Útil si un sueldo o parámetro estaba mal cargado: corregilo y volvé a generar el período. Un rol FINALIZADO nunca puede eliminarse.',
            confirmText: 'Eliminar borrador',
            cancelText: 'Cancelar',
            danger: true
        });
        if (!ok) return;
        try {
            const r = await api('DELETE', `/runs/${runId}`);
            Notification.success(r.message || 'Borrador eliminado');
            closeModal('payroll-detail-modal');
            loadRuns(); // refrescar la lista (el período queda libre)
        } catch (err) {
            Notification.error('No se pudo eliminar: ' + err.message);
        }
    }

    // ============================================================
    // Acción: Finalizar (sellar el rol) — confirma con modal del design system
    // ============================================================
    async function finalizeRun(runId) {
        const ok = await confirmDialog({
            title: '¿Finalizar este rol de pago?',
            message: 'Al finalizar, el rol queda SELLADO e inmutable: no se podrá regenerar ni editar, y servirá como comprobante oficial del período. Esto es lo que lo hace mejor que un Excel editable. ¿Confirmás?',
            confirmText: 'Finalizar y sellar',
            cancelText: 'Cancelar',
            danger: false
        });
        if (!ok) return;
        try {
            await api('POST', `/runs/${runId}/finalize`);
            Notification.success('Rol finalizado y sellado');
            await loadRuns();
            // Si el detalle de este run está abierto, lo refrescamos para reflejar
            // el nuevo estado (sellado por/cuándo) y deshabilitar acciones.
            if (_currentRun && _currentRun.id === runId) {
                await reloadRunDetail(runId);
            }
        } catch (err) {
            // 409 = ya estaba finalizado.
            Notification.error('No se pudo finalizar: ' + err.message);
        }
    }

    // ============================================================
    // Pantalla 4: Detalle del rol — la planilla estilo Excel
    // ============================================================

    // Abre el modal y carga el detalle desde el backend (caso "Ver" de la lista).
    async function openRunDetail(runId) {
        document.getElementById('payroll-detail-modal').classList.add('active');
        await reloadRunDetail(runId);
    }

    // Abre el modal con datos YA traídos (caso "recién generado": el POST ya
    // devolvió run + details, evitamos un GET extra).
    function openRunDetailWithData(run, details) {
        document.getElementById('payroll-detail-modal').classList.add('active');
        // Si el run trae total_* es que el user ve totales (read.all).
        const seeTotals = run.total_neto !== undefined;
        renderRunDetail(run, details, seeTotals);
    }

    // (Re)carga el detalle de un run desde el backend y lo pinta.
    async function reloadRunDetail(runId) {
        const body = document.getElementById('payroll-detail-body');
        body.innerHTML = '<p class="loading">Cargando la planilla del rol...</p>';
        try {
            const r = await api('GET', `/runs/${runId}`);
            const run = r.data && r.data.run;
            const details = (r.data && r.data.details) || [];
            // El run trae total_* sólo si el user tiene read.all.
            const seeTotals = run && run.total_neto !== undefined;
            renderRunDetail(run, details, seeTotals);
        } catch (err) {
            body.innerHTML = `<p class="error">${escapeHtml(err.message)}</p>`;
        }
    }

    // Pinta la planilla del rol: encabezado + tabla por empleado agrupada en
    // INGRESOS / EGRESOS / LÍQUIDO. Guarda el run en estado para los botones.
    function renderRunDetail(run, details, seeTotals) {
        _currentRun = run;
        _currentRunDetails = details;
        _currentRunSeeTotals = !!seeTotals;

        const body = document.getElementById('payroll-detail-body');
        if (!run) {
            body.innerHTML = '<p class="error">No se pudo cargar la corrida.</p>';
            return;
        }

        // --- Encabezado: período + estado + sellado (si finalizado) ---
        const periodo = fmtPeriodo(run.period_month, run.period_year);
        const finalizado = run.status === RUN_FINALIZED;
        const selladoInfo = finalizado
            ? `<p style="margin:0.35rem 0 0; color:var(--text-2);">Sellado por <strong>${escapeHtml(run.finalized_by_username || run.finalized_by || '—')}</strong> · ${escapeHtml(fmtDateTime(run.finalized_at))}</p>`
            : `<p style="margin:0.35rem 0 0; color:var(--text-3);">Borrador editable — al finalizarlo queda inmutable.</p>`;

        // Botones EN EL ENCABEZADO del detalle: en borrador (y con permiso),
        // "Finalizar y sellar" + "Eliminar borrador" (permite corregir un dato
        // y regenerar el período). En finalizado, sello visual de "inmutable".
        const puedeFinalizar = !finalizado && tienePermiso(PERM_RUN);
        const accionHeader = puedeFinalizar
            ? `<button class="btn btn-outline" onclick="payrollAdmin.deleteDraft(${run.id})">Eliminar borrador</button>
               <button class="btn btn-primary" onclick="payrollAdmin.finalizeRun(${run.id})">Finalizar y sellar</button>`
            : (finalizado ? '<span class="badge badge-success" title="Este rol está sellado y no puede modificarse">🔒 Inmutable</span>' : '');

        const header = `
            <div class="payroll-detail-header">
                <div>
                    <h3 style="margin:0;">${escapeHtml(periodo)} &nbsp; ${estadoRunBadge(run.status)}</h3>
                    ${selladoInfo}
                </div>
                <div>${accionHeader}</div>
            </div>
        `;

        // --- Tabla por empleado ---
        if (!details || details.length === 0) {
            body.innerHTML = header + '<p class="empty" style="margin-top:1rem;">No hay renglones visibles en este rol.</p>';
            return;
        }

        const filas = details.map(renderDetailRow).join('');

        // Fila de TOTALES: SÓLO si el user ve totales (read.all). Para un empleado
        // que ve sólo su renglón NO tiene sentido (y el backend no mandó total_*),
        // así que se omite por completo.
        const filaTotales = seeTotals ? renderTotalsRow(run) : '';

        // Columna "Costo empresa": sólo aplica cuando se ven totales. Se controla
        // con un checkbox que muestra/oculta las celdas con la clase .payroll-col-costo.
        const toggleCosto = seeTotals ? `
            <label class="payroll-costo-toggle">
                <input type="checkbox" id="payroll-toggle-costo" onchange="payrollAdmin.toggleCostoEmpresa()">
                Mostrar costo empresa
            </label>
        ` : '';

        // Aviso de PII para el empleado que ve sólo su renglón (transparencia UX).
        const avisoPropio = (!seeTotals && details.length === 1)
            ? '<p style="color:var(--text-3); font-size:0.82rem; margin:0.25rem 0 0.75rem;">Estás viendo tu propio rol de pago. Los totales de la empresa sólo los ve RRHH.</p>'
            : '';

        body.innerHTML = `
            ${header}
            ${avisoPropio}
            <div class="payroll-table-toolbar">${toggleCosto}</div>
            <div class="payroll-table-scroll">
                <table class="payroll-table">
                    <thead>
                        <tr class="payroll-group-row">
                            <th></th>
                            <th colspan="6" class="payroll-group payroll-group-ingresos">INGRESOS</th>
                            <th colspan="3" class="payroll-group payroll-group-egresos">EGRESOS</th>
                            <th class="payroll-group payroll-group-neto">LÍQUIDO</th>
                            <th class="payroll-col-costo payroll-group payroll-group-costo" style="display:none;">EMPRESA</th>
                            <th></th>
                        </tr>
                        <tr>
                            <th>Empleado</th>
                            <th class="payroll-num">Sueldo</th>
                            <th class="payroll-num">Fondos res.</th>
                            <th class="payroll-num">Décimo 13</th>
                            <th class="payroll-num">Décimo 14</th>
                            <th class="payroll-num">Otros</th>
                            <th class="payroll-num payroll-subtotal">Total ingresos</th>
                            <th class="payroll-num">Aporte IESS</th>
                            <th class="payroll-num">Otros desc.</th>
                            <th class="payroll-num payroll-subtotal">Total egresos</th>
                            <th class="payroll-num payroll-neto">Líquido a recibir</th>
                            <th class="payroll-num payroll-col-costo" style="display:none;">Costo empresa</th>
                            <th>Recibo</th>
                        </tr>
                    </thead>
                    <tbody>${filas}</tbody>
                    ${filaTotales}
                </table>
            </div>
        `;
    }

    // Un renglón de empleado en la planilla. Cada celda numérica con 2 decimales.
    // Los warnings van como ícono ⚠️ con tooltip (title), sin romper la tabla.
    function renderDetailRow(d) {
        const runId = _currentRun ? _currentRun.id : 0;
        const warn = renderWarnings(d.warnings);
        return `
            <tr>
                <td class="payroll-emp">${escapeHtml(d.employee_name || ('Empleado #' + d.employee_id))}${warn}</td>
                <td class="payroll-num">${escapeHtml(fmtMoney(d.sueldo_base))}</td>
                <td class="payroll-num">${escapeHtml(fmtMoney(d.fondos_reserva))}</td>
                <td class="payroll-num">${escapeHtml(fmtMoney(d.decimo_tercero))}</td>
                <td class="payroll-num">${escapeHtml(fmtMoney(d.decimo_cuarto))}</td>
                <td class="payroll-num">${escapeHtml(fmtMoney(d.otros_ingresos + d.horas_extra))}</td>
                <td class="payroll-num payroll-subtotal">${escapeHtml(fmtMoney(d.total_ingresos))}</td>
                <td class="payroll-num">${escapeHtml(fmtMoney(d.aporte_personal))}</td>
                <td class="payroll-num">${escapeHtml(fmtMoney(d.otros_descuentos))}</td>
                <td class="payroll-num payroll-subtotal">${escapeHtml(fmtMoney(d.total_descuentos))}</td>
                <td class="payroll-num payroll-neto"><strong>${escapeHtml(fmtMoney(d.neto_a_pagar))}</strong></td>
                <td class="payroll-num payroll-col-costo" style="display:none;">${escapeHtml(fmtMoney(d.costo_empresa))}</td>
                <td><button class="btn-edit" onclick="payrollAdmin.downloadPdf(${runId}, ${d.employee_id})">PDF</button></td>
            </tr>
        `;
    }

    // Fila de TOTALES al pie (sólo con read.all). Suma desde los totales del run
    // (el backend ya los calculó cuadrados); no los recomputamos en cliente.
    function renderTotalsRow(run) {
        // Si por algún motivo faltara un total, fmtMoney devuelve "—".
        return `
            <tfoot>
                <tr class="payroll-totals-row">
                    <td><strong>TOTALES (${escapeHtml(String(_currentRunDetails.length))} empl.)</strong></td>
                    <td colspan="5"></td>
                    <td class="payroll-num payroll-subtotal"><strong>${escapeHtml(fmtMoney(run.total_ingresos))}</strong></td>
                    <td colspan="2"></td>
                    <td class="payroll-num payroll-subtotal"><strong>${escapeHtml(fmtMoney(run.total_descuentos))}</strong></td>
                    <td class="payroll-num payroll-neto"><strong>${escapeHtml(fmtMoney(run.total_neto))}</strong></td>
                    <td class="payroll-num payroll-col-costo" style="display:none;"><strong>${escapeHtml(fmtMoney(run.total_costo_empresa))}</strong></td>
                    <td></td>
                </tr>
            </tfoot>
        `;
    }

    // Ícono de advertencia con los warnings del renglón en el tooltip. Vacío si
    // no hay warnings. Cada warning escapado (viene del backend / snapshot).
    function renderWarnings(warnings) {
        if (!Array.isArray(warnings) || warnings.length === 0) return '';
        // Unimos los avisos en el title (atributo HTML), todos escapados.
        const texto = warnings.map(w => '• ' + w).join('\n');
        return ` <span class="payroll-warn" title="${escapeHtml(texto)}" aria-label="Avisos">⚠️</span>`;
    }

    // Muestra/oculta TODAS las celdas de la columna "Costo empresa" (header + body
    // + totales) según el checkbox. Es una columna colapsable opcional.
    function toggleCostoEmpresa() {
        const cb = document.getElementById('payroll-toggle-costo');
        const mostrar = cb && cb.checked;
        document.querySelectorAll('#payroll-detail-modal .payroll-col-costo').forEach(el => {
            el.style.display = mostrar ? '' : 'none';
        });
    }

    // ============================================================
    // Descarga del recibo PDF de un empleado (descarga autenticada)
    // ============================================================
    // El endpoint exige el Bearer en el header, así que no podemos abrirlo con
    // un <a href> directo (no lleva token). Patrón del repo: fetch → blob → link
    // temporal → click → revoke. Devuelve el PDF como attachment.
    async function downloadPdf(runId, employeeId) {
        try {
            const r = await fetch(`${PAYROLL_BASE}/runs/${runId}/employee/${employeeId}/pdf`, {
                method: 'GET',
                headers: { ...authHeader() },
                cache: 'no-store'
            });
            if (!r.ok) {
                // El error viene como JSON (404 IDOR, etc.); lo leemos para el mensaje.
                let msg = 'No se pudo descargar el recibo';
                try { msg = (await r.json()).message || msg; } catch { /* respuesta no-JSON */ }
                throw new Error(msg);
            }
            const blob = await r.blob();
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            // Nombre de archivo coherente con el que pone el backend.
            const periodo = _currentRun
                ? `${_currentRun.period_year}-${String(_currentRun.period_month).padStart(2, '0')}`
                : 'rol';
            a.download = `rol-pago-${periodo}-emp${employeeId}.pdf`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            // Liberamos la URL del blob tras un instante (dar tiempo a la descarga).
            setTimeout(() => URL.revokeObjectURL(url), 4000);
            Notification.success('Recibo descargado');
        } catch (err) {
            Notification.error(err.message || 'No se pudo descargar el recibo');
        }
    }

    // ============================================================
    // Pantalla 3: Parámetros (modal con lista + edición auditada)
    // ============================================================

    // Mapea value_type → unidad por defecto y validación, para los mensajes.
    function unidadDeParam(p) {
        if (p.unit) return p.unit;
        if (p.value_type === 'percentage') return '%';
        if (p.value_type === 'money') return 'USD';
        return '';
    }

    async function openParams() {
        document.getElementById('payroll-params-modal').classList.add('active');
        await loadParams();
    }

    async function loadParams() {
        const box = document.getElementById('payroll-params-body');
        box.innerHTML = '<p class="loading">Cargando parámetros...</p>';
        const puedeEditar = tienePermiso(PERM_PARAMS_WRITE);
        try {
            const r = await api('GET', '/params');
            const params = (r.data && r.data.parameters) || [];
            if (params.length === 0) {
                box.innerHTML = '<p class="empty">No hay parámetros configurados.</p>';
                return;
            }
            // Aviso de modo lectura si el user no puede editar.
            const avisoLectura = puedeEditar
                ? ''
                : '<p style="color:var(--text-3); font-size:0.82rem; margin-bottom:0.75rem;">Vista de sólo lectura. La edición de parámetros está reservada a RRHH/Nómina.</p>';

            box.innerHTML = avisoLectura + params.map(p => renderParamCard(p, puedeEditar)).join('');
        } catch (err) {
            box.innerHTML = `<p class="error">${escapeHtml(err.message)}</p>`;
        }
    }

    // Tarjeta de un parámetro: label + valor + unidad + auditoría + botón Editar.
    function renderParamCard(p, puedeEditar) {
        const unidad = unidadDeParam(p);
        const valorMostrado = `${escapeHtml(String(p.value))}${unidad ? ' ' + escapeHtml(unidad) : ''}`;
        // Auditoría: quién y cuándo lo editó por última vez.
        // Si updated_by es null, el parámetro nunca fue editado por un usuario:
        // es el valor inicial sembrado por el sistema. Lo mostramos como tal en
        // vez de "usuario #null" (los seeds traen updated_at pero updated_by null).
        let auditoria;
        if (p.updated_by) {
            const quien = p.updated_by_username || ('usuario #' + p.updated_by);
            auditoria = `Última edición: <strong>${escapeHtml(quien)}</strong> · ${escapeHtml(fmtDateTime(p.updated_at))}`;
        } else {
            auditoria = 'Valor inicial del sistema (sin ediciones).';
        }
        // El botón Editar pasa SÓLO la key (string seguro: el backend valida el
        // patrón snake_case); los demás datos se releen al abrir el formDialog.
        const botonEditar = puedeEditar
            ? `<button class="btn btn-outline btn-sm" onclick="payrollAdmin.editParam('${escapeHtml(p.key).replace(/'/g, "\\'")}')">Editar</button>`
            : '';

        return `
            <div class="payroll-param-card">
                <div class="payroll-param-main">
                    <div>
                        <h5 style="margin:0 0 0.2rem;">${escapeHtml(p.label || p.key)}</h5>
                        ${p.description ? `<p style="margin:0; color:var(--text-3); font-size:0.8rem;">${escapeHtml(p.description)}</p>` : ''}
                    </div>
                    <div class="payroll-param-value">${valorMostrado}</div>
                </div>
                <div class="payroll-param-foot">
                    <small style="color:var(--text-3);">${auditoria}</small>
                    ${botonEditar}
                </div>
            </div>
        `;
    }

    // Edita UN parámetro: relee su definición de la lista cacheada en el DOM no
    // es fiable, así que volvemos a pedir /params para tener el value_type actual
    // y validar bien. (Es una lista chica de 4 ítems; el costo es despreciable.)
    async function editParam(key) {
        try {
            const r = await api('GET', '/params');
            const params = (r.data && r.data.parameters) || [];
            const p = params.find(x => x.key === key);
            if (!p) {
                Notification.error('El parámetro ya no existe.');
                await loadParams();
                return;
            }
            const unidad = unidadDeParam(p);
            const esPorcentaje = p.value_type === 'percentage';
            const ayuda = esPorcentaje
                ? 'Porcentaje entre 0 y 100.'
                : 'Valor numérico mayor o igual a 0.';

            const data = await formDialog({
                title: `Editar: ${p.label || p.key}`,
                description: `${p.description ? p.description + ' ' : ''}${ayuda}${unidad ? ' Unidad: ' + unidad + '.' : ''}`,
                fields: [
                    { name: 'value', label: `Nuevo valor${unidad ? ' (' + unidad + ')' : ''}`, type: 'number', required: true, default: String(p.value) }
                ],
                confirmText: 'Guardar cambio'
            });
            if (!data) return;

            // Validación de cliente (el backend revalida y devuelve 422 si aplica).
            const nuevoValor = Number(data.value);
            if (!Number.isFinite(nuevoValor) || nuevoValor < 0) {
                Notification.error('El valor debe ser un número mayor o igual a 0.');
                return;
            }
            if (esPorcentaje && nuevoValor > 100) {
                Notification.error('Un porcentaje no puede ser mayor a 100.');
                return;
            }

            await api('PUT', `/params/${encodeURIComponent(key)}`, { value: nuevoValor });
            Notification.success('Parámetro actualizado');
            await loadParams();
        } catch (err) {
            // 404 = no existe; 422 = fuera de rango de negocio; 403 = sin permiso.
            Notification.error('No se pudo actualizar: ' + err.message);
        }
    }

    // ============================================================
    // Montaje de la pestaña dentro del switcher de tabs de RRHH
    // ============================================================
    // hr-admin.js maneja los [data-hr-tab]. Para no duplicar/colisionar con su
    // setupTabs(), añadimos NUESTRO listener al botón de la pestaña "payroll":
    // cuando se hace click, activamos nuestra carga. (El switch visual de
    // .active lo hace el setupTabs() de hr-admin.js, que es genérico para todos
    // los [data-hr-tab].) Esto mantiene una sola lógica de conmutación de vistas.
    function setupPayrollTab() {
        const btn = document.querySelector('[data-hr-tab="payroll"]');
        if (btn) btn.addEventListener('click', activate);
    }

    document.addEventListener('DOMContentLoaded', setupPayrollTab);

    // API pública del módulo (la consumen los onclick del markup + la lista).
    return {
        activate,
        loadRuns,
        openGenerateRun,
        finalizeRun,
        deleteDraft,
        openRunDetail,
        downloadPdf,
        toggleCostoEmpresa,
        openParams,
        editParam
    };
})();

// CRÍTICO: exponer payrollAdmin como global. Los onclick="payrollAdmin.xxx(...)"
// generados al renderizar filas/parámetros y los del markup de index.html
// dependen de window.payrollAdmin existiendo. Sin esto, los botones se ven pero
// al clickearlos no pasa nada (ReferenceError silencioso por el IIFE).
window.payrollAdmin = payrollAdmin;
