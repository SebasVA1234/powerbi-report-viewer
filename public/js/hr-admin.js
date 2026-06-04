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
            const data = await formDialog({
                title: `Editar empleado · ${e.full_name}`,
                fields: [
                    { name: 'full_name', label: 'Nombre completo', type: 'text', required: true, default: e.full_name },
                    { name: 'status', label: 'Estado', type: 'select', required: true, default: e.status,
                      options: [
                        { value: 'active', label: 'Activo' },
                        { value: 'on_leave', label: 'En licencia' },
                        { value: 'terminated', label: 'Dado de baja' }
                      ] }
                ],
                confirmText: 'Guardar cambios'
            });
            if (!data) return;
            await api('PUT', `/api/hr/employees/${id}`, {
                full_name: data.full_name.trim(),
                status: data.status
            });
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

    // ------------------------------------------------------------
    // Tab: Solicitudes (time-off)
    // ------------------------------------------------------------
    async function loadTimeOff() {
        const tbody = document.getElementById('hr-time-off-tbody');
        const status = document.getElementById('hr-time-off-status').value;
        tbody.innerHTML = '<tr><td colspan="7" class="loading">Cargando...</td></tr>';
        try {
            const url = status ? `/api/hr/time-off?status=${status}` : '/api/hr/time-off';
            const r = await api('GET', url);
            const reqs = r.data.requests || [];
            if (reqs.length === 0) {
                tbody.innerHTML = '<tr><td colspan="7" class="empty">Sin solicitudes con ese filtro.</td></tr>';
                return;
            }
            tbody.innerHTML = reqs.map(req => {
                const isPending = req.status === 'pending';
                return `
                    <tr>
                        <td>${escapeHtml(req.employee_name)}<br><small>${escapeHtml(req.department_name || '')}</small></td>
                        <td>${escapeHtml(req.request_type)}</td>
                        <td>${escapeHtml(fmtDate(req.date_from))}</td>
                        <td>${escapeHtml(fmtDate(req.date_to))}</td>
                        <td>${req.days_count}</td>
                        <td><span class="badge ${req.status === 'approved' ? 'badge-success' : req.status === 'pending' ? 'badge-info' : 'badge-danger'}">${escapeHtml(req.status)}</span></td>
                        <td>
                            ${isPending ? `<button class="btn-edit" onclick="hrAdmin.approveTimeOff(${req.id})">Aprobar</button>` : ''}
                            ${isPending ? `<button class="btn-delete" onclick="hrAdmin.rejectTimeOff(${req.id})">Rechazar</button>` : ''}
                            ${isPending ? `<button class="btn-edit" onclick="hrAdmin.cancelTimeOff(${req.id})">Cancelar</button>` : ''}
                            ${!isPending && req.rejection_reason ? `<small title="${escapeHtml(req.rejection_reason)}">📝</small>` : ''}
                        </td>
                    </tr>
                `;
            }).join('');
        } catch (err) {
            tbody.innerHTML = `<tr><td colspan="7" class="error">${escapeHtml(err.message)}</td></tr>`;
        }
    }

    async function openCreateTimeOff() {
        try {
            const me = await api('GET', '/api/hr/me');
            const myEmployee = me.data.employee;
            const isAdmin = Auth.isAdmin();

            const fields = [];
            if (isAdmin) {
                const emps = await getEmployees();
                const opts = [{ value: '', label: 'Para mí (admin)' }]
                    .concat(emps.map(e => ({ value: e.id, label: `${e.full_name} (${e.department_name || '-'})` })));
                fields.push({ name: 'employee_id', label: 'Empleado', type: 'select', options: opts });
            } else if (!myEmployee) {
                Notification.error('No tenés perfil de empleado. Pedile a RRHH que te cree uno.');
                return;
            }
            fields.push(
                { name: 'request_type', label: 'Tipo de solicitud', type: 'select', required: true,
                  options: [
                    { value: 'vacaciones',          label: 'Vacaciones' },
                    { value: 'feriado_compensado',  label: 'Feriado compensado (descuenta del banco)' },
                    { value: 'permiso_personal',    label: 'Permiso personal' },
                    { value: 'enfermedad',          label: 'Enfermedad' },
                    { value: 'otro',                label: 'Otro' }
                  ] },
                { name: 'date_from', label: 'Desde', type: 'date', required: true },
                { name: 'date_to',   label: 'Hasta', type: 'date', required: true },
                { name: 'days_count', label: 'Días totales', type: 'number', required: true, default: '1' },
                { name: 'reason', label: 'Motivo', type: 'textarea', placeholder: 'Opcional' }
            );

            const data = await formDialog({
                title: 'Nueva solicitud de tiempo libre',
                fields,
                confirmText: 'Crear solicitud'
            });
            if (!data) return;

            const days = Number(data.days_count);
            if (!days || days <= 0) { Notification.error('Días inválido'); return; }

            await api('POST', '/api/hr/time-off', {
                employee_id: data.employee_id ? Number(data.employee_id) : null,
                request_type: data.request_type,
                date_from: data.date_from,
                date_to: data.date_to,
                days_count: days,
                reason: data.reason || null
            });
            Notification.success('Solicitud creada');
            loadTimeOff();
        } catch (err) {
            Notification.error('No se pudo crear: ' + err.message);
        }
    }

    async function approveTimeOff(id) {
        const ok = await confirmDialog({
            title: '¿Aprobar esta solicitud?',
            message: 'Si la solicitud es de tipo "feriado compensado", se descuenta automáticamente del banco del empleado.',
            confirmText: 'Aprobar',
            danger: false
        });
        if (!ok) return;
        try {
            await api('POST', `/api/hr/time-off/${id}/approve`);
            Notification.success('Solicitud aprobada');
            loadTimeOff();
        } catch (err) {
            Notification.error('No se pudo aprobar: ' + err.message);
        }
    }

    async function rejectTimeOff(id) {
        const data = await formDialog({
            title: 'Rechazar solicitud',
            description: 'El empleado verá este motivo cuando consulte el estado.',
            fields: [
                { name: 'reason', label: 'Motivo del rechazo', type: 'textarea', required: true }
            ],
            confirmText: 'Rechazar solicitud'
        });
        if (!data) return;
        try {
            await api('POST', `/api/hr/time-off/${id}/reject`, { reason: data.reason });
            Notification.success('Solicitud rechazada');
            loadTimeOff();
        } catch (err) {
            Notification.error('No se pudo rechazar: ' + err.message);
        }
    }

    async function cancelTimeOff(id) {
        const ok = await confirmDialog({
            title: '¿Cancelar esta solicitud?',
            message: 'La solicitud queda cancelada y no se procesa. Si era de feriado compensado, no se descuenta del banco.',
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
            Notification.error('No se pudo cancelar: ' + err.message);
        }
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
