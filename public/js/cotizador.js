/**
 * Frontend del Cotizador Landed Cost.
 * Conecta el formulario con /api/cotizador y renderiza el resultado en
 * dos escenarios + histórico.
 */
(function () {
    let lastResult = null;          // Resultado del último cálculo (para "Guardar")
    let cataloguesLoaded = false;   // Para no re-pedir destinos/cargueras

    function fmtMoney(n) {
        if (n === null || n === undefined || !Number.isFinite(+n)) return '-';
        return '$' + (+n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }
    function fmtNum(n, dec = 4) {
        if (n === null || n === undefined || !Number.isFinite(+n)) return '-';
        return (+n).toFixed(dec);
    }
    function escapeHtml(str) {
        return String(str || '').replace(/[&<>"']/g, c => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[c]));
    }

    async function initCotizador() {
        if (!cataloguesLoaded) {
            await loadCatalogues();
            cataloguesLoaded = true;
        }
        // Fecha por defecto: hoy
        const fechaInput = document.getElementById('cot-fecha');
        if (fechaInput && !fechaInput.value) {
            fechaInput.value = new Date().toISOString().split('T')[0];
        }
        // Conectar el form (una sola vez)
        const form = document.getElementById('cotizador-form');
        if (form && !form._wired) {
            form.addEventListener('submit', onCalcular);
            form._wired = true;
        }
        const btnGuardar = document.getElementById('cot-guardar-btn');
        if (btnGuardar && !btnGuardar._wired) {
            btnGuardar.addEventListener('click', onGuardar);
            btnGuardar._wired = true;
        }
        // Mostrar mensaje vacío inicial
        renderEmpty();
        // Cargar histórico
        loadCotizacionesHistorico();
    }

    async function loadCatalogues() {
        try {
            const [d, c] = await Promise.all([
                API.cotizadorListDestinos(),
                API.cotizadorListCargueras()
            ]);

            const selDest = document.getElementById('cot-destino');
            selDest.innerHTML = (d.data || []).map(x =>
                `<option value="${x.id}">${escapeHtml(x.codigo_iata)} — ${escapeHtml(x.nombre)}</option>`
            ).join('');

            const selCarg = document.getElementById('cot-carguera');
            selCarg.innerHTML = (c.data || []).map(x =>
                `<option value="${x.id}">${escapeHtml(x.nombre)}</option>`
            ).join('');
        } catch (err) {
            console.error('Error cargando catálogos:', err);
            Notification.error('No se pudieron cargar destinos/cargueras');
        }
    }

    function readForm() {
        return {
            cantidad_tallos: parseInt(document.getElementById('cot-tallos').value, 10),
            tallos_por_caja: parseInt(document.getElementById('cot-tallos-caja').value, 10),
            precio_tallo_escenario_1: parseFloat(document.getElementById('cot-precio-1').value),
            precio_tallo_escenario_2: parseFloat(document.getElementById('cot-precio-2').value),
            kilos_totales: document.getElementById('cot-kilos').value || null,
            id_carguera: parseInt(document.getElementById('cot-carguera').value, 10),
            id_destino: parseInt(document.getElementById('cot-destino').value, 10),
            fecha_proyeccion: document.getElementById('cot-fecha').value
        };
    }

    async function onCalcular(e) {
        e.preventDefault();
        const payload = readForm();
        try {
            const resp = await API.cotizadorCalcular(payload);
            if (resp && resp.success) {
                lastResult = { input: payload, output: resp.data };
                document.getElementById('cot-guardar-btn').disabled = false;
                renderResult(resp.data);
            } else {
                Notification.error((resp && resp.message) || 'Error al calcular');
            }
        } catch (err) {
            Notification.error(err.message || 'Error al calcular');
        }
    }

    async function onGuardar() {
        if (!lastResult) return;
        try {
            const resp = await API.cotizadorGuardar(lastResult.input);
            if (resp && resp.success) {
                Notification.success('Cotización guardada');
                loadCotizacionesHistorico();
            } else {
                Notification.error((resp && resp.message) || 'Error al guardar');
            }
        } catch (err) {
            Notification.error(err.message || 'Error al guardar');
        }
    }

    function renderEmpty() {
        const cont = document.getElementById('cotizador-resultado');
        if (cont && !lastResult) {
            cont.innerHTML = '<h3>Resultado</h3><div class="empty">Llena el formulario y haz click en <strong>Calcular</strong>.</div>';
        }
    }

    function renderResult(data) {
        const cont = document.getElementById('cotizador-resultado');
        if (!cont) return;
        const m = data.metadata;
        const e1 = data.escenarios.escenario_1;
        const e2 = data.escenarios.escenario_2;

        const escenarioBlock = (e, label, klass) => `
            <div class="cot-escenario ${klass}">
                <div class="head">
                    <span>${label}</span>
                    <span>${fmtMoney(e.precio_fob_tallo)}/tallo</span>
                </div>
                <div class="body">
                    <div class="row"><span class="lbl">FOB total</span><span class="val">${fmtMoney(e.desglose_totales.fob_total)}</span></div>
                    <div class="row"><span class="lbl">Flete</span><span class="val">${fmtMoney(e.desglose_totales.costo_flete)}</span></div>
                    <div class="row"><span class="lbl">Costos fijos</span><span class="val">${fmtMoney(e.desglose_totales.costos_fijos)}</span></div>
                    <div class="row"><span class="lbl">Transporte interno</span><span class="val">${fmtMoney(e.desglose_totales.transporte_interno)}</span></div>
                    ${e.desglose_totales.cuarto_frio ? `<div class="row"><span class="lbl">Cuarto frío</span><span class="val">${fmtMoney(e.desglose_totales.cuarto_frio)}</span></div>` : ''}
                    <div class="row"><span class="lbl">Impuestos</span><span class="val">${fmtMoney(e.desglose_totales.impuestos)}</span></div>
                    <div class="row total"><span class="lbl">Gran total</span><span class="val">${fmtMoney(e.desglose_totales.gran_total)}</span></div>
                </div>
                <div class="cot-landed">Landed cost / tallo: ${fmtMoney(e.landed_cost_por_tallo)}</div>
            </div>
        `;

        cont.innerHTML = `
            <h3>Resultado</h3>
            <div class="cot-meta-grid">
                <div class="cot-meta-item"><div class="label">Tallos</div><div class="value">${m.cantidad_tallos.toLocaleString()}</div></div>
                <div class="cot-meta-item"><div class="label">Cajas</div><div class="value">${m.numero_cajas}</div></div>
                <div class="cot-meta-item"><div class="label">Kilos</div><div class="value">${fmtNum(m.kilos_calculados, 2)}</div></div>
                <div class="cot-meta-item"><div class="label">Tarifa flete</div><div class="value">${fmtMoney(m.tarifa_flete_aplicada)}/kg</div></div>
                <div class="cot-meta-item"><div class="label">Destino</div><div class="value">${escapeHtml(m.destino.nombre)} (${escapeHtml(m.destino.codigo_iata)})</div></div>
                <div class="cot-meta-item"><div class="label">Fecha</div><div class="value">${escapeHtml(m.fecha_proyeccion)}</div></div>
            </div>
            <div class="cot-escenarios">
                ${escenarioBlock(e1, 'Escenario 1', 'e1')}
                ${escenarioBlock(e2, 'Escenario 2', 'e2')}
            </div>
        `;
    }

    async function loadCotizacionesHistorico() {
        const cont = document.getElementById('cotizador-historico');
        if (!cont) return;
        try {
            const resp = await API.cotizadorHistorico(20);
            const items = resp.data || [];
            if (items.length === 0) {
                cont.innerHTML = '<div class="cot-hist-empty">Aún no hay cotizaciones guardadas.</div>';
                return;
            }
            cont.innerHTML = `
                <table class="cot-hist-table">
                    <thead>
                        <tr>
                            <th>Fecha</th>
                            <th>Usuario</th>
                            <th>Destino</th>
                            <th>Tallos</th>
                            <th>Landed E1</th>
                            <th>Landed E2</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${items.map(it => {
                            const s = it.snapshot || {};
                            const m = s.metadata || {};
                            const e1 = (s.escenarios && s.escenarios.escenario_1) || {};
                            const e2 = (s.escenarios && s.escenarios.escenario_2) || {};
                            const dest = m.destino ? `${m.destino.codigo_iata}` : '-';
                            return `<tr>
                                <td>${escapeHtml((it.created_at || '').split('T')[0])}</td>
                                <td>${escapeHtml(it.username || '-')}</td>
                                <td>${escapeHtml(dest)}</td>
                                <td>${m.cantidad_tallos ? m.cantidad_tallos.toLocaleString() : '-'}</td>
                                <td>${fmtMoney(e1.landed_cost_por_tallo)}</td>
                                <td>${fmtMoney(e2.landed_cost_por_tallo)}</td>
                            </tr>`;
                        }).join('')}
                    </tbody>
                </table>
            `;
        } catch (err) {
            cont.innerHTML = `<div class="cot-hist-empty">Error: ${escapeHtml(err.message || 'no se pudo cargar histórico')}</div>`;
        }
    }

    // Exponer globals
    window.initCotizador = initCotizador;
    window.loadCotizacionesHistorico = loadCotizacionesHistorico;
})();
