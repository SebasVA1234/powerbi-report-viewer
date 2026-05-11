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

    // Expose globals
    window.startTour = startTour;
    window.startGuidedTour = startGuidedTour;
})();
