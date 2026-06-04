-- Schema SQLite — espejo del init-db.js original + tablas del Cotizador.
-- Idempotente: usa CREATE TABLE IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    full_name TEXT NOT NULL,
    role TEXT DEFAULT 'user' CHECK(role IN ('admin', 'user')),
    is_active INTEGER DEFAULT 1,
    must_change_password INTEGER DEFAULT 0,
    -- PR-0b.1: 2FA TOTP. totp_secret es el secret base32; totp_enabled
    -- pasa a 1 después de que el user verifica el primer código (no
    -- alcanza con setearlo, hay que probar que la app de autenticación
    -- está sincronizada).
    totp_secret TEXT,
    totp_enabled INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    embed_url TEXT NOT NULL,
    category TEXT,
    is_active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS user_report_permissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    report_id INTEGER NOT NULL,
    can_view INTEGER DEFAULT 1,
    can_export INTEGER DEFAULT 0,
    granted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    granted_by INTEGER,
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
    FOREIGN KEY (report_id) REFERENCES reports (id) ON DELETE CASCADE,
    FOREIGN KEY (granted_by) REFERENCES users (id),
    UNIQUE(user_id, report_id)
);

CREATE TABLE IF NOT EXISTS documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    category TEXT,
    file_name TEXT NOT NULL,
    mime_type TEXT NOT NULL DEFAULT 'application/pdf',
    file_size INTEGER NOT NULL,
    file_data BLOB NOT NULL,
    is_active INTEGER DEFAULT 1,
    uploaded_by INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (uploaded_by) REFERENCES users (id)
);

CREATE TABLE IF NOT EXISTS user_document_permissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    document_id INTEGER NOT NULL,
    can_view INTEGER DEFAULT 1,
    granted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    granted_by INTEGER,
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
    FOREIGN KEY (document_id) REFERENCES documents (id) ON DELETE CASCADE,
    FOREIGN KEY (granted_by) REFERENCES users (id),
    UNIQUE(user_id, document_id)
);

CREATE TABLE IF NOT EXISTS access_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    report_id INTEGER,
    document_id INTEGER,
    action TEXT NOT NULL,
    ip_address TEXT,
    user_agent TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
    FOREIGN KEY (report_id) REFERENCES reports (id) ON DELETE CASCADE,
    FOREIGN KEY (document_id) REFERENCES documents (id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS system_config (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    config_key TEXT UNIQUE NOT NULL,
    config_value TEXT NOT NULL,
    description TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================
-- COTIZADOR LANDED COST · v2 (refactor PR-finalize-prototype)
-- ============================================================
-- Cambios vs v1:
--   - 'destinos' renombrado a 'airports' con campos city/country/country_code
--   - 'cargueras' refactor: agrega pais y email
--   - NUEVO: 'aerolineas' (separadas de cargueras — antes estaban mezcladas)
--   - 'tarifas_carguera' refactor: ahora cada fila es por
--     (carguera + aerolinea + origen + destino + rango_peso). Sin SCD2:
--     UPDATE en su lugar cuando cambia. Histórico se ve via tariff_changes_log.
--   - 'tarifas_destino' renombrado a 'tarifas_pais' y key por country_code
--     (los costos de aduana son nacionales, no por aeropuerto).
--   - NUEVO: 'tariff_changes_log' (append-only audit, antes/después JSON).
--   - 'cotizaciones_historico' SIN cambios — el usuario quiere preservarlas.
-- La migración en init-db detecta el schema viejo y lo reemplaza
-- (no hay datos productivos relevantes, solo el seed de Copa+MIA).

CREATE TABLE IF NOT EXISTS airports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    iata_code TEXT NOT NULL UNIQUE,    -- "MIA"
    name TEXT NOT NULL,                 -- "Miami International Airport"
    city TEXT NOT NULL,                 -- "Miami"
    country TEXT NOT NULL,              -- "USA"
    country_code TEXT NOT NULL,         -- "US" (ISO alpha-2) — agrupa tarifas_pais
    is_active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS aerolineas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT NOT NULL,                -- "Avianca Cargo"
    codigo_iata TEXT UNIQUE,             -- "AV" (2 chars)
    codigo_pais TEXT,                    -- "CO" ISO alpha-2 (donde radica)
    is_active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS cargueras (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT NOT NULL UNIQUE,         -- "Saftec S.A."
    pais TEXT,                            -- "Ecuador"
    email TEXT,                           -- "sales@saftec.com.ec"
    contacto TEXT,                        -- persona/teléfono opcional
    is_active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Tarifas de flete: 1 fila por (carguera + aerolinea + origen + destino + rango_peso + tariff_type).
-- UNIQUE compuesto evita duplicados; UPDATE en su lugar cuando admin cambia
-- valores. La auditoría de cambios queda en tariff_changes_log.
CREATE TABLE IF NOT EXISTS tarifas_carguera (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    carguera_id INTEGER NOT NULL,
    aerolinea_id INTEGER NOT NULL,
    origen_airport_id INTEGER NOT NULL,
    destino_airport_id INTEGER NOT NULL,
    peso_minimo REAL NOT NULL DEFAULT 0,
    peso_maximo REAL NOT NULL DEFAULT 999999,
    tarifa_kilo REAL NOT NULL,
    costo_cuarto_frio_kilo REAL DEFAULT 0,
    costo_documentacion_fijo REAL DEFAULT 0,
    tariff_type TEXT NOT NULL DEFAULT 'contract'
        CHECK(tariff_type IN ('contract','spot','promo')),
    currency TEXT NOT NULL DEFAULT 'USD',
    validity_from DATE,                   -- NULL = sin restricción de inicio
    validity_to DATE,                     -- NULL = sin vencimiento
    surcharges_json TEXT,                 -- JSON: [{nombre, monto, tipo:fijo|por_kg}]
    notas TEXT,
    is_active INTEGER DEFAULT 1,
    updated_by INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(carguera_id, aerolinea_id, origen_airport_id, destino_airport_id,
           peso_minimo, peso_maximo, tariff_type),
    FOREIGN KEY (carguera_id) REFERENCES cargueras (id) ON DELETE CASCADE,
    FOREIGN KEY (aerolinea_id) REFERENCES aerolineas (id) ON DELETE CASCADE,
    FOREIGN KEY (origen_airport_id) REFERENCES airports (id),
    FOREIGN KEY (destino_airport_id) REFERENCES airports (id),
    FOREIGN KEY (updated_by) REFERENCES users (id)
);

-- Costos por país de destino (aduana, transporte interno, impuestos).
-- Key por country_code (ISO alpha-2) — todos los aeropuertos de USA
-- comparten el mismo costo de aduana. UPDATE en su lugar.
CREATE TABLE IF NOT EXISTS tarifas_pais (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    country_code TEXT NOT NULL UNIQUE,    -- "US"
    country_name TEXT NOT NULL,           -- "USA" / "Estados Unidos"
    aduana_fija REAL DEFAULT 0,
    transporte_interno_caja REAL DEFAULT 0,
    porcentaje_arancel REAL DEFAULT 0,
    porcentaje_impuesto_consumo REAL DEFAULT 0,
    rubros_dinamicos TEXT,                -- JSON: [{nombre, monto, tipo}]
    notas TEXT,
    is_active INTEGER DEFAULT 1,
    updated_by INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (updated_by) REFERENCES users (id)
);

-- Audit log append-only: cada cambio en tarifas o catálogos deja huella.
-- Permite ver "quién cambió qué" sin necesidad de versionar SCD2.
CREATE TABLE IF NOT EXISTS tariff_changes_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    table_name TEXT NOT NULL,             -- 'tarifas_carguera' | 'tarifas_pais' | 'airports' | 'aerolineas' | 'cargueras'
    record_id INTEGER NOT NULL,
    action TEXT NOT NULL CHECK(action IN ('CREATE','UPDATE','DELETE')),
    before_json TEXT,                     -- estado previo (NULL si CREATE)
    after_json TEXT,                      -- estado nuevo  (NULL si DELETE)
    changed_by INTEGER,
    changed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (changed_by) REFERENCES users (id)
);

CREATE TABLE IF NOT EXISTS cotizaciones_historico (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    fecha_proyeccion DATE NOT NULL,
    snapshot TEXT NOT NULL,           -- JSON con el cálculo completo (inmutable)
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
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
-- PR-1a: RBAC FOUNDATION (Roles + Permisos + Departamentos)
-- ============================================================
-- Modelo aditivo: NO reemplaza user_report_permissions ni
-- user_document_permissions. Ambos siguen en uso. La integración con
-- los flujos existentes llega en PR-1b.

-- Roles del negocio (gerencia, jefe_*, rrhh, empleado, admin_sistema).
-- 'level' es jerárquico (mayor = más privilegio); útil para reglas tipo
-- "un user no puede asignar un rol con level >= que el suyo".
-- 'is_system'=1 marca los roles que el código depende de y no se borran.
CREATE TABLE IF NOT EXISTS roles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    level INTEGER NOT NULL DEFAULT 10,
    is_system INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Permisos atómicos. code es del estilo 'resource.action' o 'feature.action'.
CREATE TABLE IF NOT EXISTS permissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE NOT NULL,
    resource_type TEXT,
    action TEXT,
    description TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS role_permissions (
    role_id INTEGER NOT NULL,
    permission_id INTEGER NOT NULL,
    PRIMARY KEY (role_id, permission_id),
    FOREIGN KEY (role_id) REFERENCES roles (id) ON DELETE CASCADE,
    FOREIGN KEY (permission_id) REFERENCES permissions (id) ON DELETE CASCADE
);

-- Asignación user ↔ rol. Un user puede tener N roles; el conjunto
-- efectivo de permisos es la unión.
CREATE TABLE IF NOT EXISTS user_roles (
    user_id INTEGER NOT NULL,
    role_id INTEGER NOT NULL,
    granted_by INTEGER,
    granted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, role_id),
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
    FOREIGN KEY (role_id) REFERENCES roles (id) ON DELETE CASCADE,
    FOREIGN KEY (granted_by) REFERENCES users (id)
);

-- Departamentos del organigrama. parent_id permite jerarquía
-- (Comercial > Ventas / Marketing) si en el futuro hace falta.
-- is_active=0 archiva sin perder histórico.
CREATE TABLE IF NOT EXISTS departments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    parent_id INTEGER,
    is_active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (parent_id) REFERENCES departments (id)
);

-- Asignación user ↔ departamento. is_head=1 marca al jefe.
-- Un user puede pertenecer a varios deptos a la vez.
CREATE TABLE IF NOT EXISTS user_departments (
    user_id INTEGER NOT NULL,
    department_id INTEGER NOT NULL,
    is_head INTEGER NOT NULL DEFAULT 0,
    granted_by INTEGER,
    granted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
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
--   effect='grant' → agrega el permiso al user (aunque el rol no lo dé)
--   effect='deny'  → quita el permiso al user (aunque el rol sí lo dé)
-- Si NO hay fila para (user, permission), el user solo tiene lo que dicte
-- su rol. UNIQUE asegura una sola fila por par — toggle es overwrite/delete.
CREATE TABLE IF NOT EXISTS user_permission_overrides (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    permission_id INTEGER NOT NULL,
    effect TEXT NOT NULL CHECK(effect IN ('grant','deny')),
    granted_by INTEGER,
    granted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, permission_id),
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
    FOREIGN KEY (permission_id) REFERENCES permissions (id) ON DELETE CASCADE,
    FOREIGN KEY (granted_by) REFERENCES users (id)
);
CREATE INDEX IF NOT EXISTS idx_user_perm_ovr_user ON user_permission_overrides(user_id);

-- ============================================================
-- PR-1b: RESOURCE ACL — asignación de recursos a principales
-- ============================================================
-- Reemplaza progresivamente a user_report_permissions / user_document_permissions:
--   principal_type='user'        => fila por user específico
--   principal_type='department'  => todo el depto hereda
--   principal_type='role'        => todos los users con ese rol heredan
-- Las viejas tablas legacy SIGUEN funcionando en paralelo durante la transición.
-- La migración de datos legacy → resource_acl llega en una PR futura (PR-1e).
CREATE TABLE IF NOT EXISTS resource_acl (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    resource_type TEXT NOT NULL CHECK(resource_type IN ('report','document','category')),
    resource_id INTEGER NOT NULL,
    principal_type TEXT NOT NULL CHECK(principal_type IN ('user','department','role')),
    principal_id INTEGER NOT NULL,
    -- JSON array: ['view'], ['view','export']. Default ['view'] al crear.
    actions TEXT NOT NULL DEFAULT '["view"]',
    granted_by INTEGER,
    granted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(resource_type, resource_id, principal_type, principal_id),
    FOREIGN KEY (granted_by) REFERENCES users (id)
);

CREATE INDEX IF NOT EXISTS idx_acl_resource ON resource_acl(resource_type, resource_id);
CREATE INDEX IF NOT EXISTS idx_acl_principal ON resource_acl(principal_type, principal_id);

-- ============================================================
-- PR-1c: CATEGORIES — categorías de reportes y documentos
-- ============================================================
-- Reemplaza el campo libre reports.category / documents.category (string)
-- por una FK a una tabla normalizada. Permite:
--   * Asignar permisos a una categoría (ACL principal_type='category' o
--     resource_type='category') y heredar a sus recursos.
--   * Jerarquía con parent_id (ej: "Comercial" > "Ventas" > "Tienda Online")
--   * Soft-delete con is_active.
-- type='report' | 'document' separa los namespaces.
-- Migración aditiva: las columnas string siguen existiendo durante la
-- transición; cuando todos los recursos tengan category_id se podran dropear.
CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL CHECK(type IN ('report','document')),
    code TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    parent_id INTEGER,
    is_active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(type, code),
    FOREIGN KEY (parent_id) REFERENCES categories (id)
);

CREATE INDEX IF NOT EXISTS idx_categories_type ON categories(type, is_active);
CREATE INDEX IF NOT EXISTS idx_categories_parent ON categories(parent_id);

-- ============================================================
-- PR-3a: RRHH BASE — perfiles de cargo, empleados, documentos
-- ============================================================
-- Perfiles de cargo (los 12 PDFs del directorio PERFILES DE CARGO/
-- se siembran como filas referenciables; los PDFs en sí pueden
-- subirse después al volumen de documentos generales).
CREATE TABLE IF NOT EXISTS hr_positions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    department_code TEXT,         -- match informal con departments.code
    profile_pdf_path TEXT,        -- ruta opcional al PDF del perfil
    level TEXT,                   -- 'jefe' | 'analista' | 'asistente' | 'ejecutivo'
    is_active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Empleados. user_id es UNIQUE y nullable: un user puede ser empleado
-- (1-to-1), o haber empleados sin user (por ej. un externo sin login).
CREATE TABLE IF NOT EXISTS hr_employees (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER UNIQUE,
    full_name TEXT NOT NULL,
    doc_id TEXT,                  -- cédula / pasaporte
    email_personal TEXT,
    phone TEXT,
    position_id INTEGER,
    department_id INTEGER,
    manager_id INTEGER,           -- FK a hr_employees.id (jefe directo)
    hire_date DATE,
    base_salary REAL,             -- nullable: Fase 6 (nómina) lo carga
    status TEXT DEFAULT 'active' CHECK(status IN ('active','terminated','on_leave')),
    address TEXT,
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE SET NULL,
    FOREIGN KEY (position_id) REFERENCES hr_positions (id),
    FOREIGN KEY (department_id) REFERENCES departments (id),
    FOREIGN KEY (manager_id) REFERENCES hr_employees (id) ON DELETE SET NULL
);

-- Documentos del empleado (contratos, certificados, CV, etc.)
-- storage_key referencia al volumen, mismo patrón que documents.
CREATE TABLE IF NOT EXISTS hr_documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id INTEGER NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('contract','id_card','certificate','cv','medical','training','other')),
    name TEXT NOT NULL,
    description TEXT,
    storage_key TEXT,
    file_size INTEGER,
    mime_type TEXT,
    uploaded_by INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
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
-- PR-3b: HOLIDAYS + BANCO DE DÍAS COMPENSADOS
-- ============================================================
-- Reemplaza FERIADOS.xlsx. Modelo:
--   * holidays:  catálogo de feriados (nacionales + custom decretados).
--                Una fila por (date, name).
--   * holiday_attendance: registro de quién trabajó cada feriado y con
--                qué horario. Cada fila acumula 'days_credit' al banco
--                del empleado.
--   * El "banco de días compensados" no es una tabla — se calcula como:
--       sum(holiday_attendance.days_credit) - sum(time_off_requests
--       de tipo 'feriado_compensado' aprobadas). PR-3c agrega la otra
--       parte (time_off_requests).

CREATE TABLE IF NOT EXISTS holidays (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    holiday_date DATE NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    is_national INTEGER DEFAULT 1,    -- 1 = feriado nacional, 0 = custom decretado
    is_active INTEGER DEFAULT 1,
    created_by INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(holiday_date, name),
    FOREIGN KEY (created_by) REFERENCES users (id)
);

CREATE TABLE IF NOT EXISTS holiday_attendance (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    holiday_id INTEGER NOT NULL,
    employee_id INTEGER NOT NULL,
    schedule_text TEXT,               -- "7:00 a 5:00", "7:00 a 4:30", etc. (informativo)
    hours_worked REAL,                -- horas reales trabajadas (informativo)
    days_credit REAL NOT NULL DEFAULT 1,  -- crédito al banco; típicamente 1 día
    notes TEXT,
    created_by INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(holiday_id, employee_id),
    FOREIGN KEY (holiday_id) REFERENCES holidays (id) ON DELETE CASCADE,
    FOREIGN KEY (employee_id) REFERENCES hr_employees (id) ON DELETE CASCADE,
    FOREIGN KEY (created_by) REFERENCES users (id)
);

CREATE INDEX IF NOT EXISTS idx_holidays_date ON holidays(holiday_date);
CREATE INDEX IF NOT EXISTS idx_holiday_attendance_emp ON holiday_attendance(employee_id);
CREATE INDEX IF NOT EXISTS idx_holiday_attendance_hol ON holiday_attendance(holiday_id);

-- ============================================================
-- PR-3c: SOLICITUDES DE TIEMPO LIBRE (vacaciones, permisos, etc.)
-- ============================================================
-- Cierra el ciclo del banco de días compensados (PR-3b):
--   * Empleado solicita días libres con un tipo (vacaciones,
--     feriado_compensado, permiso_personal, enfermedad).
--   * Si tipo='feriado_compensado', al APROBARSE descuenta del banco.
--   * Aprobación pendiente: jefe directo (o RRHH/Gerencia).
-- Workflow F1 (multinivel): SÓLO 'vacaciones' pasa por el jefe
--   crear → pending_jefe (vacaciones) | pending_tthh (resto)
--   pending_jefe → pending_tthh (jefe aprueba) | rejected | cancelled
--   pending_tthh → approved (TTHH aprueba; recién aquí se marca descuento) | rejected | cancelled
-- 'pending' se conserva SOLO por compatibilidad con filas históricas (PR-3c).
-- approved_by/approved_at reflejan la decisión FINAL de TTHH; el detalle
-- multinivel vive en hr_approval_steps (append-only).
CREATE TABLE IF NOT EXISTS time_off_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id INTEGER NOT NULL,
    request_type TEXT NOT NULL CHECK(request_type IN
        ('vacaciones','feriado_compensado','permiso_personal','enfermedad','otro')),
    date_from DATE NOT NULL,
    date_to DATE NOT NULL,
    days_count REAL NOT NULL,         -- días calendario solicitados
    reason TEXT,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending','pending_jefe','pending_tthh','approved','rejected','cancelled')),
    -- F1: decisión de descuento de saldo (la fija TTHH; el descuento numérico es F3/F4).
    discount_decision TEXT NOT NULL DEFAULT 'pending'
        CHECK(discount_decision IN ('pending','discount','waived')),
    waived_by INTEGER,                -- user_id de TTHH que marcó 'justificado sin descuento'
    waived_reason TEXT,               -- obligatorio a nivel app cuando discount=false
    balance_marked_at DATETIME,       -- sello del gancho "tras aprobación final → descontar" (F3/F4)
    requested_by INTEGER,             -- user_id de quien lo creó (puede ser admin/rrhh por el empleado)
    approved_by INTEGER,
    approved_at DATETIME,
    rejection_reason TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (employee_id) REFERENCES hr_employees (id) ON DELETE CASCADE,
    FOREIGN KEY (requested_by) REFERENCES users (id),
    FOREIGN KEY (approved_by) REFERENCES users (id),
    FOREIGN KEY (waived_by) REFERENCES users (id)
);

CREATE INDEX IF NOT EXISTS idx_time_off_employee ON time_off_requests(employee_id);
CREATE INDEX IF NOT EXISTS idx_time_off_status ON time_off_requests(status);
CREATE INDEX IF NOT EXISTS idx_time_off_dates ON time_off_requests(date_from, date_to);

-- ============================================================
-- F1: FIRMA ELECTRÓNICA + APROBACIÓN MULTINIVEL + ADJUNTOS
-- ============================================================
-- (A) Firma electrónica genérica, vinculada por (entity_type, entity_id) para
--     reuso futuro en roles de pago (M2) y memos (M5). content_hash = SHA-256
--     del payload SUSTANTIVO de la solicitud + identidad del firmante (mismo
--     espíritu que hr_memos.content_hash). UNIQUE(entity_type, entity_id):
--     una firma vigente por entidad.
CREATE TABLE IF NOT EXISTS hr_signatures (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_type TEXT NOT NULL CHECK(entity_type IN ('time_off_request','payroll_receipt','memo')),
    entity_id INTEGER NOT NULL,
    signer_user_id INTEGER NOT NULL,
    signer_name TEXT NOT NULL,        -- MAYÚSCULAS, validado === hr_employees.full_name
    signer_doc_id TEXT NOT NULL,      -- cédula; se OMITE al leer a quien no sea dueño/hr.read.all/admin
    accepted INTEGER NOT NULL,        -- 1 = checkbox aceptado
    content_hash TEXT NOT NULL,       -- SHA-256 hex del payload firmado sustantivo + identidad
    signed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(entity_type, entity_id),
    FOREIGN KEY (signer_user_id) REFERENCES users (id)
);
CREATE INDEX IF NOT EXISTS idx_hr_signatures_signer ON hr_signatures(signer_user_id);

-- (B) Historial inmutable de pasos del workflow multinivel. Append-only:
--     nunca UPDATE/DELETE. Reemplaza el approved_by único como fuente de
--     verdad de auditoría. step_order: 1=jefe,2=tthh (vacaciones); 1=tthh
--     (tipos RRHH-directos).
CREATE TABLE IF NOT EXISTS hr_approval_steps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id INTEGER NOT NULL,
    step_order INTEGER NOT NULL,
    step_level TEXT NOT NULL CHECK(step_level IN ('jefe','tthh')),
    approver_user_id INTEGER NOT NULL,
    action TEXT NOT NULL CHECK(action IN ('approve','reject')),
    comment TEXT,                     -- obligatorio a nivel app en reject
    acted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (request_id) REFERENCES time_off_requests (id) ON DELETE CASCADE,
    FOREIGN KEY (approver_user_id) REFERENCES users (id)
);
CREATE INDEX IF NOT EXISTS idx_hr_approval_steps_req ON hr_approval_steps(request_id, step_order);

-- (C) Justificativos en filesystem (storage_key), NO BLOB (mismo patrón que
--     documents/hr_documents). MÚLTIPLES adjuntos por solicitud: acumulan, no
--     reemplazan → índice NO único.
CREATE TABLE IF NOT EXISTS hr_request_attachments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id INTEGER NOT NULL,
    storage_key TEXT NOT NULL,        -- random; resuelto por config/storage.js
    file_name TEXT NOT NULL,          -- nombre original
    mime_type TEXT NOT NULL,          -- application/pdf | image/png | image/jpeg
    file_size INTEGER,
    uploaded_by INTEGER,
    uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (request_id) REFERENCES time_off_requests (id) ON DELETE CASCADE,
    FOREIGN KEY (uploaded_by) REFERENCES users (id)
);
CREATE INDEX IF NOT EXISTS idx_hr_request_attachments_req ON hr_request_attachments(request_id);

-- ============================================================
-- PR-3d: MEMOS / COMUNICADOS A EMPLEADOS (historial inmutable)
-- ============================================================
-- Modelo append-only: una vez emitido, el memo nunca se edita ni borra.
-- Si necesita corrección, se crea un memo nuevo y se setea
-- superseded_by sobre el original (que sigue visible para auditoría).
-- content_hash es SHA-256(subject + '\n' + content) calculado al INSERT;
-- si alguien tocara content directo en la DB, hash no cuadraría → tamper.
-- target_type:
--   'employee'    → target_id es hr_employees.id (memo personal)
--   'department'  → target_id es departments.id (broadcast a un area)
--   'all'         → target_id NULL (broadcast a toda la empresa)
-- severity: info | warning | sanction (para amonestaciones formales).
-- hr_memo_acknowledgments registra el acuse de lectura (timestamp + ip).
CREATE TABLE IF NOT EXISTS hr_memos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subject TEXT NOT NULL,
    content TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    target_type TEXT NOT NULL CHECK(target_type IN ('employee','department','all')),
    target_id INTEGER,
    severity TEXT NOT NULL DEFAULT 'info' CHECK(severity IN ('info','warning','sanction')),
    issued_by INTEGER NOT NULL,
    issued_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    superseded_by INTEGER,
    FOREIGN KEY (issued_by) REFERENCES users (id),
    FOREIGN KEY (superseded_by) REFERENCES hr_memos (id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS hr_memo_acknowledgments (
    memo_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    acknowledged_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    ip_address TEXT,
    PRIMARY KEY (memo_id, user_id),
    FOREIGN KEY (memo_id) REFERENCES hr_memos (id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_hr_memos_target ON hr_memos(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_hr_memos_issued ON hr_memos(issued_at);
CREATE INDEX IF NOT EXISTS idx_hr_memo_acks_user ON hr_memo_acknowledgments(user_id);
