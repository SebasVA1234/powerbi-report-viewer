/**
 * Frontend del Cotizador Landed Cost.
 * Conecta el formulario con /api/cotizador y renderiza el resultado en
 * dos escenarios + histórico.
 */
(function () {
    let lastResult = null;          // Resultado del último cálculo (para "Guardar")
    let cataloguesLoaded = false;   // Para no re-pedir destinos/cargueras
    // PR-5a: cache local de catálogos y tarifas para la cascada de filtros
    // (origen → destino → carguera → aerolínea → tarifa vigente).
    let _airports = [];
    let _cargueras = [];
    let _aerolineas = [];
    let _tarifas = [];
    // Estado de la cotización en curso (ids seleccionados)
    let _state = { origen: null, destino: null, carguera: null, aerolinea: null };
    // Factor de conversión por defecto: 0.056 kg/tallo (mismo que el backend)
    const FACTOR_KG_TALLO = 0.056;

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
        // Fecha por defecto: hoy (input hidden)
        const fechaInput = document.getElementById('cot-fecha');
        if (fechaInput && !fechaInput.value) {
            fechaInput.value = new Date().toISOString().split('T')[0];
        }
        // PR-5a: setup de los 2 autocompletes de aeropuertos. Si origen no está
        // seteado, pre-llena con UIO (Quito) que es el 95% de los envíos.
        setupAirportAutocomplete('origen');
        setupAirportAutocomplete('destino');
        preselectAirportByIata('origen', 'UIO');

        // Conectar form + listeners de cascada
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
        // Cambios en carguera/aerolínea actualizan el state y la tarjeta de tarifa
        const selCarg = document.getElementById('cot-carguera');
        const selAero = document.getElementById('cot-aerolinea');
        if (selCarg && !selCarg._wired) {
            selCarg.addEventListener('change', () => {
                _state.carguera = parseInt(selCarg.value, 10) || null;
                refreshAerolineas();   // filtrar aerolíneas válidas para esta carguera+ruta
                refreshTarifaCard();
            });
            selCarg._wired = true;
        }
        if (selAero && !selAero._wired) {
            selAero.addEventListener('change', () => {
                _state.aerolinea = parseInt(selAero.value, 10) || null;
                refreshTarifaCard();
            });
            selAero._wired = true;
        }

        // Cascada inicial cuando ya hay origen pre-seleccionado
        refreshCargueras();
        refreshTarifaCard();

        renderEmpty();
        loadCotizacionesHistorico();
    }

    async function loadCatalogues() {
        try {
            const [airR, aerR, cargR, tarR] = await Promise.all([
                API.cotizadorListAirports(),
                API.cotizadorListAerolineas(),
                API.cotizadorListCargueras(),
                API.cotizadorListTarifas ? API.cotizadorListTarifas() : fetch('/api/cotizador/tarifas', {
                    headers: { Authorization: 'Bearer ' + Utils.getToken() }
                }).then(r => r.json())
            ]);
            _airports = airR.data || [];
            _aerolineas = aerR.data || [];
            _cargueras = cargR.data || [];
            _tarifas = (tarR && tarR.data) || [];
        } catch (err) {
            console.error('Error cargando catálogos:', err);
            Notification.error('No se pudieron cargar los catálogos del cotizador');
        }
    }

    // --------------------------------------------------------------------
    // PR-5a: Autocomplete de aeropuertos. Filtra _airports por texto en
    // ciudad, nombre o IATA. Cada resultado muestra: nombre + ciudad/país
    // + pill IATA a la derecha (igual al mockup).
    // --------------------------------------------------------------------
    function setupAirportAutocomplete(role) {
        const field = document.querySelector(`.cot-airport-field[data-airport-role="${role}"]`);
        if (!field || field._wired) return;
        const input  = field.querySelector('[data-airport-input]');
        const search = field.querySelector('.cot-airport-search');
        const list   = field.querySelector('.cot-airport-results');
        const hidden = document.getElementById(`cot-${role}-id`);

        function renderList(query) {
            const q = (query || '').toLowerCase().trim();
            const matches = _airports.filter(a => {
                if (!q) return true;
                return (a.iata_code || '').toLowerCase().includes(q)
                    || (a.city || '').toLowerCase().includes(q)
                    || (a.name || '').toLowerCase().includes(q)
                    || (a.country || '').toLowerCase().includes(q);
            }).slice(0, 50);
            if (matches.length === 0) {
                list.innerHTML = '<div class="cot-airport-no-results">Sin resultados</div>';
                return;
            }
            list.innerHTML = matches.map(a => `
                <div class="cot-airport-result" data-airport-id="${a.id}">
                    <div class="cot-airport-result-main">
                        <div class="cot-airport-result-name">${escapeHtml(a.name || a.city || 'Aeropuerto')}</div>
                        <div class="cot-airport-result-location">${escapeHtml(a.city || '')}${a.country ? ', ' + escapeHtml(a.country) : ''}</div>
                    </div>
                    <span class="cot-airport-result-iata">${escapeHtml(a.iata_code)}</span>
                </div>
            `).join('');
        }

        function selectAirport(airport) {
            hidden.value = airport.id;
            const text = `${airport.city || airport.name} — ${airport.iata_code}${airport.country ? ' — ' + airport.country : ''}`;
            const sel = input.querySelector('.cot-airport-text');
            sel.textContent = text;
            sel.classList.remove('placeholder');
            field.classList.remove('open');
            _state[role] = airport.id;
            refreshCargueras();
            refreshTarifaCard();
            updateWeightEstimate();
            updateCalcButtonState();
        }

        input.addEventListener('click', () => {
            field.classList.toggle('open');
            if (field.classList.contains('open')) {
                renderList(search.value);
                setTimeout(() => search.focus(), 50);
            }
        });
        search.addEventListener('input', () => renderList(search.value));
        list.addEventListener('click', (e) => {
            const row = e.target.closest('.cot-airport-result');
            if (!row) return;
            const id = parseInt(row.dataset.airportId, 10);
            const airport = _airports.find(a => a.id === id);
            if (airport) selectAirport(airport);
        });
        // Click fuera cierra el dropdown
        document.addEventListener('click', (e) => {
            if (!field.contains(e.target)) field.classList.remove('open');
        });
        field._wired = true;
    }

    function preselectAirportByIata(role, iata) {
        const a = _airports.find(x => x.iata_code === iata);
        if (!a) return;
        const field = document.querySelector(`.cot-airport-field[data-airport-role="${role}"]`);
        if (!field) return;
        document.getElementById(`cot-${role}-id`).value = a.id;
        const sel = field.querySelector('.cot-airport-text');
        sel.textContent = `${a.city || a.name} — ${a.iata_code}${a.country ? ' — ' + a.country : ''}`;
        sel.classList.remove('placeholder');
        _state[role] = a.id;
    }

    // --------------------------------------------------------------------
    // PR-5a: Cascada de filtros. La tarifa NO depende solo de la aerolínea —
    // la misma aerolínea con dos cargueras distintas tiene tarifas distintas
    // (la negociación es con la carguera). Por eso filtramos en orden:
    //   origen + destino → cargueras válidas
    //   carguera + ruta  → aerolíneas válidas
    //   todo lo anterior → tarjeta de tarifa vigente
    // --------------------------------------------------------------------
    function tariffsForRoute() {
        if (!_state.origen || !_state.destino) return [];
        return _tarifas.filter(t =>
            Number(t.origen_airport_id) === Number(_state.origen) &&
            Number(t.destino_airport_id) === Number(_state.destino) &&
            t.is_active !== 0
        );
    }

    function refreshCargueras() {
        const sel = document.getElementById('cot-carguera');
        if (!sel) return;
        const validCargIds = new Set(tariffsForRoute().map(t => Number(t.carguera_id)));
        const visibles = _cargueras.filter(c => validCargIds.size === 0 || validCargIds.has(Number(c.id)));
        const opts = ['<option value="">— Elegí carguera —</option>'];
        for (const c of visibles) {
            const selected = Number(c.id) === Number(_state.carguera) ? 'selected' : '';
            opts.push(`<option value="${c.id}" ${selected}>${escapeHtml(c.nombre)}${c.pais ? ' (' + escapeHtml(c.pais) + ')' : ''}</option>`);
        }
        sel.innerHTML = opts.join('');
        if (!visibles.find(c => Number(c.id) === Number(_state.carguera))) {
            _state.carguera = null;
            sel.value = '';
        }
        refreshAerolineas();
    }

    function refreshAerolineas() {
        const sel = document.getElementById('cot-aerolinea');
        if (!sel) return;
        let validAeroIds;
        if (_state.carguera) {
            validAeroIds = new Set(
                tariffsForRoute()
                    .filter(t => Number(t.carguera_id) === Number(_state.carguera))
                    .map(t => Number(t.aerolinea_id))
            );
        } else {
            validAeroIds = new Set(tariffsForRoute().map(t => Number(t.aerolinea_id)));
        }
        const visibles = _aerolineas.filter(a => validAeroIds.size === 0 || validAeroIds.has(Number(a.id)));
        const opts = ['<option value="">— Elegí aerolínea —</option>'];
        for (const a of visibles) {
            const selected = Number(a.id) === Number(_state.aerolinea) ? 'selected' : '';
            opts.push(`<option value="${a.id}" ${selected}>${escapeHtml(a.nombre)}${a.codigo_iata ? ' (' + escapeHtml(a.codigo_iata) + ')' : ''}</option>`);
        }
        sel.innerHTML = opts.join('');
        if (!visibles.find(a => Number(a.id) === Number(_state.aerolinea))) {
            _state.aerolinea = null;
            sel.value = '';
        }
    }

    function refreshTarifaCard() {
        const card = document.getElementById('cot-tarifa-card');
        if (!card) return;
        if (!_state.origen || !_state.destino) {
            card.style.display = 'none';
            return;
        }
        if (!_state.carguera) {
            card.style.display = 'block';
            card.className = 'cot-tarifa-card';
            const count = tariffsForRoute().length;
            card.innerHTML = count > 0
                ? `<strong>${count}</strong> carguera(s) con tarifa configurada para esta ruta. Elegí una para ver el detalle.`
                : `Sin tarifas configuradas para esta ruta. <a href="#" onclick="event.preventDefault(); switchToTariffsConfig && switchToTariffsConfig();" style="color:inherit; text-decoration:underline;">Configurar tarifas</a>.`;
            if (count === 0) card.classList.add('warning');
            return;
        }
        // Carguera elegida — buscar tarifa(s) específicas
        const rutaCargTariffs = tariffsForRoute().filter(t => Number(t.carguera_id) === Number(_state.carguera));
        let candidates = rutaCargTariffs;
        if (_state.aerolinea) {
            candidates = candidates.filter(t => Number(t.aerolinea_id) === Number(_state.aerolinea));
        }
        if (candidates.length === 0) {
            card.style.display = 'block';
            card.className = 'cot-tarifa-card warning';
            card.innerHTML = `<strong>Sin tarifa configurada</strong> para esta combinación carguera × aerolínea × ruta. Probá otra combinación o contactá al admin.`;
            return;
        }
        // Tomamos la primera vigente que cubra el peso estimado
        const pesoEst = estimatedWeight() || 100;
        const vigente = candidates.find(t => {
            const min = Number(t.peso_minimo) || 0;
            const max = Number(t.peso_maximo) || Infinity;
            return pesoEst >= min && pesoEst <= max;
        }) || candidates[0];

        const carg = _cargueras.find(c => Number(c.id) === Number(vigente.carguera_id));
        const aero = _aerolineas.find(a => Number(a.id) === Number(vigente.aerolinea_id));
        const validez = vigente.validity_to ? `Válida hasta ${formatDate(vigente.validity_to)}` : 'Sin fecha de vencimiento';
        const rango = (vigente.peso_minimo != null && vigente.peso_maximo != null)
            ? `${vigente.peso_minimo}–${vigente.peso_maximo} kg`
            : 'Sin rango de peso';

        card.style.display = 'block';
        card.className = 'cot-tarifa-card';
        card.innerHTML = `
            <div><span class="cot-tarifa-rate">${fmtMoney(vigente.tarifa_kilo)}/kg</span>para envíos ${rango}</div>
            <div class="cot-tarifa-meta">
                ${carg ? escapeHtml(carg.nombre) : ''}${aero ? ' vía ' + escapeHtml(aero.nombre) : ''} · ${validez}
            </div>
        `;
    }

    function formatDate(d) {
        if (!d) return '';
        try {
            const dt = new Date(d);
            if (isNaN(dt)) return String(d).substring(0, 10);
            return dt.toLocaleDateString('es-EC', { month: 'short', year: 'numeric' });
        } catch { return String(d).substring(0, 10); }
    }

    function estimatedWeight() {
        const tallos = parseInt(document.getElementById('cot-tallos').value, 10) || 0;
        const manualKilos = parseFloat(document.getElementById('cot-kilos').value);
        if (!isNaN(manualKilos) && manualKilos > 0) return manualKilos;
        return tallos * FACTOR_KG_TALLO;
    }

    function updateWeightEstimate() {
        const span = document.getElementById('cot-weight-estimate');
        if (!span) return;
        const tallos = parseInt(document.getElementById('cot-tallos').value, 10) || 0;
        if (tallos > 0) {
            const peso = (tallos * FACTOR_KG_TALLO).toFixed(0);
            span.textContent = `Peso estimado: ${peso} kg (${tallos.toLocaleString()} tallos × ${FACTOR_KG_TALLO} kg)`;
        } else {
            span.textContent = '';
        }
    }

    function updateCalcButtonState() {
        // Habilita el botón sólo si todos los campos requeridos están llenos
        const btn = document.getElementById('cot-calc-btn');
        if (!btn) return;
        const tallos     = parseInt(document.getElementById('cot-tallos').value, 10);
        const tallosCaja = parseInt(document.getElementById('cot-tallos-caja').value, 10);
        const p1         = parseFloat(document.getElementById('cot-precio-1').value);
        const p2         = parseFloat(document.getElementById('cot-precio-2').value);
        const ok = Number.isFinite(tallos) && tallos > 0
                && Number.isFinite(tallosCaja) && tallosCaja > 0
                && Number.isFinite(p1) && p1 > 0
                && Number.isFinite(p2) && p2 > 0
                && _state.origen && _state.destino
                && _state.carguera && _state.aerolinea;
        btn.disabled = !ok;
    }

    // Listeners para los campos numéricos de la sección 3
    document.addEventListener('input', (e) => {
        if (e.target.matches('#cot-tallos, #cot-tallos-caja, #cot-precio-1, #cot-precio-2, #cot-kilos')) {
            updateWeightEstimate();
            updateCalcButtonState();
            if (e.target.id === 'cot-tallos') refreshTarifaCard();
        }
    });

    function readForm() {
        return {
            cantidad_tallos: parseInt(document.getElementById('cot-tallos').value, 10),
            tallos_por_caja: parseInt(document.getElementById('cot-tallos-caja').value, 10),
            precio_tallo_escenario_1: parseFloat(document.getElementById('cot-precio-1').value),
            precio_tallo_escenario_2: parseFloat(document.getElementById('cot-precio-2').value),
            kilos_totales: document.getElementById('cot-kilos').value || null,
            carguera_id: parseInt(document.getElementById('cot-carguera').value, 10),
            aerolinea_id: parseInt(document.getElementById('cot-aerolinea').value, 10),
            origen_airport_id: parseInt(document.getElementById('cot-origen-id').value, 10),
            destino_airport_id: parseInt(document.getElementById('cot-destino-id').value, 10),
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
