/**
 * Cotizador · módulo "Configurar tarifas" (PR-finalize-prototype v2).
 *
 * Solo se monta si el user tiene el permiso cotizador.tarifas.manage.
 * Maneja 4 sub-tabs:
 *   - Tarifas de flete: filas pricing-row estilo antigravity con inputs
 *     inline para tarifa/kg, cuarto frío y doc fijo. Save no-op si nada cambió.
 *   - Costos por país: una fila por país (USA, Holanda, etc.) con aduana,
 *     transporte interno, % arancel, % IVA, rubros JSON.
 *   - Catálogos: 3 sub-sub-tabs (aeropuertos / aerolíneas / cargueras) con CRUD.
 *   - Auditoría: lista del tariff_changes_log en orden DESC.
 *
 * Usa formDialog/confirmDialog (window.*) del confirm-dialog.js.
 */
const cotizadorAdmin = (function () {
    let _airports = [], _aerolineas = [], _cargueras = [], _tarifas = [], _paises = [];
    let _initialized = false;

    function escapeHtml(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
    function fmtMoney(n) {
        if (n === null || n === undefined) return '-';
        return '$' + (+n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }
    function fmtDateTime(s) {
        if (!s) return '';
        return String(s).replace('T', ' ').slice(0, 16);
    }

    async function init() {
        if (!_initialized) {
            setupSubTabs();
            _initialized = true;
        }
        await loadAll();
    }

    async function loadAll() {
        try {
            const [airR, aerR, cargR, tarR, paisR] = await Promise.all([
                API.cotizadorListAirports(),
                API.cotizadorListAerolineas(),
                API.cotizadorListCargueras(),
                API.cotizadorListTarifas(),
                API.cotizadorListTarifasPais()
            ]);
            _airports   = airR.data  || [];
            _aerolineas = aerR.data  || [];
            _cargueras  = cargR.data || [];
            _tarifas    = tarR.data  || [];
            _paises     = paisR.data || [];

            renderTarifas();
            renderPaises();
            renderAirports();
            renderAerolineas();
            renderCargueras();
        } catch (err) {
            Notification.error('Error cargando datos: ' + (err.message || err));
        }
    }

    function setupSubTabs() {
        // Sub-tabs principales (Tarifas / Países / Catálogos / Auditoría)
        document.querySelectorAll('#cot-mode-configurar > .admin-tabs > [data-tarifas-tab]').forEach(b => {
            b.onclick = () => {
                document.querySelectorAll('#cot-mode-configurar > .admin-tabs > [data-tarifas-tab]').forEach(x => x.classList.remove('active'));
                b.classList.add('active');
                const id = b.dataset.tarifasTab;
                ['tarifas','paises','catalogos','auditoria'].forEach(name => {
                    const el = document.getElementById('cot-' + name + '-tab');
                    if (el) el.classList.toggle('active', name === id);
                });
                if (id === 'auditoria') loadAuditLog();
            };
        });
        // Sub-sub-tabs de Catálogos
        document.querySelectorAll('#cot-catalogos-tab > .admin-tabs > [data-cat-tab]').forEach(b => {
            b.onclick = () => {
                document.querySelectorAll('#cot-catalogos-tab > .admin-tabs > [data-cat-tab]').forEach(x => x.classList.remove('active'));
                b.classList.add('active');
                const id = b.dataset.catTab;
                ['airports','aerolineas','cargueras'].forEach(name => {
                    const el = document.getElementById('cot-cat-' + name);
                    if (el) el.classList.toggle('active', name === id);
                });
            };
        });
    }

    // ------------------------------------------------------------
    // TARIFAS (pricing-row style)
    // ------------------------------------------------------------
    function renderTarifas() {
        const cont = document.getElementById('cot-tarifas-list');
        if (_tarifas.length === 0) {
            cont.innerHTML = `<div class="empty-state" style="padding:2rem;">
                <p>No hay tarifas configuradas todavía.</p>
                <button class="btn btn-primary" onclick="cotizadorAdmin.openCreateTarifa()">+ Crear primera tarifa</button>
            </div>`;
            return;
        }
        cont.innerHTML = _tarifas.map(t => `
            <div class="pricing-row" data-tarifa-id="${t.id}">
                <div class="pricing-flight-info">
                    <div class="airline-badge">${escapeHtml(t.aerolinea_iata || 'XX')}</div>
                    <div>
                        <div class="pricing-route">${escapeHtml(t.origen_iata)} → ${escapeHtml(t.destino_iata)}</div>
                        <div class="pricing-flight-num">${escapeHtml(t.carguera_nombre)} · ${escapeHtml(t.aerolinea_nombre)} · ${t.peso_minimo}–${t.peso_maximo} kg · <span class="badge badge-info">${escapeHtml(t.tariff_type)}</span></div>
                    </div>
                </div>
                <div class="pricing-controls">
                    <div class="rate-input-wrapper" title="Tarifa por kilo">
                        <span>$</span>
                        <input type="number" class="rate-input" data-field="tarifa_kilo" value="${t.tarifa_kilo}" step="0.01" min="0">
                        <span>/kg</span>
                    </div>
                    <div class="rate-input-wrapper" title="Cuarto frío">
                        <span>❄️</span>
                        <input type="number" class="rate-input" data-field="costo_cuarto_frio_kilo" value="${t.costo_cuarto_frio_kilo}" step="0.01" min="0">
                    </div>
                    <div class="rate-input-wrapper" title="Documentación fija">
                        <span>📄</span>
                        <input type="number" class="rate-input" data-field="costo_documentacion_fijo" value="${t.costo_documentacion_fijo}" step="1" min="0">
                    </div>
                    <button class="btn-save-rate" onclick="cotizadorAdmin.saveTarifa(${t.id})">Aplicar</button>
                    <button class="btn-delete" onclick="cotizadorAdmin.deleteTarifa(${t.id}, '${escapeHtml(t.carguera_nombre)} ${escapeHtml(t.origen_iata)}→${escapeHtml(t.destino_iata)}')">Borrar</button>
                </div>
            </div>
        `).join('');
    }

    async function saveTarifa(id) {
        const row = document.querySelector(`.pricing-row[data-tarifa-id="${id}"]`);
        if (!row) return;
        const payload = {};
        row.querySelectorAll('.rate-input').forEach(i => {
            payload[i.dataset.field] = parseFloat(i.value);
        });
        try {
            const r = await API.cotizadorUpdateTarifa(id, payload);
            if (r && r.success) {
                Notification.success('Tarifa actualizada');
                await loadAll();
            } else {
                Notification.error(r.message || 'Error al guardar');
            }
        } catch (err) {
            Notification.error(err.message || 'Error al guardar tarifa');
        }
    }

    async function deleteTarifa(id, label) {
        const ok = await confirmDialog({
            title: '¿Borrar tarifa?',
            message: `Vas a borrar la tarifa de ${label}. Las cotizaciones que ya la usaron no se afectan, pero ya no se podrá cotizar con ella.`,
            confirmText: 'Borrar tarifa',
            typeToConfirm: 'ELIMINAR'
        });
        if (!ok) return;
        try {
            await API.cotizadorDeleteTarifa(id);
            Notification.success('Tarifa eliminada');
            await loadAll();
        } catch (err) {
            Notification.error(err.message || 'Error al borrar');
        }
    }

    async function openCreateTarifa() {
        if (_cargueras.length === 0 || _aerolineas.length === 0 || _airports.length === 0) {
            await loadAll();
        }
        const data = await formDialog({
            title: 'Nueva tarifa de flete',
            description: 'Una tarifa por combinación de carguera + aerolínea + ruta + rango de peso + tipo. Si ya existe esa combinación, te avisará.',
            fields: [
                { name: 'carguera_id', label: 'Carguera', type: 'select', required: true,
                  options: _cargueras.map(c => ({ value: c.id, label: `${c.nombre} (${c.pais || '-'})` })) },
                { name: 'aerolinea_id', label: 'Aerolínea', type: 'select', required: true,
                  options: _aerolineas.map(a => ({ value: a.id, label: `${a.nombre}${a.codigo_iata ? ' (' + a.codigo_iata + ')' : ''}` })) },
                { name: 'origen_airport_id', label: 'Aeropuerto origen', type: 'select', required: true,
                  default: (_airports.find(a => a.iata_code === 'UIO') || {}).id,
                  options: _airports.map(a => ({ value: a.id, label: `${a.iata_code} — ${a.city} (${a.country})` })) },
                { name: 'destino_airport_id', label: 'Aeropuerto destino', type: 'select', required: true,
                  options: _airports.map(a => ({ value: a.id, label: `${a.iata_code} — ${a.city} (${a.country})` })) },
                { name: 'peso_minimo', label: 'Peso mínimo (kg)', type: 'number', default: '0' },
                { name: 'peso_maximo', label: 'Peso máximo (kg)', type: 'number', default: '999999' },
                { name: 'tarifa_kilo', label: 'Tarifa $/kg', type: 'number', required: true, default: '3.50' },
                { name: 'costo_cuarto_frio_kilo', label: 'Cuarto frío $/kg (opcional)', type: 'number', default: '0' },
                { name: 'costo_documentacion_fijo', label: 'Documentación $ fijo (opcional)', type: 'number', default: '0' },
                { name: 'tariff_type', label: 'Tipo de tarifa', type: 'select', default: 'contract',
                  options: [
                    { value: 'contract', label: 'Contract (negociada)' },
                    { value: 'spot',     label: 'Spot (mercado)' },
                    { value: 'promo',    label: 'Promo (limitada)' }
                  ] },
                { name: 'notas', label: 'Notas', type: 'textarea', placeholder: 'Opcional' }
            ],
            confirmText: 'Crear tarifa'
        });
        if (!data) return;
        const payload = {
            carguera_id: Number(data.carguera_id),
            aerolinea_id: Number(data.aerolinea_id),
            origen_airport_id: Number(data.origen_airport_id),
            destino_airport_id: Number(data.destino_airport_id),
            peso_minimo: Number(data.peso_minimo) || 0,
            peso_maximo: Number(data.peso_maximo) || 999999,
            tarifa_kilo: Number(data.tarifa_kilo),
            costo_cuarto_frio_kilo: Number(data.costo_cuarto_frio_kilo) || 0,
            costo_documentacion_fijo: Number(data.costo_documentacion_fijo) || 0,
            tariff_type: data.tariff_type,
            notas: data.notas || null
        };
        try {
            const r = await API.cotizadorCreateTarifa(payload);
            if (r && r.success) {
                Notification.success('Tarifa creada');
                await loadAll();
            } else {
                Notification.error(r.message || 'Error al crear');
            }
        } catch (err) {
            Notification.error(err.message || 'Error al crear tarifa');
        }
    }

    // ------------------------------------------------------------
    // COSTOS POR PAÍS (inline editable rows)
    // ------------------------------------------------------------
    function renderPaises() {
        const cont = document.getElementById('cot-paises-list');
        if (_paises.length === 0) {
            cont.innerHTML = '<div class="empty">Sin países configurados.</div>';
            return;
        }
        cont.innerHTML = _paises.map(p => `
            <div class="pricing-row" data-pais-code="${escapeHtml(p.country_code)}">
                <div class="pricing-flight-info">
                    <div class="airline-badge">${escapeHtml(p.country_code)}</div>
                    <div>
                        <div class="pricing-route">${escapeHtml(p.country_name)}</div>
                        <div class="pricing-flight-num">Costos del país de destino</div>
                    </div>
                </div>
                <div class="pricing-controls">
                    <div class="rate-input-wrapper" title="Aduana fija">
                        <span>🛃</span>
                        <input type="number" class="pais-input" data-field="aduana_fija" value="${p.aduana_fija}" step="1" min="0">
                        <span>$</span>
                    </div>
                    <div class="rate-input-wrapper" title="Transporte interno por caja">
                        <span>🚚</span>
                        <input type="number" class="pais-input" data-field="transporte_interno_caja" value="${p.transporte_interno_caja}" step="0.5" min="0">
                        <span>/caja</span>
                    </div>
                    <div class="rate-input-wrapper" title="Arancel %">
                        <input type="number" class="pais-input" data-field="porcentaje_arancel" value="${p.porcentaje_arancel}" step="0.01" min="0" style="width:55px;">
                        <span>% Arancel</span>
                    </div>
                    <div class="rate-input-wrapper" title="Impuesto consumo %">
                        <input type="number" class="pais-input" data-field="porcentaje_impuesto_consumo" value="${p.porcentaje_impuesto_consumo}" step="0.01" min="0" style="width:55px;">
                        <span>% IVA</span>
                    </div>
                    <button class="btn-save-rate" onclick="cotizadorAdmin.savePais('${escapeHtml(p.country_code)}', '${escapeHtml(p.country_name)}')">Aplicar</button>
                </div>
            </div>
        `).join('');
    }

    async function savePais(code, name) {
        const row = document.querySelector(`.pricing-row[data-pais-code="${code}"]`);
        if (!row) return;
        const payload = { country_code: code, country_name: name };
        row.querySelectorAll('.pais-input').forEach(i => {
            payload[i.dataset.field] = parseFloat(i.value) || 0;
        });
        try {
            const r = await API.cotizadorUpsertTarifaPais(payload);
            if (r && r.success) {
                Notification.success(`Costos de ${name} actualizados`);
                await loadAll();
            } else {
                Notification.error(r.message || 'Error al guardar');
            }
        } catch (err) {
            Notification.error(err.message || 'Error al guardar costos');
        }
    }

    // ------------------------------------------------------------
    // CATÁLOGOS (Aeropuertos / Aerolíneas / Cargueras)
    // ------------------------------------------------------------
    function renderAirports() {
        const cont = document.getElementById('cot-airports-list');
        if (_airports.length === 0) { cont.innerHTML = '<div class="empty">Sin aeropuertos.</div>'; return; }
        cont.innerHTML = `
            <div class="table-container">
                <table class="data-table">
                    <thead>
                        <tr><th>IATA</th><th>Nombre</th><th>Ciudad</th><th>País</th><th>Cód. país</th><th>Acciones</th></tr>
                    </thead>
                    <tbody>
                        ${_airports.map(a => `
                            <tr>
                                <td><strong>${escapeHtml(a.iata_code)}</strong></td>
                                <td>${escapeHtml(a.name)}</td>
                                <td>${escapeHtml(a.city)}</td>
                                <td>${escapeHtml(a.country)}</td>
                                <td><code>${escapeHtml(a.country_code)}</code></td>
                                <td>
                                    <button class="btn-edit" onclick="cotizadorAdmin.openEditCatalog('airport', ${a.id})">Editar</button>
                                    <button class="btn-delete" onclick="cotizadorAdmin.deleteCatalog('airport', ${a.id}, '${escapeHtml(a.iata_code)}')">Archivar</button>
                                </td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            </div>
        `;
    }

    function renderAerolineas() {
        const cont = document.getElementById('cot-aerolineas-list');
        if (_aerolineas.length === 0) { cont.innerHTML = '<div class="empty">Sin aerolíneas.</div>'; return; }
        cont.innerHTML = `
            <div class="table-container">
                <table class="data-table">
                    <thead>
                        <tr><th>IATA</th><th>Nombre</th><th>País</th><th>Acciones</th></tr>
                    </thead>
                    <tbody>
                        ${_aerolineas.map(a => `
                            <tr>
                                <td><strong>${escapeHtml(a.codigo_iata || '-')}</strong></td>
                                <td>${escapeHtml(a.nombre)}</td>
                                <td><code>${escapeHtml(a.codigo_pais || '-')}</code></td>
                                <td>
                                    <button class="btn-edit" onclick="cotizadorAdmin.openEditCatalog('aerolinea', ${a.id})">Editar</button>
                                    <button class="btn-delete" onclick="cotizadorAdmin.deleteCatalog('aerolinea', ${a.id}, '${escapeHtml(a.nombre)}')">Archivar</button>
                                </td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            </div>
        `;
    }

    function renderCargueras() {
        const cont = document.getElementById('cot-cargueras-list');
        if (_cargueras.length === 0) { cont.innerHTML = '<div class="empty">Sin cargueras.</div>'; return; }
        cont.innerHTML = `
            <div class="table-container">
                <table class="data-table">
                    <thead>
                        <tr><th>Nombre</th><th>País</th><th>Email</th><th>Contacto</th><th>Acciones</th></tr>
                    </thead>
                    <tbody>
                        ${_cargueras.map(c => `
                            <tr>
                                <td><strong>${escapeHtml(c.nombre)}</strong></td>
                                <td>${escapeHtml(c.pais || '-')}</td>
                                <td>${escapeHtml(c.email || '-')}</td>
                                <td>${escapeHtml(c.contacto || '-')}</td>
                                <td>
                                    <button class="btn-edit" onclick="cotizadorAdmin.openEditCatalog('carguera', ${c.id})">Editar</button>
                                    <button class="btn-delete" onclick="cotizadorAdmin.deleteCatalog('carguera', ${c.id}, '${escapeHtml(c.nombre)}')">Archivar</button>
                                </td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            </div>
        `;
    }

    function catalogFields(kind, prefill = {}) {
        if (kind === 'airport') {
            return [
                { name: 'iata_code', label: 'Código IATA (3 letras)', type: 'text', required: true, default: prefill.iata_code },
                { name: 'name',      label: 'Nombre del aeropuerto',  type: 'text', required: true, default: prefill.name },
                { name: 'city',      label: 'Ciudad',                  type: 'text', required: true, default: prefill.city },
                { name: 'country',   label: 'País (nombre)',           type: 'text', required: true, default: prefill.country },
                { name: 'country_code', label: 'Código país (ISO 2 letras: US, NL, RU, etc.)', type: 'text', required: true, default: prefill.country_code }
            ];
        }
        if (kind === 'aerolinea') {
            return [
                { name: 'nombre',      label: 'Nombre',                 type: 'text', required: true, default: prefill.nombre },
                { name: 'codigo_iata', label: 'Código IATA (2 letras)', type: 'text', default: prefill.codigo_iata },
                { name: 'codigo_pais', label: 'Código país (ISO 2)',    type: 'text', default: prefill.codigo_pais }
            ];
        }
        if (kind === 'carguera') {
            return [
                { name: 'nombre',   label: 'Nombre',   type: 'text', required: true, default: prefill.nombre },
                { name: 'pais',     label: 'País',     type: 'text', default: prefill.pais },
                { name: 'email',    label: 'Email',    type: 'text', default: prefill.email },
                { name: 'contacto', label: 'Contacto', type: 'text', default: prefill.contacto }
            ];
        }
        return [];
    }

    async function openCreateCatalog(kind) {
        const titles = { airport: 'Nuevo aeropuerto', aerolinea: 'Nueva aerolínea', carguera: 'Nueva carguera' };
        const data = await formDialog({
            title: titles[kind] || 'Nuevo',
            fields: catalogFields(kind),
            confirmText: 'Crear'
        });
        if (!data) return;
        try {
            const fn = kind === 'airport' ? API.cotizadorCreateAirport
                     : kind === 'aerolinea' ? API.cotizadorCreateAerolinea
                     : API.cotizadorCreateCarguera;
            const r = await fn(data);
            if (r && r.success) {
                Notification.success('Creado');
                await loadAll();
            } else {
                Notification.error(r.message || 'Error');
            }
        } catch (err) {
            Notification.error(err.message || 'Error al crear');
        }
    }

    async function openEditCatalog(kind, id) {
        const list = kind === 'airport' ? _airports : kind === 'aerolinea' ? _aerolineas : _cargueras;
        const item = list.find(x => x.id === id);
        if (!item) return;
        const titles = { airport: 'Editar aeropuerto', aerolinea: 'Editar aerolínea', carguera: 'Editar carguera' };
        const data = await formDialog({
            title: titles[kind] + ': ' + (item.nombre || item.iata_code),
            fields: catalogFields(kind, item),
            confirmText: 'Guardar cambios'
        });
        if (!data) return;
        try {
            const fn = kind === 'airport' ? API.cotizadorUpdateAirport
                     : kind === 'aerolinea' ? API.cotizadorUpdateAerolinea
                     : API.cotizadorUpdateCarguera;
            const r = await fn(id, data);
            if (r && r.success) {
                Notification.success('Actualizado');
                await loadAll();
            } else {
                Notification.error(r.message || 'Error');
            }
        } catch (err) {
            Notification.error(err.message || 'Error al actualizar');
        }
    }

    async function deleteCatalog(kind, id, label) {
        const ok = await confirmDialog({
            title: `¿Archivar ${kind === 'airport' ? 'aeropuerto' : kind === 'aerolinea' ? 'aerolínea' : 'carguera'}?`,
            message: `Vas a archivar "${label}". Las tarifas que lo referencian siguen funcionando, pero ya no aparecerá en los selects nuevos.`,
            confirmText: 'Archivar'
        });
        if (!ok) return;
        try {
            const fn = kind === 'airport' ? API.cotizadorDeleteAirport
                     : kind === 'aerolinea' ? API.cotizadorDeleteAerolinea
                     : API.cotizadorDeleteCarguera;
            await fn(id);
            Notification.success('Archivado');
            await loadAll();
        } catch (err) {
            Notification.error(err.message || 'Error al archivar');
        }
    }

    // ------------------------------------------------------------
    // AUDIT LOG
    // ------------------------------------------------------------
    async function loadAuditLog() {
        const cont = document.getElementById('cot-audit-list');
        cont.innerHTML = '<div class="loading">Cargando...</div>';
        try {
            const r = await API.cotizadorAuditLog(100);
            const items = r.data || [];
            if (items.length === 0) {
                cont.innerHTML = '<div class="empty">Sin cambios registrados todavía.</div>';
                return;
            }
            cont.innerHTML = `
                <div class="table-container">
                    <table class="data-table">
                        <thead>
                            <tr><th>Cuándo</th><th>Quién</th><th>Acción</th><th>Tabla</th><th>Cambios</th></tr>
                        </thead>
                        <tbody>
                            ${items.map(it => {
                                const before = it.before_json || {};
                                const after  = it.after_json  || {};
                                const changes = diffSummary(before, after);
                                const actClass = it.action === 'CREATE' ? 'badge-success'
                                              : it.action === 'DELETE' ? 'badge-danger'
                                              : 'badge-info';
                                return `<tr>
                                    <td><small>${escapeHtml(fmtDateTime(it.changed_at))}</small></td>
                                    <td>${escapeHtml(it.changed_by_name || it.username || '-')}</td>
                                    <td><span class="badge ${actClass}">${escapeHtml(it.action)}</span></td>
                                    <td><code>${escapeHtml(it.table_name)}#${it.record_id}</code></td>
                                    <td><small>${changes}</small></td>
                                </tr>`;
                            }).join('')}
                        </tbody>
                    </table>
                </div>
            `;
        } catch (err) {
            cont.innerHTML = `<div class="error">Error: ${escapeHtml(err.message || 'no se pudo cargar')}</div>`;
        }
    }

    function diffSummary(before, after) {
        if (!before && !after) return '';
        if (!before) return Object.keys(after).slice(0, 4).map(k => `<code>${escapeHtml(k)}</code>=${escapeHtml(String(after[k]))}`).join(' ');
        if (!after)  return '<em>borrado</em>';
        const changes = [];
        const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
        for (const k of keys) {
            if (k === 'updated_at' || k === 'created_at') continue;
            const a = before[k], b = after[k];
            if (String(a) !== String(b)) {
                changes.push(`<code>${escapeHtml(k)}</code>: ${escapeHtml(String(a))}→${escapeHtml(String(b))}`);
            }
        }
        return changes.slice(0, 5).join(' · ') || '<em>sin cambios</em>';
    }

    return {
        init,
        openCreateTarifa, saveTarifa, deleteTarifa,
        savePais,
        openCreateCatalog, openEditCatalog, deleteCatalog,
        loadAuditLog
    };
})();

// CRÍTICO: exponer cotizadorAdmin como global. Los onclick="cotizadorAdmin.openCreateTarifa()"
// del HTML del módulo "Configurar tarifas" dependen de window.cotizadorAdmin.
window.cotizadorAdmin = cotizadorAdmin;
