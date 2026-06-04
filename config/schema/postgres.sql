-- Schema PostgreSQL — equivalente al SQLite, con tipos nativos PG.
-- Idempotente: usa CREATE TABLE IF NOT EXISTS.
-- Notas de tipo:
--   * SERIAL en vez de INTEGER PK AUTOINCREMENT
--   * BYTEA en vez de BLOB
--   * TIMESTAMP en vez de DATETIME
--   * INTEGER (0/1) para booleanos — mantiene compat con código actual
--   * JSONB para rubros_dinamicos / snapshot

CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    full_name TEXT NOT NULL,
    role TEXT DEFAULT 'user' CHECK(role IN ('admin', 'user')),
    is_active INTEGER DEFAULT 1,
    must_change_password INTEGER DEFAULT 0,
    -- PR-0b.1: ver sqlite.sql.
    totp_secret TEXT,
    totp_enabled INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS reports (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    embed_url TEXT NOT NULL,
    category TEXT,
    is_active INTEGER DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS user_report_permissions (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL,
    report_id INTEGER NOT NULL,
    can_view INTEGER DEFAULT 1,
    can_export INTEGER DEFAULT 0,
    granted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    granted_by INTEGER,
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
    FOREIGN KEY (report_id) REFERENCES reports (id) ON DELETE CASCADE,
    FOREIGN KEY (granted_by) REFERENCES users (id),
    UNIQUE(user_id, report_id)
);

CREATE TABLE IF NOT EXISTS documents (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    category TEXT,
    file_name TEXT NOT NULL,
    mime_type TEXT NOT NULL DEFAULT 'application/pdf',
    file_size INTEGER NOT NULL,
    file_data BYTEA NOT NULL,
    is_active INTEGER DEFAULT 1,
    uploaded_by INTEGER,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (uploaded_by) REFERENCES users (id)
);

CREATE TABLE IF NOT EXISTS user_document_permissions (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL,
    document_id INTEGER NOT NULL,
    can_view INTEGER DEFAULT 1,
    granted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    granted_by INTEGER,
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
    FOREIGN KEY (document_id) REFERENCES documents (id) ON DELETE CASCADE,
    FOREIGN KEY (granted_by) REFERENCES users (id),
    UNIQUE(user_id, document_id)
);

CREATE TABLE IF NOT EXISTS access_logs (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL,
    report_id INTEGER,
    document_id INTEGER,
    action TEXT NOT NULL,
    ip_address TEXT,
    user_agent TEXT,
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
    FOREIGN KEY (report_id) REFERENCES reports (id) ON DELETE CASCADE,
    FOREIGN KEY (document_id) REFERENCES documents (id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS system_config (
    id SERIAL PRIMARY KEY,
    config_key TEXT UNIQUE NOT NULL,
    config_value TEXT NOT NULL,
    description TEXT,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================
-- COTIZADOR LANDED COST · v2 (refactor PR-finalize-prototype)
-- Ver sqlite.sql para descripción detallada del modelo.
-- ============================================================

CREATE TABLE IF NOT EXISTS airports (
    id SERIAL PRIMARY KEY,
    iata_code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    city TEXT NOT NULL,
    country TEXT NOT NULL,
    country_code TEXT NOT NULL,
    is_active INTEGER DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS aerolineas (
    id SERIAL PRIMARY KEY,
    nombre TEXT NOT NULL,
    codigo_iata TEXT UNIQUE,
    codigo_pais TEXT,
    is_active INTEGER DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS cargueras (
    id SERIAL PRIMARY KEY,
    nombre TEXT NOT NULL UNIQUE,
    pais TEXT,
    email TEXT,
    contacto TEXT,
    is_active INTEGER DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS tarifas_carguera (
    id SERIAL PRIMARY KEY,
    carguera_id INTEGER NOT NULL,
    aerolinea_id INTEGER NOT NULL,
    origen_airport_id INTEGER NOT NULL,
    destino_airport_id INTEGER NOT NULL,
    peso_minimo NUMERIC(10,2) NOT NULL DEFAULT 0,
    peso_maximo NUMERIC(10,2) NOT NULL DEFAULT 999999,
    tarifa_kilo NUMERIC(10,4) NOT NULL,
    costo_cuarto_frio_kilo NUMERIC(10,4) DEFAULT 0,
    costo_documentacion_fijo NUMERIC(10,2) DEFAULT 0,
    tariff_type TEXT NOT NULL DEFAULT 'contract'
        CHECK(tariff_type IN ('contract','spot','promo')),
    currency TEXT NOT NULL DEFAULT 'USD',
    validity_from DATE,
    validity_to DATE,
    surcharges_json JSONB,
    notas TEXT,
    is_active INTEGER DEFAULT 1,
    updated_by INTEGER,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(carguera_id, aerolinea_id, origen_airport_id, destino_airport_id,
           peso_minimo, peso_maximo, tariff_type),
    FOREIGN KEY (carguera_id) REFERENCES cargueras (id) ON DELETE CASCADE,
    FOREIGN KEY (aerolinea_id) REFERENCES aerolineas (id) ON DELETE CASCADE,
    FOREIGN KEY (origen_airport_id) REFERENCES airports (id),
    FOREIGN KEY (destino_airport_id) REFERENCES airports (id),
    FOREIGN KEY (updated_by) REFERENCES users (id)
);

CREATE TABLE IF NOT EXISTS tarifas_pais (
    id SERIAL PRIMARY KEY,
    country_code TEXT NOT NULL UNIQUE,
    country_name TEXT NOT NULL,
    aduana_fija NUMERIC(10,2) DEFAULT 0,
    transporte_interno_caja NUMERIC(10,2) DEFAULT 0,
    porcentaje_arancel NUMERIC(8,4) DEFAULT 0,
    porcentaje_impuesto_consumo NUMERIC(8,4) DEFAULT 0,
    rubros_dinamicos JSONB,
    notas TEXT,
    is_active INTEGER DEFAULT 1,
    updated_by INTEGER,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (updated_by) REFERENCES users (id)
);

CREATE TABLE IF NOT EXISTS tariff_changes_log (
    id SERIAL PRIMARY KEY,
    table_name TEXT NOT NULL,
    record_id INTEGER NOT NULL,
    action TEXT NOT NULL CHECK(action IN ('CREATE','UPDATE','DELETE')),
    before_json JSONB,
    after_json JSONB,
    changed_by INTEGER,
    changed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (changed_by) REFERENCES users (id)
);

CREATE TABLE IF NOT EXISTS cotizaciones_historico (
    id SERIAL PRIMARY KEY,
    user_id INTEGER,
    fecha_proyeccion DATE NOT NULL,
    snapshot JSONB NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE SET NULL
);

-- Índices
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_permissions_user ON user_report_permissions(user_id);
CREATE INDEX IF NOT EXISTS idx_permissions_report ON user_report_permissions(report_id);
CREATE INDEX IF NOT EXISTS idx_doc_permissions_user ON user_document_permissions(user_id);
CREATE INDEX IF NOT EXISTS idx_doc_permissions_doc ON user_document_permissions(document_id);
CREATE INDEX IF NOT EXISTS idx_documents_active ON documents(is_active);
CREATE INDEX IF NOT EXISTS idx_logs_user ON access_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON access_logs(timestamp);
CREATE INDEX IF NOT EXISTS idx_tarifa_carg_lookup ON tarifas_carguera(carguera_id, aerolinea_id, origen_airport_id, destino_airport_id);
CREATE INDEX IF NOT EXISTS idx_tarifa_pais_lookup ON tarifas_pais(country_code);
CREATE INDEX IF NOT EXISTS idx_airports_country ON airports(country_code, is_active);
CREATE INDEX IF NOT EXISTS idx_tariff_log_record ON tariff_changes_log(table_name, record_id);
CREATE INDEX IF NOT EXISTS idx_tariff_log_user ON tariff_changes_log(changed_by, changed_at);
CREATE INDEX IF NOT EXISTS idx_cotizaciones_user ON cotizaciones_historico(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_reports_name_unique ON reports(name);

-- ============================================================
-- PR-1a: RBAC FOUNDATION (ver sqlite.sql para descripción)
-- ============================================================

CREATE TABLE IF NOT EXISTS roles (
    id SERIAL PRIMARY KEY,
    code TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    level INTEGER NOT NULL DEFAULT 10,
    is_system INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS permissions (
    id SERIAL PRIMARY KEY,
    code TEXT UNIQUE NOT NULL,
    resource_type TEXT,
    action TEXT,
    description TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS role_permissions (
    role_id INTEGER NOT NULL,
    permission_id INTEGER NOT NULL,
    PRIMARY KEY (role_id, permission_id),
    FOREIGN KEY (role_id) REFERENCES roles (id) ON DELETE CASCADE,
    FOREIGN KEY (permission_id) REFERENCES permissions (id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS user_roles (
    user_id INTEGER NOT NULL,
    role_id INTEGER NOT NULL,
    granted_by INTEGER,
    granted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, role_id),
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
    FOREIGN KEY (role_id) REFERENCES roles (id) ON DELETE CASCADE,
    FOREIGN KEY (granted_by) REFERENCES users (id)
);

CREATE TABLE IF NOT EXISTS departments (
    id SERIAL PRIMARY KEY,
    code TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    parent_id INTEGER,
    is_active INTEGER DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (parent_id) REFERENCES departments (id)
);

CREATE TABLE IF NOT EXISTS user_departments (
    user_id INTEGER NOT NULL,
    department_id INTEGER NOT NULL,
    is_head INTEGER NOT NULL DEFAULT 0,
    granted_by INTEGER,
    granted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, department_id),
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
    FOREIGN KEY (department_id) REFERENCES departments (id) ON DELETE CASCADE,
    FOREIGN KEY (granted_by) REFERENCES users (id)
);

CREATE INDEX IF NOT EXISTS idx_user_roles_user ON user_roles(user_id);
CREATE INDEX IF NOT EXISTS idx_user_roles_role ON user_roles(role_id);
CREATE INDEX IF NOT EXISTS idx_role_perms_role ON role_permissions(role_id);
CREATE INDEX IF NOT EXISTS idx_user_depts_user ON user_departments(user_id);
CREATE INDEX IF NOT EXISTS idx_user_depts_dept ON user_departments(department_id);
CREATE INDEX IF NOT EXISTS idx_departments_active ON departments(is_active);

-- PR-9: Overrides individuales sobre los permisos heredados del rol.
CREATE TABLE IF NOT EXISTS user_permission_overrides (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL,
    permission_id INTEGER NOT NULL,
    effect TEXT NOT NULL CHECK(effect IN ('grant','deny')),
    granted_by INTEGER,
    granted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, permission_id),
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
    FOREIGN KEY (permission_id) REFERENCES permissions (id) ON DELETE CASCADE,
    FOREIGN KEY (granted_by) REFERENCES users (id)
);
CREATE INDEX IF NOT EXISTS idx_user_perm_ovr_user ON user_permission_overrides(user_id);

-- ============================================================
-- PR-1b: RESOURCE ACL (ver sqlite.sql para descripción)
-- ============================================================
CREATE TABLE IF NOT EXISTS resource_acl (
    id SERIAL PRIMARY KEY,
    resource_type TEXT NOT NULL CHECK(resource_type IN ('report','document','category')),
    resource_id INTEGER NOT NULL,
    principal_type TEXT NOT NULL CHECK(principal_type IN ('user','department','role')),
    principal_id INTEGER NOT NULL,
    actions TEXT NOT NULL DEFAULT '["view"]',
    granted_by INTEGER,
    granted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(resource_type, resource_id, principal_type, principal_id),
    FOREIGN KEY (granted_by) REFERENCES users (id)
);

CREATE INDEX IF NOT EXISTS idx_acl_resource ON resource_acl(resource_type, resource_id);
CREATE INDEX IF NOT EXISTS idx_acl_principal ON resource_acl(principal_type, principal_id);

-- ============================================================
-- PR-1c: CATEGORIES (ver sqlite.sql para descripción)
-- ============================================================
CREATE TABLE IF NOT EXISTS categories (
    id SERIAL PRIMARY KEY,
    type TEXT NOT NULL CHECK(type IN ('report','document')),
    code TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    parent_id INTEGER,
    is_active INTEGER DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(type, code),
    FOREIGN KEY (parent_id) REFERENCES categories (id)
);

CREATE INDEX IF NOT EXISTS idx_categories_type ON categories(type, is_active);
CREATE INDEX IF NOT EXISTS idx_categories_parent ON categories(parent_id);

-- ============================================================
-- PR-3a: RRHH BASE (ver sqlite.sql para descripción)
-- ============================================================
CREATE TABLE IF NOT EXISTS hr_positions (
    id SERIAL PRIMARY KEY,
    code TEXT UNIQUE NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    department_code TEXT,
    profile_pdf_path TEXT,
    level TEXT,
    is_active INTEGER DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS hr_employees (
    id SERIAL PRIMARY KEY,
    user_id INTEGER UNIQUE,
    full_name TEXT NOT NULL,
    doc_id TEXT,
    email_personal TEXT,
    phone TEXT,
    position_id INTEGER,
    department_id INTEGER,
    manager_id INTEGER,
    hire_date DATE,
    base_salary NUMERIC(12,2),
    status TEXT DEFAULT 'active' CHECK(status IN ('active','terminated','on_leave')),
    address TEXT,
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE SET NULL,
    FOREIGN KEY (position_id) REFERENCES hr_positions (id),
    FOREIGN KEY (department_id) REFERENCES departments (id),
    FOREIGN KEY (manager_id) REFERENCES hr_employees (id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS hr_documents (
    id SERIAL PRIMARY KEY,
    employee_id INTEGER NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('contract','id_card','certificate','cv','medical','training','other')),
    name TEXT NOT NULL,
    description TEXT,
    storage_key TEXT,
    file_size INTEGER,
    mime_type TEXT,
    uploaded_by INTEGER,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (employee_id) REFERENCES hr_employees (id) ON DELETE CASCADE,
    FOREIGN KEY (uploaded_by) REFERENCES users (id)
);

CREATE INDEX IF NOT EXISTS idx_hr_employees_user ON hr_employees(user_id);
CREATE INDEX IF NOT EXISTS idx_hr_employees_dept ON hr_employees(department_id);
CREATE INDEX IF NOT EXISTS idx_hr_employees_manager ON hr_employees(manager_id);
CREATE INDEX IF NOT EXISTS idx_hr_employees_status ON hr_employees(status);
CREATE INDEX IF NOT EXISTS idx_hr_documents_employee ON hr_documents(employee_id);
CREATE INDEX IF NOT EXISTS idx_hr_positions_dept ON hr_positions(department_code);

-- ============================================================
-- PR-3b: HOLIDAYS + BANCO DE DÍAS COMPENSADOS (ver sqlite.sql)
-- ============================================================
CREATE TABLE IF NOT EXISTS holidays (
    id SERIAL PRIMARY KEY,
    holiday_date DATE NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    is_national INTEGER DEFAULT 1,
    is_active INTEGER DEFAULT 1,
    created_by INTEGER,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(holiday_date, name),
    FOREIGN KEY (created_by) REFERENCES users (id)
);

CREATE TABLE IF NOT EXISTS holiday_attendance (
    id SERIAL PRIMARY KEY,
    holiday_id INTEGER NOT NULL,
    employee_id INTEGER NOT NULL,
    schedule_text TEXT,
    hours_worked NUMERIC(5,2),
    days_credit NUMERIC(5,2) NOT NULL DEFAULT 1,
    notes TEXT,
    created_by INTEGER,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(holiday_id, employee_id),
    FOREIGN KEY (holiday_id) REFERENCES holidays (id) ON DELETE CASCADE,
    FOREIGN KEY (employee_id) REFERENCES hr_employees (id) ON DELETE CASCADE,
    FOREIGN KEY (created_by) REFERENCES users (id)
);

CREATE INDEX IF NOT EXISTS idx_holidays_date ON holidays(holiday_date);
CREATE INDEX IF NOT EXISTS idx_holiday_attendance_emp ON holiday_attendance(employee_id);
CREATE INDEX IF NOT EXISTS idx_holiday_attendance_hol ON holiday_attendance(holiday_id);

-- ============================================================
-- PR-3c: SOLICITUDES DE TIEMPO LIBRE (ver sqlite.sql)
-- ============================================================
-- Workflow F1 (multinivel): SÓLO 'vacaciones' pasa por el jefe. Ver sqlite.sql
-- para la máquina de estados completa. 'pending' se conserva por compatibilidad
-- con filas históricas.
CREATE TABLE IF NOT EXISTS time_off_requests (
    id SERIAL PRIMARY KEY,
    employee_id INTEGER NOT NULL,
    request_type TEXT NOT NULL CHECK(request_type IN
        ('vacaciones','feriado_compensado','permiso_personal','enfermedad','otro')),
    date_from DATE NOT NULL,
    date_to DATE NOT NULL,
    days_count NUMERIC(5,2) NOT NULL,
    reason TEXT,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending','pending_jefe','pending_tthh','approved','rejected','cancelled')),
    -- F1: decisión de descuento de saldo (la fija TTHH; el descuento numérico es F3/F4).
    discount_decision TEXT NOT NULL DEFAULT 'pending'
        CHECK(discount_decision IN ('pending','discount','waived')),
    waived_by INTEGER,                -- user_id de TTHH que marcó 'justificado sin descuento'
    waived_reason TEXT,               -- obligatorio a nivel app cuando discount=false
    balance_marked_at TIMESTAMP,      -- sello del gancho "tras aprobación final → descontar" (F3/F4)
    requested_by INTEGER,
    approved_by INTEGER,
    approved_at TIMESTAMP,
    rejection_reason TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (employee_id) REFERENCES hr_employees (id) ON DELETE CASCADE,
    FOREIGN KEY (requested_by) REFERENCES users (id),
    FOREIGN KEY (approved_by) REFERENCES users (id),
    FOREIGN KEY (waived_by) REFERENCES users (id)
);

CREATE INDEX IF NOT EXISTS idx_time_off_employee ON time_off_requests(employee_id);
CREATE INDEX IF NOT EXISTS idx_time_off_status ON time_off_requests(status);
CREATE INDEX IF NOT EXISTS idx_time_off_dates ON time_off_requests(date_from, date_to);

-- ============================================================
-- F1: FIRMA ELECTRÓNICA + APROBACIÓN MULTINIVEL + ADJUNTOS (ver sqlite.sql)
-- ============================================================
-- (A) Firma electrónica genérica por (entity_type, entity_id). content_hash =
--     SHA-256 del payload SUSTANTIVO + identidad. UNIQUE: una firma por entidad.
CREATE TABLE IF NOT EXISTS hr_signatures (
    id SERIAL PRIMARY KEY,
    entity_type TEXT NOT NULL CHECK(entity_type IN ('time_off_request','payroll_receipt','memo')),
    entity_id INTEGER NOT NULL,
    signer_user_id INTEGER NOT NULL,
    signer_name TEXT NOT NULL,
    signer_doc_id TEXT NOT NULL,
    accepted BOOLEAN NOT NULL,
    content_hash TEXT NOT NULL,
    -- TIMESTAMPTZ (no TIMESTAMP) para que signed_at round-trip al MISMO instante
    -- absoluto en ms: el hash de la firma incluye signed_at, y el coder lo
    -- normaliza con new Date(x).toISOString() en ambos drivers. Con TIMESTAMP
    -- (sin tz) el offset del servidor corrompería la verificación de integridad.
    signed_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(entity_type, entity_id),
    FOREIGN KEY (signer_user_id) REFERENCES users (id)
);
CREATE INDEX IF NOT EXISTS idx_hr_signatures_signer ON hr_signatures(signer_user_id);

-- (B) Historial inmutable de pasos del workflow multinivel (append-only).
CREATE TABLE IF NOT EXISTS hr_approval_steps (
    id SERIAL PRIMARY KEY,
    request_id INTEGER NOT NULL,
    step_order INTEGER NOT NULL,
    step_level TEXT NOT NULL CHECK(step_level IN ('jefe','tthh')),
    approver_user_id INTEGER NOT NULL,
    action TEXT NOT NULL CHECK(action IN ('approve','reject')),
    comment TEXT,
    acted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (request_id) REFERENCES time_off_requests (id) ON DELETE CASCADE,
    FOREIGN KEY (approver_user_id) REFERENCES users (id)
);
CREATE INDEX IF NOT EXISTS idx_hr_approval_steps_req ON hr_approval_steps(request_id, step_order);

-- (C) Justificativos en filesystem (storage_key), NO BLOB. MÚLTIPLES por solicitud.
CREATE TABLE IF NOT EXISTS hr_request_attachments (
    id SERIAL PRIMARY KEY,
    request_id INTEGER NOT NULL,
    storage_key TEXT NOT NULL,
    file_name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    file_size INTEGER,
    uploaded_by INTEGER,
    uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (request_id) REFERENCES time_off_requests (id) ON DELETE CASCADE,
    FOREIGN KEY (uploaded_by) REFERENCES users (id)
);
CREATE INDEX IF NOT EXISTS idx_hr_request_attachments_req ON hr_request_attachments(request_id);

-- ============================================================
-- PR-3d: MEMOS / COMUNICADOS A EMPLEADOS (historial inmutable)
-- ============================================================
-- Append-only: nunca se editan ni borran. content_hash es SHA-256 del
-- subject+content; cualquier modificación directa en DB lo rompe.
-- target_type = 'employee'|'department'|'all' resuelve a target_id.
CREATE TABLE IF NOT EXISTS hr_memos (
    id SERIAL PRIMARY KEY,
    subject TEXT NOT NULL,
    content TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    target_type TEXT NOT NULL CHECK(target_type IN ('employee','department','all')),
    target_id INTEGER,
    severity TEXT NOT NULL DEFAULT 'info' CHECK(severity IN ('info','warning','sanction')),
    issued_by INTEGER NOT NULL,
    issued_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    superseded_by INTEGER,
    FOREIGN KEY (issued_by) REFERENCES users (id),
    FOREIGN KEY (superseded_by) REFERENCES hr_memos (id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS hr_memo_acknowledgments (
    memo_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    acknowledged_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    ip_address TEXT,
    PRIMARY KEY (memo_id, user_id),
    FOREIGN KEY (memo_id) REFERENCES hr_memos (id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_hr_memos_target ON hr_memos(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_hr_memos_issued ON hr_memos(issued_at);
CREATE INDEX IF NOT EXISTS idx_hr_memo_acks_user ON hr_memo_acknowledgments(user_id);
