/**
 * Tour engine — walkthrough interactivo sobre la UI real.
 *
 * Usage:
 *   startTour([
 *     { selector: '.nav-link[data-section="hr"]', title: 'Esto es RRHH', body: '...', position: 'right' },
 *     { selector: '#hr-section h1', title: 'Sección RRHH', body: '...' },
 *     ...
 *   ]);
 *
 * Cada paso:
 *   - selector: CSS selector del elemento a destacar
 *   - title:    título del tooltip
 *   - body:     descripción (puede incluir HTML)
 *   - position: 'top' | 'bottom' | 'left' | 'right' (default 'bottom')
 *   - beforeShow: función async opcional que prepara la UI antes del paso
 *                 (ej. abrir un tab, scroll, etc.)
 *
 * Highlights: un agujero recorta el overlay alrededor del elemento target
 * usando un box-shadow gigante. Click fuera = cerrar tour.
 */
(function () {
    let _overlay = null;
    let _tooltip = null;
    let _steps = [];
    let _index = 0;
    let _onClose = null;

    function startTour(steps, onClose) {
        _steps = steps;
        _index = 0;
        _onClose = onClose;
        ensureChrome();
        renderStep();
    }

    function ensureChrome() {
        if (_overlay) return;
        _overlay = document.createElement('div');
        _overlay.id = 'tour-overlay';
        _overlay.innerHTML = `
            <div class="tour-spotlight"></div>
            <div class="tour-tooltip">
                <div class="tour-progress"></div>
                <h3 class="tour-title"></h3>
                <div class="tour-body"></div>
                <div class="tour-actions">
                    <button class="tour-skip">Saltar</button>
                    <div class="tour-nav">
                        <button class="tour-prev">← Atrás</button>
                        <button class="tour-next">Siguiente →</button>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(_overlay);
        _tooltip = _overlay.querySelector('.tour-tooltip');

        _overlay.querySelector('.tour-skip').onclick = () => endTour();
        _overlay.querySelector('.tour-prev').onclick = () => { _index = Math.max(0, _index - 1); renderStep(); };
        _overlay.querySelector('.tour-next').onclick = () => {
            if (_index >= _steps.length - 1) endTour();
            else { _index++; renderStep(); }
        };
        // ESC para cerrar
        document.addEventListener('keydown', escHandler);
        // Re-position on resize
        window.addEventListener('resize', repositionDebounced);
    }

    function escHandler(e) {
        if (e.key === 'Escape' && _overlay) endTour();
    }
    let _rzTimer = null;
    function repositionDebounced() {
        if (_rzTimer) clearTimeout(_rzTimer);
        _rzTimer = setTimeout(() => renderStep(), 100);
    }

    async function renderStep() {
        const step = _steps[_index];
        if (!step) return endTour();
        if (step.beforeShow) {
            try { await step.beforeShow(); } catch {}
            // Pequeño delay para que la UI se asiente.
            await new Promise(r => setTimeout(r, 250));
        }
        const target = step.selector ? document.querySelector(step.selector) : null;
        if (target) {
            target.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
            await new Promise(r => setTimeout(r, 200));
        }
        positionSpotlightAndTooltip(target, step);
        _tooltip.querySelector('.tour-title').textContent = step.title || '';
        _tooltip.querySelector('.tour-body').innerHTML = step.body || '';
        _tooltip.querySelector('.tour-progress').textContent = `Paso ${_index + 1} de ${_steps.length}`;
        _tooltip.querySelector('.tour-prev').style.visibility = _index === 0 ? 'hidden' : 'visible';
        _tooltip.querySelector('.tour-next').textContent = _index === _steps.length - 1 ? 'Terminar ✓' : 'Siguiente →';
    }

    function positionSpotlightAndTooltip(target, step) {
        const spot = _overlay.querySelector('.tour-spotlight');
        if (!target) {
            // Centrar tooltip sin spotlight si no hay target.
            spot.style.display = 'none';
            _tooltip.style.left = '50%';
            _tooltip.style.top = '50%';
            _tooltip.style.transform = 'translate(-50%, -50%)';
            return;
        }
        spot.style.display = 'block';
        const r = target.getBoundingClientRect();
        const pad = 8;
        spot.style.left = (r.left - pad) + 'px';
        spot.style.top = (r.top - pad) + 'px';
        spot.style.width = (r.width + pad * 2) + 'px';
        spot.style.height = (r.height + pad * 2) + 'px';

        // Posicionar tooltip cerca del target.
        const pos = step.position || 'bottom';
        _tooltip.style.transform = 'none';
        const tw = 360;
        const th = 200;
        const margin = 16;
        let left, top;
        if (pos === 'right') {
            left = r.right + margin;
            top  = r.top + r.height / 2 - th / 2;
        } else if (pos === 'left') {
            left = r.left - tw - margin;
            top  = r.top + r.height / 2 - th / 2;
        } else if (pos === 'top') {
            left = r.left + r.width / 2 - tw / 2;
            top  = r.top - th - margin;
        } else {
            left = r.left + r.width / 2 - tw / 2;
            top  = r.bottom + margin;
        }
        // Clamping a la viewport
        left = Math.max(8, Math.min(window.innerWidth - tw - 8, left));
        top  = Math.max(8, Math.min(window.innerHeight - th - 8, top));
        _tooltip.style.left = left + 'px';
        _tooltip.style.top  = top + 'px';
    }

    function endTour() {
        if (_overlay) {
            _overlay.remove();
            _overlay = null; _tooltip = null;
        }
        document.removeEventListener('keydown', escHandler);
        window.removeEventListener('resize', repositionDebounced);
        if (typeof _onClose === 'function') _onClose();
    }

    // ============================================================
    // Catálogo de tours predefinidos
    // ============================================================
    const TOURS = {
        empleado: [
            { title: 'Bienvenido al Helper Ecualand 👋',
              body: 'Te muestro en 90 segundos cómo usar el portal. Podés saltar con <strong>ESC</strong> cuando quieras.' },
            { selector: '.nav-link[data-section="reports"]', position: 'right',
              title: 'Inicio · tus reportes',
              body: 'Acá ves los reportes que el admin te asignó.',
              beforeShow: async () => showSection && showSection('reports') },
            { selector: '.nav-link[data-section="documents"]', position: 'right',
              title: 'Documentos',
              body: 'PDFs con visor seguro — no se puede descargar ni imprimir.' },
            { selector: '.nav-link[data-section="hr"]', position: 'right',
              title: 'RRHH',
              body: 'Tu perfil, calendario de feriados, solicitar tiempo libre y leer memos.' },
            { selector: '.nav-link[data-section="profile"]', position: 'right',
              title: 'Tu perfil',
              body: 'Desde acá cambiás tu contraseña cuando quieras.',
              beforeShow: async () => showSection && showSection('profile') },
            { selector: '#change-password-form', position: 'left',
              title: 'Cambiar contraseña',
              body: 'Llená contraseña actual + nueva (mín 8 chars) + repetí. Click "Cambiar contraseña".' },
            { selector: '.user-pill',
              title: '¡Listo!',
              body: 'Tu nombre y rol aparecen acá arriba. Cualquier duda, abrí el <a href="manual.html" target="_blank">manual completo</a>.',
              position: 'left' }
        ],
        admin: [
            { title: 'Tour de administrador',
              body: 'Te muestro las acciones que solo vos podés hacer: crear usuarios, asignar reportes, configurar tarifas.' },
            { selector: '.nav-link[data-section="admin"]', position: 'right',
              title: 'Sección Administración',
              body: 'Acá vivimos las tareas de gestión. Te llevo dentro...',
              beforeShow: async () => showSection && showSection('admin') },
            { selector: '[data-tab="users"]', position: 'bottom',
              title: 'Usuarios',
              body: 'Crear, editar, borrar. El "+ Nuevo Usuario" te deja asignar depto y rol en el mismo modal.' },
            { selector: '[data-tab="reports"]', position: 'bottom',
              title: 'Reportes',
              body: 'Los reportes Power BI con sus URLs. Click en el ícono verde de "Accesos" en una fila para asignar a usuarios/deptos/roles.',
              beforeShow: async () => { const t = document.querySelector('[data-tab="reports"]'); if (t) t.click(); } },
            { selector: '#reports-table-body .btn-permissions',
              title: 'Asignar accesos',
              body: 'Click acá abre un modal con 3 sub-tabs: Usuarios, Departamentos, Roles. Asignás reporte a un depto entero y todos sus integrantes lo ven.',
              position: 'left' },
            { selector: '.nav-link[data-section="cotizador"]', position: 'right',
              title: 'Cotizador',
              body: 'Adentro tenés un toggle "Configurar tarifas" donde cargás tarifas por carguera + aerolínea + ruta + rango de peso, y costos por país.',
              beforeShow: async () => showSection && showSection('cotizador') },
            { title: '¡Listo!',
              body: 'Para los detalles paso a paso, abrí el <a href="manual.html" target="_blank">manual completo</a>. Tour terminado.' }
        ]
    };

    /**
     * Punto de entrada desde el botón "?" del topbar.
     * Detecta el rol del user y arranca el tour apropiado.
     */
    function startGuidedTour() {
        const role = (window.__userIsAdmin || (typeof Auth !== 'undefined' && Auth.isAdmin && Auth.isAdmin())) ? 'admin' : 'empleado';
        const steps = TOURS[role];
        if (!steps) return;
        startTour(steps);
    }

    // ============================================================
    // Tour INTERACTIVO del cotizador
    // ============================================================
    // A diferencia de los tours informativos de empleado/admin (que sólo
    // explican lo que ve la pantalla), este tour MUEVE el cursor, llena
    // campos y ejecuta el cálculo para que el usuario vea una cotización
    // de ejemplo armarse en vivo, sin tener que pensar qué poner.
    // ============================================================
    function setNativeValue(input, value) {
        // Setea el value de un input/select disparando los eventos input + change
        // para que los listeners del cotizador (cascada de filtros, updateCalcButtonState)
        // se enteren del cambio igual que si lo hubiera escrito un humano.
        const proto = input instanceof HTMLSelectElement
            ? HTMLSelectElement.prototype
            : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
        setter.call(input, String(value));
        input.dispatchEvent(new Event('input',  { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
    }

    async function pickFirstNonEmpty(selectId) {
        const sel = document.getElementById(selectId);
        if (!sel) return false;
        const opt = Array.from(sel.options).find(o => o.value && o.value !== '');
        if (!opt) return false;
        setNativeValue(sel, opt.value);
        return true;
    }

    async function pickAirport(role, iata) {
        const field = document.querySelector(`.cot-airport-field[data-airport-role="${role}"]`);
        if (!field) return false;
        // Click en el input para abrir el dropdown — eso dispara el renderList
        // del autocomplete que rellena la lista de resultados.
        const input = field.querySelector('[data-airport-input]');
        if (!input) return false;
        input.click();
        await new Promise(r => setTimeout(r, 200));
        // Buscar el row por código IATA y clickearlo
        const rows = field.querySelectorAll('.cot-airport-result');
        for (const r of rows) {
            const iataEl = r.querySelector('.cot-airport-result-iata');
            if (iataEl && iataEl.textContent.trim().toUpperCase() === iata.toUpperCase()) {
                r.click();
                return true;
            }
        }
        // Fallback: primer resultado
        if (rows.length > 0) {
            rows[0].click();
            return true;
        }
        // Si no hay rows (catálogos aún cargando), cerrar
        input.click();
        return false;
    }

    // Espera hasta que los catálogos del cotizador estén cargados (con timeout).
    async function waitForCotizadorReady(timeoutMs = 4000) {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            // Heurística: el autocomplete tiene resultados disponibles → catálogo listo
            const field = document.querySelector('.cot-airport-field[data-airport-role="destino"]');
            if (field) {
                const input = field.querySelector('[data-airport-input]');
                if (input) {
                    input.click();              // abre temporalmente
                    await new Promise(r => setTimeout(r, 100));
                    const ready = field.querySelectorAll('.cot-airport-result').length > 0;
                    input.click();              // cerrar (toggle)
                    if (ready) return true;
                }
            }
            await new Promise(r => setTimeout(r, 200));
        }
        return false;
    }

    const TOUR_COTIZADOR = [
        { title: '▶️ Demo del Cotizador',
          body: 'Te voy a mostrar una cotización completa de ejemplo: Quito → Miami con 10.000 tallos. Voy a llenar los campos por vos y vas a ver el resultado en vivo. Apretá <strong>Siguiente</strong> para empezar.',
          beforeShow: async () => {
            if (typeof showSection === 'function') showSection('cotizador');
            if (typeof cotizadorSwitchMode === 'function') cotizadorSwitchMode('calcular');
            // Espera a que los catálogos terminen de cargar antes de que el
            // usuario pueda avanzar al siguiente paso — evita que pickAirport
            // falle por no haber rows todavía.
            await waitForCotizadorReady(4000);
          }
        },
        { selector: '.cot-section:nth-of-type(1)', position: 'right',
          title: '1️⃣ Ruta de vuelo',
          body: 'El origen ya viene pre-llenado con <strong>Quito (UIO)</strong> porque es de donde sale el 95% de los envíos. Te elijo Miami (<strong>MIA</strong>) como destino.',
          beforeShow: async () => {
            await new Promise(r => setTimeout(r, 200));
            await pickAirport('destino', 'MIA');
            await new Promise(r => setTimeout(r, 400));
          }
        },
        { selector: '#cot-tarifa-card', position: 'top',
          title: '2️⃣ Carguera y tarifa',
          body: 'Cuando elijo carguera y aerolínea, el sistema busca automáticamente la tarifa vigente para esa combinación + ruta + peso. Si no hay tarifa configurada aparece una advertencia roja.',
          beforeShow: async () => {
            await pickFirstNonEmpty('cot-carguera');
            await new Promise(r => setTimeout(r, 300));
            await pickFirstNonEmpty('cot-aerolinea');
            await new Promise(r => setTimeout(r, 400));
          }
        },
        { selector: '#cot-tallos', position: 'right',
          title: '3️⃣ Datos del pedido',
          body: 'Te lleno los campos: <strong>10.000 tallos</strong>, <strong>250 tallos por caja</strong>, escenarios bajo $0.65 y alto $0.95. Mirá cómo aparece el peso estimado en tiempo real (560 kg).',
          beforeShow: async () => {
            setNativeValue(document.getElementById('cot-tallos'), 10000);
            setNativeValue(document.getElementById('cot-tallos-caja'), 250);
            setNativeValue(document.getElementById('cot-precio-1'), 0.65);
            setNativeValue(document.getElementById('cot-precio-2'), 0.95);
            await new Promise(r => setTimeout(r, 300));
          }
        },
        { selector: '.cot-weight-collapsible', position: 'right',
          title: '⚖️ Peso estimado',
          body: 'El sistema usa 0,056 kg por tallo por default (factor de conversión flores frescas). Si conocés el peso real, lo cargás acá expandiendo el bloque.'
        },
        { selector: '#cot-calc-btn', position: 'top',
          title: '🎯 Calcular Landed Cost',
          body: 'Ya con todo lleno, el botón se habilita. Lo apreto por vos para que veas el resultado…',
          beforeShow: async () => {
            const btn = document.getElementById('cot-calc-btn');
            if (btn && !btn.disabled) {
              btn.click();
              // Esperar a que se renderice el resultado
              await new Promise(r => setTimeout(r, 800));
            }
          }
        },
        { selector: '.cot-result-header', position: 'left',
          title: '📊 Resultado: ruta y meta',
          body: 'Acá ves la ruta grande <strong>UIO → MIA</strong>, el destino con ciudad y país, la cantidad de cajas y tallos, y la fecha del cálculo.'
        },
        { selector: '.cot-escenario.low', position: 'left',
          title: '💙 Escenario bajo',
          body: 'Cada escenario muestra el desglose: FOB total, flete, costos fijos, transporte interno, impuestos. Al final el <strong>Landed Cost Total</strong> y el costo <strong>por tallo</strong>.'
        },
        { selector: '.cot-escenario.high', position: 'left',
          title: '💚 Escenario alto',
          body: 'Mismo desglose con el precio FOB más caro. Compará los totales lado a lado para entender el rango de margen que tenés.'
        },
        { selector: '.cot-result-actions', position: 'top',
          title: '💾 Acciones del resultado',
          body: '<strong>Guardar</strong> archiva esta cotización en el historial. <strong>Exportar PDF</strong> descarga un documento branded con logo Ecualand. <strong>Nueva</strong> limpia y empezás otra (la ruta y carguera se mantienen).'
        },
        { selector: '.cot-mode-btn[data-mode="historial"]', position: 'bottom',
          title: '📜 Historial',
          body: 'Acá ves todas las cotizaciones guardadas, con búsqueda, filtros y un panel con el detalle inmutable de cada una. Son el registro histórico de decisiones comerciales.',
          beforeShow: async () => {
            // No saltamos al historial — solo apuntamos para no perder el resultado
            // de la demo. El usuario lo puede clickear después.
          }
        },
        { title: '✅ ¡Listo!',
          body: 'Eso es todo. La próxima vez ya sabés llenar el form en 30 segundos. Si querés ver más detalles, abrí el <a href="manual.html" target="_blank">manual completo</a>. <br><br>Tip: el botón "<strong>Nueva cotización</strong>" conserva la ruta y la carguera para cotizar varios pedidos al mismo destino sin volver a elegir.'
        }
    ];

    function startCotizadorDemo() {
        startTour(TOUR_COTIZADOR);
    }

    // Expose globals
    window.startTour = startTour;
    window.startGuidedTour = startGuidedTour;
    window.startCotizadorDemo = startCotizadorDemo;
})();
