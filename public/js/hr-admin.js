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
 * UI austera (window.prompt para inputs cortos). Modales del design system
 * antigravity llegan en Fase 2.
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
            tbody.innerHTML = emps.map(e => `
                <tr>
                    <td>
                        <strong>${escapeHtml(e.full_name)}</strong>
                        ${e.user_username ? `<br><small>@${escapeHtml(e.user_username)}</small>` : ''}
                    </td>
                    <td>${escapeHtml(e.position_title || '-')}</td>
                    <td>${escapeHtml(e.department_name || '-')}</td>
                    <td><span class="badge ${e.status === 'active' ? 'badge-success' : 'badge-danger'}">${escapeHtml(e.status)}</span></td>
                    <td>${escapeHtml(fmtDate(e.hire_date) || '-')}</td>
                    <td>
                        <button class="btn-edit" onclick="hrAdmin.editEmployee(${e.id})">Editar</button>
                        <button class="btn-edit" onclick="hrAdmin.viewBalance(${e.id}, '${escapeHtml(e.full_name).replace(/'/g, "\\'")}')">Saldo</button>
                    </td>
                </tr>
            `).join('');
        } catch (err) {
            tbody.innerHTML = `<tr><td colspan="6" class="error">${escapeHtml(err.message)}</td></tr>`;
        }
    }

    async function openCreateEmployee() {
        const fullName = window.prompt('Nombre completo del empleado:');
        if (!fullName) return;
        try {
            const positions = await getPositions();
            const depts = await getDepartments();
            const posList = positions.map((p, i) => `${i + 1}. ${p.title} [${p.code}]`).join('\n');
            const posIdx = window.prompt('Cargo (número):\n' + posList);
            if (posIdx === null) return;
            const pos = positions[Number(posIdx) - 1];
            if (!pos) { Notification.error('Cargo inválido'); return; }
            const deptList = depts.map((d, i) => `${i + 1}. ${d.name} [${d.code}]`).join('\n');
            const deptIdx = window.prompt('Departamento (número):\n' + deptList);
            if (deptIdx === null) return;
            const dept = depts[Number(deptIdx) - 1];
            if (!dept) { Notification.error('Departamento inválido'); return; }
            const hire = window.prompt('Fecha de ingreso (YYYY-MM-DD):', new Date().toISOString().slice(0, 10));
            const docId = window.prompt('Documento de identidad (opcional):') || null;

            await api('POST', '/api/hr/employees', {
                full_name: fullName,
                position_id: pos.id,
                department_id: dept.id,
                hire_date: hire || null,
                doc_id: docId
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
            const newName = window.prompt('Nombre completo:', e.full_name);
            if (newName === null) return;
            const newStatus = window.prompt('Estado (active / on_leave / terminated):', e.status);
            if (newStatus === null) return;
            await api('PUT', `/api/hr/employees/${id}`, {
                full_name: newName,
                status: newStatus
            });
            Notification.success('Empleado actualizado');
            invalidateEmployeesCache();
            loadEmployees();
        } catch (err) {
            Notification.error('No se pudo actualizar: ' + err.message);
        }
    }

    async function viewBalance(id, name) {
        try {
            const r = await api('GET', `/api/hr/employees/${id}/compensated-balance`);
            const d = r.data;
            window.alert(
                `Banco de días compensados de ${name}:\n\n` +
                `  Acumulados: ${d.days_accrued}\n` +
                `  Usados:     ${d.days_used}\n` +
                `  Disponibles: ${d.balance}`
            );
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
        const date = window.prompt('Fecha del feriado (YYYY-MM-DD):');
        if (!date) return;
        const name = window.prompt('Nombre del feriado:');
        if (!name) return;
        const desc = window.prompt('Descripción (opcional, ej: "Decretado por gobierno"):');
        const isNational = window.confirm('¿Es feriado nacional? (Cancel = decretado custom)');
        try {
            await api('POST', '/api/hr/holidays', {
                holiday_date: date,
                name,
                description: desc || null,
                is_national: isNational
            });
            Notification.success('Feriado creado');
            loadHolidays();
        } catch (err) {
            Notification.error('No se pudo crear: ' + err.message);
        }
    }

    async function deleteHoliday(id) {
        if (!window.confirm('¿Archivar este feriado? Las asistencias históricas se preservan.')) return;
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
                Notification.error('No hay empleados registrados todavía. Crealos primero.');
                return;
            }
            const list = emps.map((e, i) => `${i + 1}. ${e.full_name} (${e.department_name || '-'})`).join('\n');
            const idx = window.prompt(
                `Registrar quien trabajó "${holidayName}" (${holidayDate}):\n\n` +
                'Empleado (número):\n' + list
            );
            if (idx === null) return;
            const emp = emps[Number(idx) - 1];
            if (!emp) { Notification.error('Empleado inválido'); return; }
            const schedule = window.prompt('Horario (ej: "7:00 a 5:00"):', '7:00 a 5:00');
            if (schedule === null) return;
            const credit = window.prompt('Días de crédito al banco (default 1):', '1');
            if (credit === null) return;
            await api('POST', `/api/hr/holidays/${holidayId}/attendance`, {
                employee_id: emp.id,
                schedule_text: schedule,
                days_credit: Number(credit) || 1
            });
            Notification.success(`Asistencia registrada: ${emp.full_name} +${credit}d al banco`);
        } catch (err) {
            Notification.error('No se pudo registrar: ' + err.message);
        }
    }

    async function viewAttendance(holidayId, holidayName) {
        try {
            const r = await api('GET', `/api/hr/holidays/${holidayId}/attendance`);
            const att = r.data.attendance || [];
            if (att.length === 0) {
                window.alert(`Nadie registrado como trabajando "${holidayName}" aún.`);
                return;
            }
            const list = att.map(a =>
                `  • ${a.employee_name} (${a.department_name || '-'}) — ${a.schedule_text || 'sin horario'} → +${a.days_credit}d`
            ).join('\n');
            window.alert(`Trabajaron en "${holidayName}":\n\n${list}`);
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

            let employeeId = null;
            if (isAdmin) {
                const emps = await getEmployees();
                const list = emps.map((e, i) => `${i + 1}. ${e.full_name}`).join('\n');
                const idx = window.prompt('Solicitar para qué empleado? (número, vacío = vos):\n' + list);
                if (idx === null) return;
                if (idx) {
                    const emp = emps[Number(idx) - 1];
                    if (!emp) { Notification.error('Empleado inválido'); return; }
                    employeeId = emp.id;
                }
            } else if (!myEmployee) {
                Notification.error('No tenés perfil de empleado. Pedile a RRHH que te cree uno.');
                return;
            }

            const types = ['vacaciones', 'feriado_compensado', 'permiso_personal', 'enfermedad', 'otro'];
            const typeIdx = window.prompt(
                'Tipo de solicitud:\n' +
                types.map((t, i) => `${i + 1}. ${t}`).join('\n')
            );
            const type = types[Number(typeIdx) - 1];
            if (!type) return;

            const dateFrom = window.prompt('Desde (YYYY-MM-DD):');
            if (!dateFrom) return;
            const dateTo = window.prompt('Hasta (YYYY-MM-DD):', dateFrom);
            if (!dateTo) return;
            const daysStr = window.prompt('Días totales:');
            const days = Number(daysStr);
            if (!days || days <= 0) { Notification.error('Días inválido'); return; }
            const reason = window.prompt('Motivo (opcional):') || null;

            await api('POST', '/api/hr/time-off', {
                employee_id: employeeId,
                request_type: type,
                date_from: dateFrom,
                date_to: dateTo,
                days_count: days,
                reason
            });
            Notification.success('Solicitud creada');
            loadTimeOff();
        } catch (err) {
            Notification.error('No se pudo crear: ' + err.message);
        }
    }

    async function approveTimeOff(id) {
        if (!window.confirm('¿Aprobar esta solicitud? Si es feriado_compensado, descuenta del banco.')) return;
        try {
            await api('POST', `/api/hr/time-off/${id}/approve`);
            Notification.success('Solicitud aprobada');
            loadTimeOff();
        } catch (err) {
            Notification.error('No se pudo aprobar: ' + err.message);
        }
    }

    async function rejectTimeOff(id) {
        const reason = window.prompt('Motivo del rechazo:');
        if (reason === null) return;
        try {
            await api('POST', `/api/hr/time-off/${id}/reject`, { reason });
            Notification.success('Solicitud rechazada');
            loadTimeOff();
        } catch (err) {
            Notification.error('No se pudo rechazar: ' + err.message);
        }
    }

    async function cancelTimeOff(id) {
        if (!window.confirm('¿Cancelar esta solicitud?')) return;
        try {
            await api('POST', `/api/hr/time-off/${id}/cancel`);
            Notification.success('Solicitud cancelada');
            loadTimeOff();
        } catch (err) {
            Notification.error('No se pudo cancelar: ' + err.message);
        }
    }

    // Inicializar listeners de tabs cuando el DOM está listo.
    document.addEventListener('DOMContentLoaded', setupTabs);

    return {
        loadMe,
        loadEmployees, openCreateEmployee, editEmployee, viewBalance,
        loadHolidays, openCreateHoliday, deleteHoliday,
            openRegisterAttendance, viewAttendance,
        loadTimeOff, openCreateTimeOff,
            approveTimeOff, rejectTimeOff, cancelTimeOff
    };
})();
