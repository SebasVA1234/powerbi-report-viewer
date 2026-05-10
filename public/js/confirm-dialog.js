/**
 * Confirm dialog tematizado — reemplaza window.confirm() nativo (que rompe
 * la estética dark del portal) con un modal del design system.
 *
 * Uso:
 *   const ok = await confirmDialog({
 *     title: '¿Eliminar usuario?',
 *     message: 'Esta acción es irreversible. El usuario no podrá recuperar su acceso.',
 *     confirmText: 'Eliminar',
 *     typeToConfirm: 'ELIMINAR'   // opcional; pide tipear esto exacto para habilitar el botón
 *   });
 *   if (!ok) return;
 *
 * Devuelve Promise<boolean>: true si el user confirmó, false si canceló o cerró.
 *
 * Si typeToConfirm está seteado, el botón Confirmar arranca disabled hasta
 * que el input matchee EXACTAMENTE el string. Es la doble red que pidió el
 * usuario para acciones destructivas (admin no puede confirmar de un click
 * sin querer).
 */
(function () {
    function confirmDialog(opts) {
        const {
            title = '¿Estás seguro?',
            message = '',
            confirmText = 'Confirmar',
            cancelText = 'Cancelar',
            typeToConfirm = null,
            danger = true
        } = opts || {};

        return new Promise(resolve => {
            const overlay = document.createElement('div');
            overlay.className = 'confirm-dialog-overlay';
            overlay.innerHTML = `
                <div class="confirm-dialog" role="dialog" aria-modal="true">
                    <h3>${escapeHtml(title)}</h3>
                    ${message ? `<div class="confirm-msg">${escapeHtml(message)}</div>` : ''}
                    ${typeToConfirm ? `
                        <div class="confirm-type-row">
                            <label>Para confirmar, tipeá: <strong>${escapeHtml(typeToConfirm)}</strong></label>
                            <input type="text" class="confirm-input" autocomplete="off" spellcheck="false">
                        </div>
                    ` : ''}
                    <div class="confirm-actions">
                        <button class="btn-confirm-cancel">${escapeHtml(cancelText)}</button>
                        <button class="btn-confirm-confirm" ${typeToConfirm ? 'disabled' : ''}>${escapeHtml(confirmText)}</button>
                    </div>
                </div>
            `;
            document.body.appendChild(overlay);

            const cancelBtn = overlay.querySelector('.btn-confirm-cancel');
            const confirmBtn = overlay.querySelector('.btn-confirm-confirm');
            const input = overlay.querySelector('.confirm-input');

            // Estilo danger si aplica.
            if (!danger) {
                confirmBtn.style.background = 'var(--primary)';
                confirmBtn.style.borderColor = 'var(--primary)';
            }

            function close(result) {
                document.body.removeChild(overlay);
                document.removeEventListener('keydown', onKey);
                resolve(result);
            }
            function onKey(e) {
                if (e.key === 'Escape') close(false);
                if (e.key === 'Enter' && !confirmBtn.disabled) close(true);
            }
            document.addEventListener('keydown', onKey);

            cancelBtn.onclick = () => close(false);
            confirmBtn.onclick = () => close(true);
            overlay.onclick = (e) => { if (e.target === overlay) close(false); };

            if (input) {
                input.oninput = () => {
                    confirmBtn.disabled = input.value.trim() !== typeToConfirm;
                };
                setTimeout(() => input.focus(), 50);
            } else {
                setTimeout(() => confirmBtn.focus(), 50);
            }
        });
    }

    function escapeHtml(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    /**
     * formDialog — modal genérico con N campos. Reemplaza encadenamientos
     * largos de window.prompt() y window.alert().
     *
     *   const data = await formDialog({
     *     title: 'Nuevo feriado',
     *     fields: [
     *       { name: 'date', label: 'Fecha', type: 'date', required: true },
     *       { name: 'name', label: 'Nombre', type: 'text', required: true },
     *       { name: 'desc', label: 'Descripción', type: 'textarea' },
     *       { name: 'national', label: '¿Nacional?', type: 'select',
     *         options: [{value:'1',label:'Sí'},{value:'0',label:'Decretado'}], default: '1' }
     *     ],
     *     confirmText: 'Crear feriado'
     *   });
     *   if (!data) return; // user canceló
     *
     * Tipos soportados: text, date, number, password, textarea, select.
     * Devuelve null si cancela, o {fieldName: value} si confirma.
     */
    function formDialog(opts) {
        const {
            title = 'Formulario',
            fields = [],
            confirmText = 'Guardar',
            cancelText = 'Cancelar',
            description = ''
        } = opts;

        return new Promise(resolve => {
            const overlay = document.createElement('div');
            overlay.className = 'confirm-dialog-overlay';

            const fieldsHtml = fields.map((f, i) => {
                const id = 'fd-' + i;
                const required = f.required ? 'required' : '';
                const def = f.default != null ? f.default : '';
                if (f.type === 'textarea') {
                    return `
                        <div class="form-group" style="margin-bottom: 0.85rem;">
                            <label for="${id}">${escapeHtml(f.label)}${f.required ? ' *' : ''}</label>
                            <textarea id="${id}" data-fname="${escapeHtml(f.name)}" rows="3" ${required}
                                placeholder="${escapeHtml(f.placeholder || '')}"
                                style="width:100%; background:var(--bg-input); color:var(--text-1); border:1px solid var(--border); border-radius:var(--radius-sm); padding:0.55rem 0.75rem;">${escapeHtml(def)}</textarea>
                        </div>`;
                }
                if (f.type === 'select') {
                    const opts = (f.options || []).map(o =>
                        `<option value="${escapeHtml(o.value)}" ${String(o.value) === String(def) ? 'selected' : ''}>${escapeHtml(o.label)}</option>`
                    ).join('');
                    return `
                        <div class="form-group" style="margin-bottom: 0.85rem;">
                            <label for="${id}">${escapeHtml(f.label)}${f.required ? ' *' : ''}</label>
                            <select id="${id}" data-fname="${escapeHtml(f.name)}" ${required}
                                style="width:100%; background:var(--bg-input); color:var(--text-1); border:1px solid var(--border); border-radius:var(--radius-sm); padding:0.55rem 0.75rem;">${opts}</select>
                        </div>`;
                }
                const t = f.type || 'text';
                return `
                    <div class="form-group" style="margin-bottom: 0.85rem;">
                        <label for="${id}">${escapeHtml(f.label)}${f.required ? ' *' : ''}</label>
                        <input id="${id}" data-fname="${escapeHtml(f.name)}" type="${t}" value="${escapeHtml(def)}" ${required}
                            placeholder="${escapeHtml(f.placeholder || '')}"
                            style="width:100%; background:var(--bg-input); color:var(--text-1); border:1px solid var(--border); border-radius:var(--radius-sm); padding:0.55rem 0.75rem;">
                    </div>`;
            }).join('');

            overlay.innerHTML = `
                <div class="confirm-dialog" role="dialog" aria-modal="true" style="width:min(540px, 90vw); max-height:85vh; overflow-y:auto;">
                    <h3>${escapeHtml(title)}</h3>
                    ${description ? `<div class="confirm-msg">${escapeHtml(description)}</div>` : ''}
                    <form>${fieldsHtml}</form>
                    <div class="confirm-actions" style="margin-top:0.5rem;">
                        <button type="button" class="btn-confirm-cancel">${escapeHtml(cancelText)}</button>
                        <button type="button" class="btn-confirm-confirm" style="background:var(--primary); border-color:var(--primary);">${escapeHtml(confirmText)}</button>
                    </div>
                </div>
            `;
            document.body.appendChild(overlay);

            const cancelBtn = overlay.querySelector('.btn-confirm-cancel');
            const confirmBtn = overlay.querySelector('.btn-confirm-confirm');

            function close(result) {
                document.body.removeChild(overlay);
                document.removeEventListener('keydown', onKey);
                resolve(result);
            }
            function collect() {
                const data = {};
                let firstInvalid = null;
                overlay.querySelectorAll('[data-fname]').forEach(el => {
                    const name = el.dataset.fname;
                    const val = el.value;
                    if (el.required && !val.trim() && !firstInvalid) firstInvalid = el;
                    data[name] = val;
                });
                if (firstInvalid) {
                    firstInvalid.focus();
                    firstInvalid.style.borderColor = 'var(--danger)';
                    return null;
                }
                return data;
            }
            function onKey(e) {
                if (e.key === 'Escape') close(null);
                if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA') {
                    e.preventDefault();
                    const data = collect();
                    if (data) close(data);
                }
            }
            document.addEventListener('keydown', onKey);
            cancelBtn.onclick = () => close(null);
            confirmBtn.onclick = () => {
                const data = collect();
                if (data) close(data);
            };
            overlay.onclick = (e) => { if (e.target === overlay) close(null); };

            // Auto-focus primer campo.
            setTimeout(() => {
                const first = overlay.querySelector('[data-fname]');
                if (first) first.focus();
            }, 50);
        });
    }

    /**
     * infoDialog — reemplaza window.alert() con un modal estilizado de
     * solo lectura (sin acciones destructivas).
     */
    function infoDialog(opts) {
        const { title = 'Información', message = '', okText = 'Cerrar', html = false } = opts;
        return new Promise(resolve => {
            const overlay = document.createElement('div');
            overlay.className = 'confirm-dialog-overlay';
            overlay.innerHTML = `
                <div class="confirm-dialog" role="dialog" aria-modal="true" style="width:min(520px, 90vw); max-height:80vh; overflow-y:auto;">
                    <h3>${escapeHtml(title)}</h3>
                    <div class="confirm-msg" style="white-space:pre-wrap;">${html ? message : escapeHtml(message)}</div>
                    <div class="confirm-actions">
                        <button class="btn-confirm-confirm" style="background:var(--primary); border-color:var(--primary);">${escapeHtml(okText)}</button>
                    </div>
                </div>
            `;
            document.body.appendChild(overlay);
            const ok = overlay.querySelector('.btn-confirm-confirm');
            function close() {
                document.body.removeChild(overlay);
                document.removeEventListener('keydown', onKey);
                resolve();
            }
            function onKey(e) { if (e.key === 'Escape' || e.key === 'Enter') close(); }
            document.addEventListener('keydown', onKey);
            ok.onclick = close;
            overlay.onclick = (e) => { if (e.target === overlay) close(); };
            setTimeout(() => ok.focus(), 50);
        });
    }

    window.confirmDialog = confirmDialog;
    window.formDialog = formDialog;
    window.infoDialog = infoDialog;
})();
