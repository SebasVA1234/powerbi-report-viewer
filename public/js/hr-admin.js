/**
 * HR UI (PR-3a-ui)
 *
 * Controller del frontend para la sección RRHH con 4 tabs:
 *   - Mi Perfil: empleado del user logueado + saldo banco compensado
 *   - Empleados: lista filtrada por permisos + alta/edit
 *   - Calendario Feriados: lista del año + crear feriado custom + registrar
 *     attendance al hacer click en una fila (modal con empleado + horario)
 *   - Solicitudes: time-off filtradas por estado + crear + aprobar/rechazar
 *
 * UI: usa formDialog/confirmDialog/infoDialog (públicos en window) — todos
 * los flujos pasan por modales del design system antigravity, sin
 * window.prompt/confirm/alert.
 */

const hrAdmin = (function () {
    function token() { return Utils.getToken(); }
    function authHeader() { return { 'Authorization': 'Bearer ' + token() }; }

    async function api(method, url, body) {
        const opts = { method, headers: { ...authHeader() } };
        if (body !== undefined) {
            opts.headers['Content-Type'] = 'application/json';
            opts.body = JSON.stringify(body);
        }
        const r = await fetch(url, opts);
        let data = null;
        try { data = await r.json(); } catch { data = null; }
        if (!r.ok) {
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

    function fmtDate(d) {
        if (!d) return '';
        const s = String(d);
        return s.length >= 10 ? s.slice(0, 10) : s;
    }

    // Cache de datos auxiliares para no re-fetchear (positions, departments, employees).
    let _positions = null;
    let _departments = null;
    let _employees = null;

    async function getPositions() {
        if (_positions) return _positions;
        const r = await api('GET', '/api/hr/positions');
        _positions = r.data.positions || [];
        return _positions;
    }
    async function getDepartments() {
        if (_departments) return _departments;
        const r = await api('GET', '/api/rbac/departments');
        _departments = r.data.departments || [];
        return _departments;
    }
    async function getEmployees() {
        if (_employees) return _employees;
        const r = await api('GET', '/api/hr/employees');
        _employees = r.data.employees || [];
        return _employees;
    }
    function invalidateEmployeesCache() { _employees = null; }

    // Tab switching dentro de la sección RRHH.
    function setupTabs() {
        document.querySelectorAll('[data-hr-tab]').forEach(btn => {
            btn.addEventListener('click', () => {
                const tab = btn.dataset.hrTab;
                document.querySelectorAll('[data-hr-tab]').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                document.querySelectorAll('#hr-section .tab-content').forEach(c => c.classList.remove('active'));
                document.getElementById(`hr-${tab}-tab`).classList.add('active');
                if (tab === 'me') loadMe();
                if (tab === 'employees') loadEmployees();
                if (tab === 'holidays') loadHolidays();
                if (tab === 'time-off') loadTimeOff();
                if (tab === 'memos') loadMemos();
            });
        });
    }

    // ------------------------------------------------------------
    // Tab: Mi Perfil RRHH
    // ------------------------------------------------------------
    async function loadMe() {
        const box = document.getElementById('hr-me-content');
        const balBox = document.getElementById('hr-me-balance');
        box.innerHTML = '<p class="loading">Cargando...</p>';
        balBox.innerHTML = '';
        try {
            const r = await api('GET', '/api/hr/me');
            const e = r.data.employee;
            if (!e) {
                box.innerHTML = `
                    <div class="rbac-context-card">
                        <p>No tenés un perfil de empleado asociado a tu usuario.</p>
                        <p class="empty-inline">Pedile a RRHH que te cree el perfil para ver tu información acá.</p>
                    </div>`;
                return;
            }
            box.innerHTML = `
                <div class="rbac-context-card">
                    <div class="rbac-card-section">
                        <h4>${escapeHtml(e.full_name)}</h4>
                        <p>${escapeHtml(e.position_title || 'Sin cargo')} · ${escapeHtml(e.department_name || 'Sin depto')}</p>
                    </div>
                    <div class="rbac-card-section">
                        <h5>Datos</h5>
                        <p><strong>Estado:</strong> ${escapeHtml(e.status)}</p>
                        <p><strong>Ingreso:</strong> ${escapeHtml(fmtDate(e.hire_date) || '-')}</p>
                        ${e.doc_id ? `<p><strong>Documento:</strong> ${escapeHtml(e.doc_id)}</p>` : ''}
                        ${e.email_personal ? `<p><strong>Email personal:</strong> ${escapeHtml(e.email_personal)}</p>` : ''}
                        ${e.phone ? `<p><strong>Teléfono:</strong> ${escapeHtml(e.phone)}</p>` : ''}
                    </div>
                </div>
            `;
            // Saldo del banco compensado
            try {
                const b = await api('GET', `/api/hr/employees/${e.id}/compensated-balance`);
                const d = b.data;
                balBox.innerHTML = `
                    <p>
                        Acumulados: <strong>${d.days_accrued}</strong> ·
                        Usados: <strong>${d.days_used}</strong> ·
                        Disponibles: <strong style="color:${d.balance > 0 ? '#10b981' : '#999'}">${d.balance}</strong>
                    </p>
                `;
            } catch {
                balBox.innerHTML = '<p class="empty-inline">No se pudo calcular el saldo.</p>';
            }
        } catch (err) {
            box.innerHTML = `<p class="error">${escapeHtml(err.message)}</p>`;
        }
    }

    // ------------------------------------------------------------
    // Tab: Empleados
    // ------------------------------------------------------------
    async function loadEmployees() {
        const tbody = document.getElementById('hr-employees-tbody');
        const filter = document.getElementById('hr-emp-dept-filter');
        if (!filter.options || filter.options.length <= 1) {
            const depts = await getDepartments();
            depts.forEach(d => {
                const opt = document.createElement('option');
                opt.value = d.id; opt.textContent = d.name;
                filter.appendChild(opt);
            });
        }
        tbody.innerHTML = '<tr><td colspan="6" class="loading">Cargando...</td></tr>';
        try {
            const url = filter.value
                ? `/api/hr/employees?department_id=${filter.value}`
                : '/api/hr/employees';
            const r = await api('GET', url);
            const emps = r.data.employees || [];
            if (emps.length === 0) {
                tbody.innerHTML = '<tr><td colspan="6" class="empty">Sin empleados visibles.</td></tr>';
                return;
            }
            tbody.innerHTML = emps.map(e => {
                // PR-3a: un empleado se considera "perfil incompleto" cuando
                // falta cargo, documento o fecha de ingreso. Eso pasa cuando
                // se autocreó desde el alta del usuario y aún no se completó.
                const incomplete = !e.position_id || !e.doc_id || !e.hire_date;
                const incompleteBadge = incomplete
                    ? `<span class="badge badge-incomplete" title="Faltan cargo, documento o fecha de ingreso">Perfil incompleto</span>`
                    : '';
                // PR-4: si el empleado tiene user vinculado, el botón "Editar"
                // abre el modal unificado en Administración (con permisos +
                // datos RRHH en una sola UI). Si no tiene user, fallback al
                // modal viejo solo-RRHH (caso edge: empleado sin login).
                const editAction = e.user_id
                    ? `openUserPermissions(${e.user_id})`
                    : `hrAdmin.editEmployee(${e.id})`;
                return `
                <tr>
                    <td>
                        <strong>${escapeHtml(e.full_name)}</strong>
                        ${incompleteBadge}
                        ${e.user_username ? `<br><small>@${escapeHtml(e.user_username)}</small>` : ''}
                    </td>
                    <td>${escapeHtml(e.position_title || '-')}</td>
                    <td>${escapeHtml(e.department_name || '-')}</td>
                    <td><span class="badge ${e.status === 'active' ? 'badge-success' : 'badge-danger'}">${escapeHtml(e.status)}</span></td>
                    <td>${escapeHtml(fmtDate(e.hire_date) || '-')}</td>
                    <td>
                        <button class="btn-edit" onclick="${editAction}">${incomplete ? 'Completar' : 'Editar'}</button>
                        <button class="btn-edit" onclick="hrAdmin.viewBalance(${e.id}, '${escapeHtml(e.full_name).replace(/'/g, "\\'")}')">Saldo</button>
                        <button class="btn-delete" onclick="hrAdmin.deleteEmployee(${e.id}, '${escapeHtml(e.full_name).replace(/'/g, "\\'")}')">Eliminar</button>
                    </td>
                </tr>
                `;
            }).join('');
        } catch (err) {
            tbody.innerHTML = `<tr><td colspan="6" class="error">${escapeHtml(err.message)}</td></tr>`;
        }
    }

    async function openCreateEmployee() {
        try {
            const [positions, depts] = await Promise.all([getPositions(), getDepartments()]);
            const data = await formDialog({
                title: 'Nuevo empleado',
                description: 'El empleado puede vincularse a un usuario del sistema más tarde desde Editar.',
                fields: [
                    { name: 'full_name', label: 'Nombre completo', type: 'text', required: true },
                    { name: 'position_id', label: 'Cargo', type: 'select', required: true,
                      options: positions.map(p => ({ value: p.id, label: `${p.title} [${p.code}]` })) },
                    { name: 'department_id', label: 'Departamento', type: 'select', required: true,
                      options: depts.map(d => ({ value: d.id, label: `${d.name} [${d.code}]` })) },
                    { name: 'hire_date', label: 'Fecha de ingreso', type: 'date',
                      default: new Date().toISOString().slice(0, 10) },
                    { name: 'doc_id', label: 'Documento de identidad', type: 'text', placeholder: 'Opcional' }
                ],
                confirmText: 'Crear empleado'
            });
            if (!data) return;
            await api('POST', '/api/hr/employees', {
                full_name: data.full_name.trim(),
                position_id: Number(data.position_id),
                department_id: Number(data.department_id),
                hire_date: data.hire_date || null,
                doc_id: data.doc_id || null
            });
            Notification.success('Empleado creado');
            invalidateEmployeesCache();
            loadEmployees();
        } catch (err) {
            Notification.error('No se pudo crear: ' + err.message);
        }
    }

    async function editEmployee(id) {
        try {
            const r = await api('GET', `/api/hr/employees/${id}`);
            const e = r.data.employee;
            // ¿Puede ver/editar datos de nómina (sueldo + flags)? El backend
            // revalida con hr.salary.write; acá gateamos la UI para no mostrar
            // campos que este usuario no puede tocar. Admin tiene todo.
            const puedeNomina = !!(window.__userIsAdmin ||
                (window.__userPerms && window.__userPerms.has('hr.salary.write')));
            const fields = [
                { name: 'full_name', label: 'Nombre completo', type: 'text', required: true, default: e.full_name },
                { name: 'status', label: 'Estado', type: 'select', required: true, default: e.status,
                  options: [
                    { value: 'active', label: 'Activo' },
                    { value: 'on_leave', label: 'En licencia' },
                    { value: 'terminated', label: 'Dado de baja' }
                  ] }
            ];
            if (puedeNomina) {
                // Datos de nómina por empleado (alimentan el cálculo del rol).
                fields.push(
                    { name: 'base_salary', label: 'Sueldo base (USD / mes)', type: 'number',
                      placeholder: 'Ej: 470', default: (e.base_salary != null ? e.base_salary : '') },
                    { name: 'paga_fondos_mensual', label: 'Paga fondos de reserva mensual (8.33%, tras 1 año)', type: 'select',
                      default: String(Number(e.paga_fondos_mensual) || 0),
                      options: [ { value: '0', label: 'No (acumula)' }, { value: '1', label: 'Sí (mensual)' } ] },
                    { name: 'mensualiza_decimos', label: 'Mensualiza décimos 13/14 (entran al rol mensual)', type: 'select',
                      default: String(Number(e.mensualiza_decimos) || 0),
                      options: [ { value: '0', label: 'No (acumula)' }, { value: '1', label: 'Sí (mensual)' } ] }
                );
            }
            const data = await formDialog({
                title: `Editar empleado · ${e.full_name}`,
                description: puedeNomina
                    ? 'El sueldo y la configuración de nómina sólo los ve y edita quien tiene permiso de salarios.'
                    : '',
                fields,
                confirmText: 'Guardar cambios'
            });
            if (!data) return;
            const payload = {
                full_name: data.full_name.trim(),
                status: data.status
            };
            if (puedeNomina) {
                // El backend coacciona: '' → sin sueldo; '0'/'1' → 0/1.
                payload.base_salary = data.base_salary;
                payload.mensualiza_decimos = data.mensualiza_decimos;
                payload.paga_fondos_mensual = data.paga_fondos_mensual;
            }
            await api('PUT', `/api/hr/employees/${id}`, payload);
            Notification.success('Empleado actualizado');
            invalidateEmployeesCache();
            loadEmployees();
        } catch (err) {
            Notification.error('No se pudo actualizar: ' + err.message);
        }
    }

    async function deleteEmployee(id, name) {
        const ok = await confirmDialog({
            title: `¿Eliminar a ${name}?`,
            message: 'Se borran sus asistencias a feriados y solicitudes de tiempo libre. Si solo querés darle de baja, editá el estado a "Dado de baja". No se puede deshacer.',
            confirmText: 'Eliminar empleado',
            typeToConfirm: 'ELIMINAR'
        });
        if (!ok) return;
        try {
            await api('DELETE', `/api/hr/employees/${id}`);
            Notification.success(`"${name}" eliminado`);
            invalidateEmployeesCache();
            loadEmployees();
        } catch (err) {
            Notification.error('No se pudo eliminar: ' + err.message);
        }
    }

    async function viewBalance(id, name) {
        try {
            const r = await api('GET', `/api/hr/employees/${id}/compensated-balance`);
            const d = r.data;
            await infoDialog({
                title: `Banco de días compensados · ${name}`,
                message: `Acumulados: ${d.days_accrued}\nUsados: ${d.days_used}\nDisponibles: ${d.balance}`
            });
        } catch (err) {
            Notification.error('Error: ' + err.message);
        }
    }

    // ------------------------------------------------------------
    // Tab: Calendario de Feriados
    // ------------------------------------------------------------
    async function loadHolidays() {
        const tbody = document.getElementById('hr-holidays-tbody');
        const year = document.getElementById('hr-holidays-year').value;
        tbody.innerHTML = '<tr><td colspan="4" class="loading">Cargando...</td></tr>';
        try {
            const r = await api('GET', `/api/hr/holidays?year=${year}`);
            const hs = r.data.holidays || [];
            if (hs.length === 0) {
                tbody.innerHTML = '<tr><td colspan="4" class="empty">Sin feriados para ese año.</td></tr>';
                return;
            }
            tbody.innerHTML = hs.map(h => `
                <tr>
                    <td><code>${escapeHtml(fmtDate(h.holiday_date))}</code></td>
                    <td><strong>${escapeHtml(h.name)}</strong>${h.description ? '<br><small>' + escapeHtml(h.description) + '</small>' : ''}</td>
                    <td><span class="badge ${h.is_national ? 'badge-info' : 'badge-success'}">${h.is_national ? 'Nacional' : 'Decretado'}</span></td>
                    <td>
                        <button class="btn-edit" onclick="hrAdmin.openRegisterAttendance(${h.id}, '${escapeHtml(h.name).replace(/'/g, "\\'")}', '${escapeHtml(fmtDate(h.holiday_date))}')">+ Asistencia</button>
                        <button class="btn-edit" onclick="hrAdmin.viewAttendance(${h.id}, '${escapeHtml(h.name).replace(/'/g, "\\'")}')">Ver quien trabajó</button>
                        <button class="btn-delete" onclick="hrAdmin.deleteHoliday(${h.id})">Archivar</button>
                    </td>
                </tr>
            `).join('');
        } catch (err) {
            tbody.innerHTML = `<tr><td colspan="4" class="error">${escapeHtml(err.message)}</td></tr>`;
        }
    }

    async function openCreateHoliday() {
        const data = await formDialog({
            title: 'Nuevo feriado',
            description: 'Agregá un feriado nacional o uno decretado por el gobierno fuera del calendario base.',
            fields: [
                { name: 'date', label: 'Fecha', type: 'date', required: true },
                { name: 'name', label: 'Nombre del feriado', type: 'text', required: true },
                { name: 'desc', label: 'Descripción', type: 'textarea', placeholder: 'Opcional' },
                { name: 'national', label: 'Tipo', type: 'select', default: '1',
                  options: [
                    { value: '1', label: 'Nacional' },
                    { value: '0', label: 'Decretado / custom' }
                  ] }
            ],
            confirmText: 'Crear feriado'
        });
        if (!data) return;
        try {
            await api('POST', '/api/hr/holidays', {
                holiday_date: data.date,
                name: data.name.trim(),
                description: data.desc || null,
                is_national: data.national === '1'
            });
            Notification.success('Feriado creado');
            loadHolidays();
        } catch (err) {
            Notification.error('No se pudo crear: ' + err.message);
        }
    }

    async function deleteHoliday(id) {
        const ok = await confirmDialog({
            title: '¿Archivar este feriado?',
            message: 'Se marca como inactivo en el calendario. Las asistencias históricas y los días compensados que generó se preservan.',
            confirmText: 'Archivar',
            danger: false
        });
        if (!ok) return;
        try {
            await api('DELETE', `/api/hr/holidays/${id}`);
            Notification.success('Feriado archivado');
            loadHolidays();
        } catch (err) {
            Notification.error('No se pudo archivar: ' + err.message);
        }
    }

    async function openRegisterAttendance(holidayId, holidayName, holidayDate) {
        try {
            const emps = await getEmployees();
            if (emps.length === 0) {
                Notification.error('No hay empleados registrados. Crealos primero.');
                return;
            }
            const data = await formDialog({
                title: `Registrar asistencia · ${holidayName}`,
                description: `Fecha: ${holidayDate}. Cada asistencia suma días al banco compensado del empleado.`,
                fields: [
                    { name: 'employee_id', label: 'Empleado', type: 'select', required: true,
                      options: emps.map(e => ({ value: e.id, label: `${e.full_name} (${e.department_name || '-'})` })) },
                    { name: 'schedule', label: 'Horario', type: 'text', default: '7:00 a 5:00',
                      placeholder: 'Ej: 7:00 a 5:00' },
                    { name: 'credit', label: 'Días de crédito al banco', type: 'number', default: '1' }
                ],
                confirmText: 'Registrar asistencia'
            });
            if (!data) return;
            const empId = Number(data.employee_id);
            const credit = Number(data.credit) || 1;
            await api('POST', `/api/hr/holidays/${holidayId}/attendance`, {
                employee_id: empId,
                schedule_text: data.schedule || null,
                days_credit: credit
            });
            const emp = emps.find(e => e.id === empId);
            Notification.success(`+${credit}d al banco de ${emp ? emp.full_name : 'el empleado'}`);
        } catch (err) {
            Notification.error('No se pudo registrar: ' + err.message);
        }
    }

    async function viewAttendance(holidayId, holidayName) {
        try {
            const r = await api('GET', `/api/hr/holidays/${holidayId}/attendance`);
            const att = r.data.attendance || [];
            if (att.length === 0) {
                await infoDialog({
                    title: `Asistencia · ${holidayName}`,
                    message: 'Nadie registrado como trabajando este feriado todavía.'
                });
                return;
            }
            const list = att.map(a =>
                `• ${a.employee_name} (${a.department_name || '-'}) — ${a.schedule_text || 'sin horario'} → +${a.days_credit}d`
            ).join('\n');
            await infoDialog({
                title: `Trabajaron · ${holidayName}`,
                message: list
            });
        } catch (err) {
            Notification.error('Error: ' + err.message);
        }
    }

    // ============================================================
    // Tab: Solicitudes (time-off) — F1: firma + aprobación multinivel
    // ============================================================
    //
    // El contrato F1 (/api/hr/time-off, 7 endpoints) cambia varias cosas
    // respecto al flujo viejo, y este módulo las consume al pie de la letra:
    //   - Crear exige una FIRMA electrónica (checkbox + nombre EXACTO en
    //     mayúsculas + cédula). Se hace en 2 pasos: datos → firma.
    //   - Los estados ya no son sólo pending/approved/rejected/cancelled:
    //     ahora una solicitud nace en pending_jefe (sólo vacaciones) o
    //     pending_tthh (resto), y el workflow es multinivel.
    //   - Rechazar manda { comment } (NO { reason } como antes).
    //   - permiso_personal/enfermedad piden justificativo adjunto.
    //   - RRHH puede decidir si la solicitud descuenta saldo o se justifica
    //     sin descuento (waive).

    // feriado_compensado descuenta del BANCO de días, no de vacaciones/días-ley:
    // por eso el override "justificado sin descuento" (waive) NO aplica y el
    // backend devuelve 400 si se intenta. Lo excluimos en la UI de descuento.
    const TIPOS_SIN_WAIVE = ['feriado_compensado'];

    // Etiquetas legibles de cada estado del workflow (la API devuelve el code
    // crudo en snake_case; nunca mostramos el code pelado al usuario).
    const ESTADO_LABEL = {
        pending:       'Pendiente',
        pending_jefe:  'Pendiente del jefe',
        pending_tthh:  'Pendiente de RRHH',
        approved:      'Aprobada',
        rejected:      'Rechazada',
        cancelled:     'Cancelada'
    };

    // Clase de badge del design system por estado. Los pendientes van en
    // info/ámbar, aprobado en verde, rechazado/cancelado en rojo/gris.
    const ESTADO_BADGE = {
        pending:       'badge-info',
        pending_jefe:  'badge-warning',
        pending_tthh:  'badge-info',
        approved:      'badge-success',
        rejected:      'badge-danger',
        cancelled:     'badge-danger'
    };

    // Etiquetas legibles del tipo de solicitud.
    const TIPO_LABEL = {
        vacaciones:         'Vacaciones',
        feriado_compensado: 'Feriado compensado',
        permiso_personal:   'Permiso personal',
        enfermedad:         'Enfermedad',
        otro:               'Otro'
    };

    function estadoBadgeHtml(status) {
        const cls = ESTADO_BADGE[status] || 'badge-info';
        const label = ESTADO_LABEL[status] || status;
        return `<span class="badge ${cls}">${escapeHtml(label)}</span>`;
    }

    function tipoLabel(t) { return TIPO_LABEL[t] || t; }

    // ¿Está la solicitud en algún estado pendiente del workflow? (puede actuarse
    // sobre ella). 'pending' se conserva sólo por filas históricas.
    function esPendiente(status) {
        return status === 'pending' || status === 'pending_jefe' || status === 'pending_tthh';
    }

    async function loadTimeOff() {
        const tbody = document.getElementById('hr-time-off-tbody');
        const status = document.getElementById('hr-time-off-status').value;
        tbody.innerHTML = '<tr><td colspan="7" class="loading">Cargando...</td></tr>';
        try {
            const url = status ? `/api/hr/time-off?status=${encodeURIComponent(status)}` : '/api/hr/time-off';
            const r = await api('GET', url);
            const reqs = r.data.requests || [];
            if (reqs.length === 0) {
                tbody.innerHTML = '<tr><td colspan="7" class="empty">Sin solicitudes con ese filtro.</td></tr>';
                return;
            }
            tbody.innerHTML = reqs.map(req => {
                const pendiente = esPendiente(req.status);
                // En estado pendiente mostramos las acciones de aprobador; el
                // backend decide server-side si quien llama es el jefe (vacaciones
                // en pending_jefe) o RRHH (pending_tthh) y responde 403/409 si no
                // corresponde. La UI es cosmética: no es la barrera de seguridad.
                const accionesPendiente = pendiente ? `
                    <button class="btn-edit" onclick="hrAdmin.approveTimeOff(${req.id})">Aprobar</button>
                    <button class="btn-delete" onclick="hrAdmin.rejectTimeOff(${req.id})">Rechazar</button>
                    <button class="btn-edit" onclick="hrAdmin.cancelTimeOff(${req.id})">Cancelar</button>
                ` : '';
                return `
                    <tr>
                        <td>${escapeHtml(req.employee_name)}<br><small>${escapeHtml(req.department_name || '')}</small></td>
                        <td>${escapeHtml(tipoLabel(req.request_type))}</td>
                        <td>${escapeHtml(fmtDate(req.date_from))}</td>
                        <td>${escapeHtml(fmtDate(req.date_to))}</td>
                        <td>${escapeHtml(String(req.days_count))}</td>
                        <td>${estadoBadgeHtml(req.status)}</td>
                        <td>
                            <button class="btn-edit" onclick="hrAdmin.openTimeOffDetail(${req.id})">Detalle</button>
                            ${accionesPendiente}
                        </td>
                    </tr>
                `;
            }).join('');
        } catch (err) {
            // Mensaje genérico: nunca filtramos internals del servidor al usuario.
            tbody.innerHTML = `<tr><td colspan="7" class="error">${escapeHtml(err.message)}</td></tr>`;
        }
    }

    // --- Crear solicitud + FIRMA (2 pasos) ------------------------------------
    // Paso 1: datos de la solicitud. Paso 2: firma electrónica (checkbox +
    // nombre EXACTO en mayúsculas + cédula). El nombre del firmante debe
    // coincidir con el full_name del empleado objetivo (confirmación tipo
    // "tipeá para confirmar"); lo validamos en cliente para fallar rápido y
    // claro, pero el backend lo re-valida y devuelve 422 si no coincide.
    async function openCreateTimeOff() {
        try {
            const me = await api('GET', '/api/hr/me');
            const myEmployee = me.data.employee;
            const isAdmin = Auth.isAdmin();

            // Empleados disponibles (sólo admin/RRHH puede firmar en nombre de otro).
            let emps = [];
            if (isAdmin) {
                emps = await getEmployees();
            } else if (!myEmployee) {
                Notification.error('No tenés perfil de empleado. Pedile a RRHH que te cree uno.');
                return;
            }

            const fields = [];
            if (isAdmin) {
                const opts = [{ value: '', label: 'Para mí (admin)' }]
                    .concat(emps.map(e => ({ value: String(e.id), label: `${e.full_name} (${e.department_name || '-'})` })));
                fields.push({ name: 'employee_id', label: 'Empleado', type: 'select', options: opts });
            }
            fields.push(
                { name: 'request_type', label: 'Tipo de solicitud', type: 'select', required: true,
                  options: [
                    { value: 'vacaciones',          label: 'Vacaciones (pasa por tu jefe y luego RRHH)' },
                    { value: 'feriado_compensado',  label: 'Feriado compensado (descuenta del banco)' },
                    { value: 'permiso_personal',    label: 'Permiso personal (requiere justificativo)' },
                    { value: 'enfermedad',          label: 'Enfermedad (requiere justificativo)' },
                    { value: 'otro',                label: 'Otro' }
                  ] },
                { name: 'date_from', label: 'Desde', type: 'date', required: true },
                { name: 'date_to',   label: 'Hasta', type: 'date', required: true },
                { name: 'days_count', label: 'Días totales', type: 'number', required: true, default: '1' },
                { name: 'reason', label: 'Motivo', type: 'textarea', placeholder: 'Opcional' }
            );

            const data = await formDialog({
                title: 'Nueva solicitud · Paso 1 de 2: datos',
                description: 'Tras completar los datos, en el siguiente paso firmarás electrónicamente la solicitud.',
                fields,
                confirmText: 'Continuar a la firma'
            });
            if (!data) return;

            // Validaciones de cliente para fallar rápido y claro.
            const days = Number(data.days_count);
            if (!days || days <= 0) { Notification.error('Indicá una cantidad de días válida (mayor a 0).'); return; }
            if (data.date_from > data.date_to) { Notification.error('La fecha "Desde" no puede ser posterior a "Hasta".'); return; }

            // Resolver el empleado objetivo y su nombre, para validar la firma.
            const targetEmployeeId = data.employee_id ? Number(data.employee_id) : null;
            let signerExpectedName = myEmployee ? myEmployee.full_name : null;
            if (targetEmployeeId) {
                const target = emps.find(e => e.id === targetEmployeeId);
                if (target) signerExpectedName = target.full_name;
            }

            // Paso 2: la firma. Devuelve el payload de firma o null si cancela.
            const signature = await collectSignature(signerExpectedName, data.request_type);
            if (!signature) return; // canceló la firma → no se crea nada (atómico).

            // El contrato (OpenAPI) marca employee_id y reason como OPCIONALES y de
            // tipo string — NO nullable. El backend F1 valida `typeof reason === 'string'`,
            // y como `typeof null === 'object'`, mandar null devuelve 400. Por eso los
            // campos opcionales se OMITEN cuando están vacíos (no se mandan como null);
            // así el caso normal (vacaciones/feriado sin motivo) pasa limpio.
            const payload = {
                request_type: data.request_type,
                date_from: data.date_from,
                date_to: data.date_to,
                days_count: days,
                signature
            };
            const reasonText = (data.reason || '').trim();
            if (reasonText) payload.reason = reasonText;     // sólo si el usuario escribió algo
            if (targetEmployeeId) payload.employee_id = targetEmployeeId; // sólo si es "por otro"

            const resp = await api('POST', '/api/hr/time-off', payload);

            Notification.success('Solicitud creada y firmada');
            loadTimeOff();

            // Si el tipo exige justificativo, ofrecemos subirlo en el momento
            // (la solicitud queda "para descuento" hasta que llegue la evidencia).
            const created = resp.data || {};
            if (created.requires_attachment && created.id) {
                const subir = await confirmDialog({
                    title: 'Esta solicitud requiere un justificativo',
                    message: 'Permiso personal y enfermedad necesitan evidencia (certificado médico, etc.). Mientras falte, RRHH la verá marcada "para descuento". ¿Querés subir el archivo ahora?',
                    confirmText: 'Subir justificativo',
                    cancelText: 'Más tarde',
                    danger: false
                });
                if (subir) await uploadAttachment(created.id);
            }
        } catch (err) {
            // 422 = firma inválida (no coincide el nombre, etc.). El backend ya
            // devuelve un mensaje claro; lo mostramos tal cual viene saneado.
            Notification.error('No se pudo crear: ' + err.message);
        }
    }

    // Modal de firma electrónica (paso 2). Reproduce el "papel": el firmante
    // acepta los términos, teclea su NOMBRE Y APELLIDOS en mayúsculas (debe
    // coincidir con el del empleado) y su cédula (6–13 dígitos). Devuelve
    // { accepted, signer_name, signer_doc_id } o null si cancela.
    function collectSignature(expectedName, requestType) {
        return new Promise(resolve => {
            const overlay = document.createElement('div');
            overlay.className = 'confirm-dialog-overlay';
            const expectedUpper = (expectedName || '').toUpperCase();
            overlay.innerHTML = `
                <div class="confirm-dialog" role="dialog" aria-modal="true" style="width:min(540px,92vw); max-height:88vh; overflow-y:auto;">
                    <h3>Firma electrónica · Paso 2 de 2</h3>
                    <div class="confirm-msg">
                        Al firmar, declarás que la información de la solicitud
                        (${escapeHtml(tipoLabel(requestType))}) es verídica. La firma queda
                        sellada con un hash criptográfico y no podrá alterarse.
                    </div>
                    <div class="form-group" style="margin:0.85rem 0; display:flex; align-items:flex-start; gap:0.55rem;">
                        <input type="checkbox" id="sig-accept" style="margin-top:0.25rem; width:auto;">
                        <label for="sig-accept" style="cursor:pointer;">Acepto los términos y condiciones y firmo esta solicitud de forma conforme.</label>
                    </div>
                    <div class="form-group" style="margin-bottom:0.85rem;">
                        <label for="sig-name">Nombres y apellidos (en MAYÚSCULAS) *</label>
                        <input id="sig-name" type="text" autocomplete="off" spellcheck="false"
                            placeholder="${escapeHtml(expectedUpper || 'TU NOMBRE COMPLETO')}"
                            style="width:100%; background:var(--bg-input); color:var(--text-1); border:1px solid var(--border); border-radius:var(--radius-sm); padding:0.55rem 0.75rem; text-transform:uppercase;">
                        ${expectedUpper ? `<small>Debe coincidir exactamente con: <strong>${escapeHtml(expectedUpper)}</strong></small>` : ''}
                    </div>
                    <div class="form-group" style="margin-bottom:0.85rem;">
                        <label for="sig-doc">Cédula (solo dígitos) *</label>
                        <input id="sig-doc" type="text" inputmode="numeric" autocomplete="off" spellcheck="false"
                            placeholder="Ej: 0102030405" maxlength="13"
                            style="width:100%; background:var(--bg-input); color:var(--text-1); border:1px solid var(--border); border-radius:var(--radius-sm); padding:0.55rem 0.75rem;">
                    </div>
                    <div class="sig-error" style="color:var(--danger); min-height:1.1rem; font-size:0.85rem; margin-bottom:0.4rem;"></div>
                    <div class="confirm-actions">
                        <button class="btn-confirm-cancel">Cancelar</button>
                        <button class="btn-confirm-confirm" disabled style="background:var(--primary); border-color:var(--primary);">Firmar y enviar</button>
                    </div>
                </div>
            `;
            document.body.appendChild(overlay);

            const accept = overlay.querySelector('#sig-accept');
            const nameInput = overlay.querySelector('#sig-name');
            const docInput = overlay.querySelector('#sig-doc');
            const errEl = overlay.querySelector('.sig-error');
            const cancelBtn = overlay.querySelector('.btn-confirm-cancel');
            const confirmBtn = overlay.querySelector('.btn-confirm-confirm');

            function close(result) {
                document.body.removeChild(overlay);
                document.removeEventListener('keydown', onKey);
                resolve(result);
            }
            // Normaliza el nombre tecleado a mayúsculas y valida en vivo para
            // habilitar el botón sólo cuando todo está correcto.
            function validar() {
                nameInput.value = nameInput.value.toUpperCase();
                const name = nameInput.value.trim();
                const doc = docInput.value.trim();
                let msg = '';
                if (!accept.checked) msg = 'Tenés que aceptar los términos para firmar.';
                else if (name.length < 3) msg = 'Escribí tu nombre completo.';
                else if (expectedUpper && name !== expectedUpper) msg = 'El nombre no coincide con el del empleado.';
                else if (!/^[0-9]{6,13}$/.test(doc)) msg = 'La cédula debe tener entre 6 y 13 dígitos.';
                errEl.textContent = msg;
                confirmBtn.disabled = msg !== '';
            }
            function onKey(e) {
                if (e.key === 'Escape') close(null);
                if (e.key === 'Enter' && !confirmBtn.disabled) doConfirm();
            }
            function doConfirm() {
                close({
                    accepted: true,
                    signer_name: nameInput.value.trim(),
                    signer_doc_id: docInput.value.trim()
                });
            }
            accept.addEventListener('change', validar);
            nameInput.addEventListener('input', validar);
            docInput.addEventListener('input', validar);
            document.addEventListener('keydown', onKey);
            cancelBtn.onclick = () => close(null);
            confirmBtn.onclick = doConfirm;
            overlay.onclick = (e) => { if (e.target === overlay) close(null); };
            setTimeout(() => accept.focus(), 50);
        });
    }

    // --- Adjuntar justificativo (multipart) -----------------------------------
    // Abre un selector de archivo y sube el justificativo. PDF/PNG/JPEG, ≤10 MB.
    // El backend traduce el tamaño a 413 y el tipo no permitido a 415; acá los
    // chequeamos también en cliente para evitar el viaje y dar feedback inmediato.
    const ADJUNTO_MAX_BYTES = 10 * 1024 * 1024; // 10 MB (igual que x-max-bytes de la spec).
    const ADJUNTO_MIME_OK = ['application/pdf', 'image/png', 'image/jpeg'];

    function uploadAttachment(requestId) {
        return new Promise(resolve => {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = '.pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg';
            input.style.display = 'none';
            document.body.appendChild(input);

            input.addEventListener('change', async () => {
                const file = input.files && input.files[0];
                document.body.removeChild(input);
                if (!file) { resolve(false); return; }

                if (!ADJUNTO_MIME_OK.includes(file.type)) {
                    Notification.error('Tipo no permitido. Subí un PDF, PNG o JPEG.');
                    resolve(false); return;
                }
                if (file.size > ADJUNTO_MAX_BYTES) {
                    Notification.error('El archivo supera los 10 MB permitidos.');
                    resolve(false); return;
                }
                try {
                    const fd = new FormData();
                    fd.append('file', file);
                    // No usamos el helper api() porque manda JSON; multipart va con
                    // fetch directo + sólo el header Authorization (el browser pone
                    // el Content-Type con el boundary correcto).
                    const r = await fetch(`/api/hr/time-off/${requestId}/attachment`, {
                        method: 'POST',
                        headers: { ...authHeader() },
                        body: fd
                    });
                    let body = null;
                    try { body = await r.json(); } catch { body = null; }
                    if (!r.ok) {
                        // Mensajes específicos para los códigos del contrato.
                        let msg = (body && body.message) || ('HTTP ' + r.status);
                        if (r.status === 413) msg = 'El archivo supera los 10 MB permitidos.';
                        if (r.status === 415) msg = 'Tipo no permitido. Subí un PDF, PNG o JPEG.';
                        throw new Error(msg);
                    }
                    Notification.success('Justificativo subido');
                    resolve(true);
                } catch (err) {
                    Notification.error('No se pudo subir: ' + err.message);
                    resolve(false);
                }
            }, { once: true });

            // Si el usuario cierra el selector sin elegir, limpiamos el input.
            // (no hay evento fiable de cancelación; el change con files vacío
            // cubre el caso real de "eligió nada".)
            input.click();
        });
    }

    // --- Aprobar (nivel resuelto server-side) ---------------------------------
    async function approveTimeOff(id) {
        const data = await formDialog({
            title: '¿Aprobar esta solicitud?',
            description: 'Tu rol define el nivel: si sos el jefe, pasa a RRHH; si sos RRHH, queda aprobada y se marca para descontar saldo. Podés dejar un comentario opcional.',
            fields: [
                { name: 'comment', label: 'Comentario (opcional)', type: 'textarea', placeholder: 'Opcional' }
            ],
            confirmText: 'Aprobar'
        });
        if (!data) return;
        try {
            const body = data.comment && data.comment.trim() ? { comment: data.comment.trim() } : {};
            const r = await api('POST', `/api/hr/time-off/${id}/approve`, body);
            const d = r.data || {};
            // Feedback que refleja el nivel real en el que se actuó.
            if (d.status === 'pending_tthh') Notification.success('Aprobada por el jefe. Ahora pasa a RRHH.');
            else if (d.balance_marked_for_discount) Notification.success('Aprobada por RRHH. Saldo marcado para descuento.');
            else Notification.success('Solicitud aprobada');
            loadTimeOff();
        } catch (err) {
            // 403 = no sos el aprobador válido de este nivel; 409 = orden/estado
            // (ej. RRHH quiso aprobar vacaciones que el jefe aún no aprobó).
            Notification.error('No se pudo aprobar: ' + err.message);
        }
    }

    // --- Rechazar (comentario OBLIGATORIO; el contrato usa `comment`) ----------
    async function rejectTimeOff(id) {
        const data = await formDialog({
            title: 'Rechazar solicitud',
            description: 'El motivo queda en el historial inmutable y el empleado lo verá. Es obligatorio.',
            fields: [
                { name: 'comment', label: 'Motivo del rechazo', type: 'textarea', required: true }
            ],
            confirmText: 'Rechazar solicitud'
        });
        if (!data) return;
        const comment = (data.comment || '').trim();
        if (comment.length < 3) { Notification.error('El motivo debe tener al menos 3 caracteres.'); return; }
        try {
            await api('POST', `/api/hr/time-off/${id}/reject`, { comment });
            Notification.success('Solicitud rechazada');
            loadTimeOff();
        } catch (err) {
            Notification.error('No se pudo rechazar: ' + err.message);
        }
    }

    // --- Cancelar (el dueño, mientras siga pendiente) -------------------------
    async function cancelTimeOff(id) {
        const ok = await confirmDialog({
            title: '¿Cancelar esta solicitud?',
            message: 'La solicitud queda cancelada y no se procesa. Sólo se puede cancelar mientras esté pendiente.',
            confirmText: 'Sí, cancelar',
            cancelText: 'No',
            danger: false
        });
        if (!ok) return;
        try {
            await api('POST', `/api/hr/time-off/${id}/cancel`);
            Notification.success('Solicitud cancelada');
            loadTimeOff();
        } catch (err) {
            // 409 = ya está en estado terminal; 403 = no sos el dueño ni RRHH.
            Notification.error('No se pudo cancelar: ' + err.message);
        }
    }

    // --- Decisión de descuento (EXCLUSIVO RRHH) -------------------------------
    // discount=true → descuenta saldo (normal). discount=false → "justificado
    // sin descuento" (waive), con motivo obligatorio. No aplica a
    // feriado_compensado (su saldo es el banco) → el backend da 400.
    async function openDiscountDecision(id) {
        // El tipo se relee del detalle ya cargado (no se interpola en el onclick).
        // Si por alguna razón el estado no coincide, queda null y el backend re-valida.
        const requestType = (_currentTimeOffReq && _currentTimeOffReq.id === id)
            ? _currentTimeOffReq.request_type
            : null;
        if (TIPOS_SIN_WAIVE.includes(requestType)) {
            await infoDialog({
                title: 'No aplica a feriado compensado',
                message: 'El feriado compensado descuenta del banco de días, no de vacaciones. No tiene la opción de "justificar sin descuento".'
            });
            return;
        }
        const data = await formDialog({
            title: 'Decisión de descuento (RRHH)',
            description: 'Elegí si esta solicitud descuenta saldo o se justifica sin descuento (ej. licencia por ley con acta adjunta). Si justificás sin descuento, el motivo es obligatorio.',
            fields: [
                { name: 'decision', label: 'Decisión', type: 'select', required: true, default: 'discount',
                  options: [
                    { value: 'discount', label: 'Descontar saldo (normal)' },
                    { value: 'waived',   label: 'Justificado sin descuento' }
                  ] },
                { name: 'reason', label: 'Motivo (obligatorio si justificás sin descuento)', type: 'textarea',
                  placeholder: 'Ej: Art. 42.30 - fallecimiento 2.º grado, acta adjunta' }
            ],
            confirmText: 'Guardar decisión'
        });
        if (!data) return;

        const discount = data.decision === 'discount';
        const reason = (data.reason || '').trim();
        if (!discount && reason.length < 3) {
            Notification.error('Para justificar sin descuento, el motivo es obligatorio (mín. 3 caracteres).');
            return;
        }
        try {
            // El contrato del endpoint usa { discount: bool, reason }.
            const body = { discount };
            if (reason) body.reason = reason;
            await api('POST', `/api/hr/time-off/${id}/discount-decision`, body);
            Notification.success(discount ? 'Marcada para descontar saldo' : 'Justificada sin descuento');
            // Si el modal de detalle está abierto sobre esta solicitud, lo refrescamos.
            if (_currentTimeOffId === id) await renderTimeOffDetail(id);
            loadTimeOff();
        } catch (err) {
            Notification.error('No se pudo guardar: ' + err.message);
        }
    }

    // --- Detalle / Historial de aprobación ------------------------------------
    // Abre el modal con la solicitud, su firma (+ integridad ✓/✗), los pasos del
    // workflow, los adjuntos, y las acciones contextuales (subir justificativo,
    // decisión de descuento) según el estado/tipo.
    let _currentTimeOffId = null;
    let _currentTimeOffReq = null;   // último request renderizado en el modal de detalle

    async function openTimeOffDetail(id) {
        _currentTimeOffId = id;
        document.getElementById('hr-timeoff-detail-modal').classList.add('active');
        await renderTimeOffDetail(id);
    }

    async function renderTimeOffDetail(id) {
        const body = document.getElementById('hr-timeoff-detail-body');
        const actions = document.getElementById('hr-timeoff-detail-actions');
        body.innerHTML = '<p class="loading">Cargando historial...</p>';
        actions.innerHTML = '';
        try {
            const r = await api('GET', `/api/hr/time-off/${id}/approval-history`);
            const d = r.data || {};
            const req = d.request || {};
            _currentTimeOffReq = req;         // guardamos el detalle en estado: los botones
                                              // de acción pasan sólo el id (entero) y releen
                                              // el tipo de acá, evitando interpolar datos en onclick.
            const sig = d.signature;          // puede ser null
            const steps = d.steps || [];
            const attachments = d.attachments || [];

            // --- Bloque firma ---
            let sigHtml;
            if (sig) {
                const integ = sig.signature_integrity
                    ? '<span style="color:#10b981;">✓ Integridad verificada</span>'
                    : '<span style="color:#ef4444;"><strong>✗ ALERTA: la firma no coincide (datos alterados)</strong></span>';
                sigHtml = `
                    <div class="rbac-card-section">
                        <h5>Firma electrónica</h5>
                        <p><strong>Firmante:</strong> ${escapeHtml(sig.signer_name)}</p>
                        ${sig.signer_doc_id ? `<p><strong>Cédula:</strong> ${escapeHtml(sig.signer_doc_id)}</p>` : ''}
                        <p><strong>Aceptó términos:</strong> ${sig.accepted ? 'Sí' : 'No'}</p>
                        <p><strong>Firmado:</strong> ${escapeHtml(fmtDateTime(sig.signed_at))}</p>
                        <p><strong>Integridad:</strong> ${integ}</p>
                        <p><small><strong>SHA-256:</strong> <code style="word-break:break-all;">${escapeHtml(sig.content_hash)}</code></small></p>
                    </div>`;
            } else {
                sigHtml = '<div class="rbac-card-section"><h5>Firma electrónica</h5><p class="empty-inline">Sin firma registrada.</p></div>';
            }

            // --- Bloque pasos del workflow ---
            let stepsHtml;
            if (steps.length > 0) {
                stepsHtml = '<ul style="margin:0.4rem 0 0; padding-left:1.1rem;">' + steps.map(s => {
                    const nivel = s.step_level === 'jefe' ? 'Jefe' : 'RRHH';
                    const accion = s.action === 'approve' ? 'aprobó' : 'rechazó';
                    const quien = s.approver_name || ('Usuario #' + s.approver_user_id);
                    const comentario = s.comment ? ` — <em>"${escapeHtml(s.comment)}"</em>` : '';
                    return `<li><strong>${escapeHtml(nivel)}</strong>: ${escapeHtml(quien)} ${accion} · ${escapeHtml(fmtDateTime(s.acted_at))}${comentario}</li>`;
                }).join('') + '</ul>';
            } else {
                stepsHtml = '<p class="empty-inline">Todavía nadie actuó sobre esta solicitud.</p>';
            }

            // --- Bloque adjuntos (metadatos, sin binario) ---
            let attachHtml;
            if (attachments.length > 0) {
                attachHtml = '<ul style="margin:0.4rem 0 0; padding-left:1.1rem;">' + attachments.map(a =>
                    `<li>${escapeHtml(a.file_name)} <small>(${escapeHtml(a.mime_type)}${a.file_size ? ', ' + fmtSize(a.file_size) : ''}) · ${escapeHtml(fmtDateTime(a.uploaded_at))}</small></li>`
                ).join('') + '</ul>';
            } else {
                attachHtml = '<p class="empty-inline">Sin justificativos adjuntos.</p>';
            }

            // --- Decisión de descuento (resumen) ---
            const descLabel = {
                pending:  'Pendiente de decisión',
                discount: 'Descuenta saldo',
                waived:   'Justificada sin descuento'
            }[req.discount_decision] || req.discount_decision || '-';

            body.innerHTML = `
                <div class="rbac-context-card">
                    <div class="rbac-card-section">
                        <h4>${escapeHtml(tipoLabel(req.request_type))} · ${estadoBadgeHtml(req.status)}</h4>
                        <p><strong>Descuento:</strong> ${escapeHtml(descLabel)}
                           ${req.waived_reason ? `<br><small>Motivo: ${escapeHtml(req.waived_reason)}</small>` : ''}</p>
                    </div>
                    ${sigHtml}
                    <div class="rbac-card-section">
                        <h5>Pasos de aprobación</h5>
                        ${stepsHtml}
                    </div>
                    <div class="rbac-card-section">
                        <h5>Justificativos</h5>
                        ${attachHtml}
                    </div>
                </div>
            `;

            // --- Acciones contextuales del pie del modal ---
            const botones = [];
            if (esPendiente(req.status)) {
                // Subir adjunto: sólo tiene sentido mientras la solicitud está
                // pendiente (el backend lo rechaza sobre estados terminales).
                botones.push(`<button class="btn btn-outline" onclick="hrAdmin.uploadAttachmentFromDetail(${req.id})">Subir justificativo</button>`);
            }
            // Decisión de descuento (RRHH): aplica sobre pendiente de TTHH o
            // aprobada, y nunca a feriado_compensado. Si el usuario no es RRHH,
            // el backend responde 403 — el botón es cosmético.
            const puedeDecidirDescuento =
                !TIPOS_SIN_WAIVE.includes(req.request_type) &&
                (req.status === 'pending_tthh' || req.status === 'approved');
            if (puedeDecidirDescuento) {
                botones.push(`<button class="btn btn-outline" onclick="hrAdmin.openDiscountDecision(${req.id})">Decisión de descuento</button>`);
            }
            actions.innerHTML = botones.join('');
        } catch (err) {
            body.innerHTML = `<p class="error">${escapeHtml(err.message)}</p>`;
        }
    }

    // Subir adjunto desde el modal de detalle y refrescar el detalle al volver.
    async function uploadAttachmentFromDetail(id) {
        const ok = await uploadAttachment(id);
        if (ok && _currentTimeOffId === id) await renderTimeOffDetail(id);
    }

    // Formatea una fecha-hora ISO a algo legible y corto (sin segundos).
    function fmtDateTime(s) {
        if (!s) return '-';
        const d = new Date(s);
        if (isNaN(d.getTime())) return String(s);
        return d.toLocaleString('es-EC', {
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit'
        });
    }

    // Tamaño de archivo legible (KB/MB) a partir de bytes.
    function fmtSize(bytes) {
        const n = Number(bytes) || 0;
        if (n < 1024) return n + ' B';
        if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
        return (n / (1024 * 1024)).toFixed(1) + ' MB';
    }

    // ------------------------------------------------------------
    // Tab: Memos / Comunicados (PR-3d)
    // ------------------------------------------------------------
    let _memosView = 'inbox'; // 'inbox' | 'sent'
    let _currentMemoId = null;

    function highlightMemosToggle() {
        const inbox = document.getElementById('hr-memos-btn-inbox');
        const sent  = document.getElementById('hr-memos-btn-sent');
        if (inbox) inbox.classList.toggle('btn-primary', _memosView === 'inbox');
        if (sent)  sent.classList.toggle('btn-primary',  _memosView === 'sent');
    }

    async function switchMemosView(view) {
        _memosView = view === 'sent' ? 'sent' : 'inbox';
        highlightMemosToggle();
        await loadMemos();
    }

    async function loadMemos() {
        const tbody = document.getElementById('hr-memos-tbody');
        tbody.innerHTML = '<tr><td colspan="7" class="loading">Cargando...</td></tr>';
        highlightMemosToggle();
        try {
            const url = _memosView === 'sent' ? '/api/hr/memos/sent' : '/api/hr/memos/inbox';
            const r = await api('GET', url);
            const memos = r.data.memos || [];
            if (memos.length === 0) {
                tbody.innerHTML = `<tr><td colspan="7" class="empty">Sin memos en ${_memosView === 'sent' ? 'enviados' : 'tu bandeja'}.</td></tr>`;
                return;
            }
            tbody.innerHTML = memos.map(m => {
                const target = m.target_type === 'all' ? 'Toda la empresa'
                              : m.target_type === 'department' ? `Depto #${m.target_id}`
                              : `Empleado #${m.target_id}`;
                const sentInfo = _memosView === 'sent'
                    ? `${target}<br><small>${m.ack_count || 0} acuse${(m.ack_count || 0) !== 1 ? 's' : ''}</small>`
                    : `${target}<br><small>De: ${escapeHtml(m.issued_by_full_name || m.issued_by_username || '-')}</small>`;
                const sevBadge = m.severity === 'sanction' ? 'badge-danger'
                                : m.severity === 'warning' ? 'badge-warning'
                                : 'badge-info';
                const stateBadge = _memosView === 'sent'
                    ? (m.superseded_by ? '<span class="badge badge-warning">Reemplazado</span>'
                                       : '<span class="badge badge-success">Vigente</span>')
                    : (m.acknowledged ? '<span class="badge badge-success">Acusado</span>'
                                      : '<span class="badge badge-info">Sin acuse</span>');
                return `
                    <tr>
                        <td><strong>${escapeHtml(m.subject)}</strong></td>
                        <td>${escapeHtml(m.target_type)}</td>
                        <td>${sentInfo}</td>
                        <td><span class="badge ${sevBadge}">${escapeHtml(m.severity)}</span></td>
                        <td>${escapeHtml(fmtDate(m.issued_at))}</td>
                        <td>${stateBadge}</td>
                        <td>
                            <button class="btn-edit" onclick="hrAdmin.viewMemo(${m.id})">Ver</button>
                        </td>
                    </tr>
                `;
            }).join('');
        } catch (err) {
            tbody.innerHTML = `<tr><td colspan="7" class="error">${escapeHtml(err.message)}</td></tr>`;
        }
    }

    async function viewMemo(id) {
        try {
            const r = await api('GET', `/api/hr/memos/${id}`);
            const m = r.data.memo;
            const integrity = r.data.content_integrity;
            const myAck = r.data.my_ack;
            const acks = r.data.acknowledgments;
            _currentMemoId = id;

            document.getElementById('hr-memo-view-subject').textContent = m.subject;
            document.getElementById('hr-memo-view-content').textContent = m.content;

            const meta = document.getElementById('hr-memo-view-meta');
            meta.innerHTML = `
                <p><strong>De:</strong> ${escapeHtml(m.issued_by_full_name || m.issued_by_username || '-')}</p>
                <p><strong>Para:</strong> ${escapeHtml(m.target_name || m.target_type)}</p>
                <p><strong>Severidad:</strong> ${escapeHtml(m.severity)}</p>
                <p><strong>Emitido:</strong> ${escapeHtml(fmtDate(m.issued_at))}</p>
                ${m.superseded_by ? `<p><strong style="color:#f59e0b">Reemplazado por memo #${m.superseded_by}</strong></p>` : ''}
                <p><small><strong>SHA-256:</strong> <code>${escapeHtml(m.content_hash)}</code></small></p>
            `;

            const integEl = document.getElementById('hr-memo-view-integrity');
            integEl.innerHTML = integrity
                ? '<p style="color:#10b981;">✓ Integridad verificada — el contenido coincide con el hash original.</p>'
                : '<p style="color:#ef4444;"><strong>⚠ ALERTA:</strong> el hash NO coincide con el contenido. El memo fue alterado en la base de datos.</p>';

            const acksEl = document.getElementById('hr-memo-view-acks');
            if (acks && acks.length > 0) {
                acksEl.innerHTML = '<h5 style="margin-top:1rem;">Acuses de recibo</h5><ul>' +
                    acks.map(a => `<li>${escapeHtml(a.full_name || a.username)} — ${escapeHtml(fmtDate(a.acknowledged_at))} (${escapeHtml(a.ip_address || '-')})</li>`).join('') +
                    '</ul>';
            } else if (acks) {
                acksEl.innerHTML = '<p class="empty-inline">Sin acuses todavía.</p>';
            } else {
                acksEl.innerHTML = '';
            }

            const ackBtn = document.getElementById('hr-memo-view-ack-btn');
            if (myAck) {
                ackBtn.style.display = 'none';
            } else {
                ackBtn.style.display = '';
                ackBtn.disabled = false;
                ackBtn.textContent = 'Acusar recibo';
            }

            document.getElementById('hr-memo-view-modal').classList.add('active');
        } catch (err) {
            Notification.error('No se pudo abrir: ' + err.message);
        }
    }

    async function ackCurrentMemo() {
        if (!_currentMemoId) return;
        const btn = document.getElementById('hr-memo-view-ack-btn');
        if (btn) { btn.disabled = true; btn.textContent = 'Registrando...'; }
        try {
            await api('POST', `/api/hr/memos/${_currentMemoId}/ack`);
            Notification.success('Acuse registrado');
            btn.style.display = 'none';
            await loadMemos();
        } catch (err) {
            Notification.error('No se pudo acusar: ' + err.message);
            if (btn) { btn.disabled = false; btn.textContent = 'Acusar recibo'; }
        }
    }

    async function openCreateMemo() {
        try {
            // Cargar empleados + departamentos para los selects.
            const [emps, depts] = await Promise.all([getEmployees(), getDepartments()]);
            const empSel  = document.getElementById('hr-memo-target-employee');
            const deptSel = document.getElementById('hr-memo-target-department');
            empSel.innerHTML  = emps.map(e => `<option value="${e.id}">${escapeHtml(e.full_name)} (${escapeHtml(e.department_name || '-')})</option>`).join('');
            deptSel.innerHTML = depts.map(d => `<option value="${d.id}">${escapeHtml(d.name)}</option>`).join('');

            // Reset form.
            document.getElementById('hr-memo-create-form').reset();
            document.getElementById('hr-memo-target-type').value = 'employee';
            onMemoTargetTypeChange();

            document.getElementById('hr-memo-create-modal').classList.add('active');
        } catch (err) {
            Notification.error('No se pudo abrir el formulario: ' + err.message);
        }
    }

    function onMemoTargetTypeChange() {
        const type = document.getElementById('hr-memo-target-type').value;
        document.getElementById('hr-memo-target-employee-row').style.display   = type === 'employee'   ? '' : 'none';
        document.getElementById('hr-memo-target-department-row').style.display = type === 'department' ? '' : 'none';
    }

    async function submitCreateMemo(e) {
        e.preventDefault();
        const submitBtn = e.target.querySelector('button[type="submit"]');
        if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Emitiendo...'; }
        try {
            const target_type = document.getElementById('hr-memo-target-type').value;
            let target_id = null;
            if (target_type === 'employee')   target_id = Number(document.getElementById('hr-memo-target-employee').value);
            if (target_type === 'department') target_id = Number(document.getElementById('hr-memo-target-department').value);

            const body = {
                subject: document.getElementById('hr-memo-subject').value.trim(),
                content: document.getElementById('hr-memo-content').value,
                target_type,
                target_id,
                severity: document.getElementById('hr-memo-severity').value
            };
            await api('POST', '/api/hr/memos', body);
            Notification.success('Memo emitido');
            document.getElementById('hr-memo-create-modal').classList.remove('active');
            _memosView = 'sent';
            await loadMemos();
        } catch (err) {
            Notification.error('No se pudo emitir: ' + err.message);
        } finally {
            if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Emitir Memo'; }
        }
    }

    document.addEventListener('DOMContentLoaded', () => {
        const f = document.getElementById('hr-memo-create-form');
        if (f) f.addEventListener('submit', submitCreateMemo);
    });

    // Inicializar listeners de tabs cuando el DOM está listo.
    document.addEventListener('DOMContentLoaded', setupTabs);

    // PR-3a: backfill — crea hr_employees mínimos para users sin perfil.
    // Pensado para una sola corrida después de crear muchos usuarios, pero
    // es idempotente: si ya están todos sincronizados devuelve created: 0.
    async function syncFromUsers() {
        const ok = await confirmDialog({
            title: '¿Sincronizar perfiles de empleado?',
            message: 'Se creará un perfil de empleado mínimo para cada usuario activo que aún no tenga uno. Es idempotente (si ya están todos, no hace nada).',
            confirmText: 'Sincronizar',
            danger: false
        });
        if (!ok) return;
        try {
            const r = await api('POST', '/api/hr/employees/sync-from-users');
            const created = r.data?.created ?? 0;
            const scanned = r.data?.total_scanned ?? 0;
            if (created === 0) {
                Notification.info('Todos los usuarios ya tienen perfil de empleado');
            } else {
                Notification.success(`Se crearon ${created} perfil(es) de empleado. Completá los datos faltantes (cargo, doc, fecha de ingreso).`);
            }
            loadEmployees();
        } catch (err) {
            Notification.error(err.message || 'Error al sincronizar empleados');
        }
    }

    return {
        loadMe,
        loadEmployees, openCreateEmployee, editEmployee, deleteEmployee, viewBalance,
        syncFromUsers,
        loadHolidays, openCreateHoliday, deleteHoliday,
            openRegisterAttendance, viewAttendance,
        loadTimeOff, openCreateTimeOff,
            approveTimeOff, rejectTimeOff, cancelTimeOff,
            openTimeOffDetail, openDiscountDecision, uploadAttachmentFromDetail,
        // PR-3d Memos
        loadMemos, switchMemosView, openCreateMemo, viewMemo, ackCurrentMemo,
            onMemoTargetTypeChange
    };
})();

// CRÍTICO: exponer hrAdmin como global. Los onclick="hrAdmin.editEmployee(1)"
// generados por displayEmployees() / loadHolidays() / loadTimeOff() / loadMemos()
// dependen de window.hrAdmin existiendo. Sin esto, los botones se ven pero al
// clickearlos no pasa nada (ReferenceError silencioso porque IIFE encapsula).
window.hrAdmin = hrAdmin;
