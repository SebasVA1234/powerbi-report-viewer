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
            const [airR, aerR, cargR] = await Promise.all([
                API.cotizadorListAirports(),
                API.cotizadorListAerolineas(),
                API.cotizadorListCargueras()
            ]);
            const airports = airR.data || [];
            const aerolineas = aerR.data || [];
            const cargueras = cargR.data || [];

            // Origen y destino tienen TODOS los aeropuertos. Ordenamos
            // los selects para poner los más usados arriba: UIO siempre
            // primero como origen (Ecualand exporta principalmente desde
            // Quito); MIA primero como destino (mercado #1 para flores EC).
            const airportOpt = a => `<option value="${a.id}">${escapeHtml(a.iata_code)} — ${escapeHtml(a.city)} (${escapeHtml(a.country)})</option>`;
            const PRIORIDAD_ORIGEN = ['UIO', 'GYE'];          // Ecuador primero
            const PRIORIDAD_DESTINO = ['MIA', 'AMS', 'JFK'];  // top mercados flores
            const ordenarPor = (lista) => (a, b) => {
                const ia = lista.indexOf(a.iata_code);
                const ib = lista.indexOf(b.iata_code);
                const va = ia === -1 ? 1000 + (a.city || '').charCodeAt(0) : ia;
                const vb = ib === -1 ? 1000 + (b.city || '').charCodeAt(0) : ib;
                return va - vb || (a.city || '').localeCompare(b.city || '');
            };
            const orig = document.getElementById('cot-origen');
            const dest = document.getElementById('cot-destino');
            orig.innerHTML = [...airports].sort(ordenarPor(PRIORIDAD_ORIGEN)).map(airportOpt).join('');
            dest.innerHTML = [...airports].sort(ordenarPor(PRIORIDAD_DESTINO)).map(airportOpt).join('');

            const selCarg = document.getElementById('cot-carguera');
            selCarg.innerHTML = cargueras.map(c =>
                `<option value="${c.id}">${escapeHtml(c.nombre)}${c.pais ? ' (' + escapeHtml(c.pais) + ')' : ''}</option>`
            ).join('');

            const selAero = document.getElementById('cot-aerolinea');
            selAero.innerHTML = aerolineas.map(a =>
                `<option value="${a.id}">${escapeHtml(a.nombre)}${a.codigo_iata ? ' (' + escapeHtml(a.codigo_iata) + ')' : ''}</option>`
            ).join('');
        } catch (err) {
            console.error('Error cargando catálogos:', err);
            Notification.error('No se pudieron cargar los catálogos del cotizador');
        }
    }

    function readForm() {
        return {
            cantidad_tallos: parseInt(document.getElementById('cot-tallos').value, 10),
            tallos_por_caja: parseInt(document.getElementById('cot-tallos-caja').value, 10),
            precio_tallo_escenario_1: parseFloat(document.getElementById('cot-precio-1').value),
            precio_tallo_escenario_2: parseFloat(document.getElementById('cot-precio-2').value),
            kilos_totales: document.getElementById('cot-kilos').value || null,
            carguera_id: parseInt(document.getElementById('cot-carguera').value, 10),
            aerolinea_id: parseInt(document.getElementById('cot-aerolinea').value, 10),
            origen_airport_id: parseInt(document.getElementById('cot-origen').value, 10),
            destino_airport_id: parseInt(document.getElementById('cot-destino').value, 10),
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
                <div class="cot-meta-item"><div class="label">Ruta</div><div class="value">${escapeHtml(m.origen.iata)} → ${escapeHtml(m.destino.iata)}</div></div>
                <div class="cot-meta-item"><div class="label">Destino</div><div class="value">${escapeHtml(m.destino.ciudad)}, ${escapeHtml(m.destino.pais)}</div></div>
                <div class="cot-meta-item"><div class="label">Tipo</div><div class="value">${escapeHtml(m.tariff_type || 'contract')}</div></div>
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
                            // v2 metadata.destino.iata; legacy era codigo_iata
                            const dest = m.destino ? (m.destino.iata || m.destino.codigo_iata || '-') : '-';
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

    // ============================================================
    // Toggle "Calcular | Configurar tarifas" (PR-finalize-prototype v2)
    // ============================================================
    // Si el user tiene cotizador.tarifas.manage, aparece el segundo botón.
    async function setupModeToggle() {
        try {
            const tok = Utils.getToken();
            const r = await fetch('/api/rbac/me/context', {
                headers: { Authorization: 'Bearer ' + tok }
            });
            const j = await r.json();
            const perms = (j.data && j.data.permissions) || [];
            const isAdmin = (j.data && j.data.isAdmin) || false;
            const canManage = isAdmin || perms.includes('cotizador.tarifas.manage') || perms.includes('system.admin');
            const btn = document.getElementById('cot-mode-config-btn');
            if (btn) btn.style.display = canManage ? '' : 'none';
        } catch (err) {
            console.warn('No se pudo cargar contexto de permisos:', err);
        }

        document.querySelectorAll('#cotizador-mode-toggle .cot-mode-btn').forEach(b => {
            b.onclick = () => switchMode(b.dataset.mode);
        });
    }

    function switchMode(mode) {
        document.querySelectorAll('#cotizador-mode-toggle .cot-mode-btn').forEach(b => {
            b.classList.toggle('active', b.dataset.mode === mode);
        });
        document.querySelectorAll('#cotizador-section .cot-mode-pane').forEach(p => p.classList.remove('active'));
        const target = document.getElementById('cot-mode-' + mode);
        if (target) target.classList.add('active');
        if (mode === 'configurar' && typeof cotizadorAdmin !== 'undefined') {
            cotizadorAdmin.init();
        }
    }

    // Llamar setupModeToggle dentro del init original
    const origInit = initCotizador;
    window.initCotizador = async function () {
        await origInit();
        await setupModeToggle();
    };
    window.loadCotizacionesHistorico = loadCotizacionesHistorico;
    window.cotizadorSwitchMode = switchMode;
})();
