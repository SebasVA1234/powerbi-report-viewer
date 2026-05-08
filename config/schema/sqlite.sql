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
-- COTIZADOR LANDED COST (SCD Tipo 2)
-- ============================================================

CREATE TABLE IF NOT EXISTS destinos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    codigo_iata TEXT NOT NULL UNIQUE,
    nombre TEXT NOT NULL,
    pais TEXT,
    porcentaje_arancel REAL DEFAULT 0,
    porcentaje_impuesto_consumo REAL DEFAULT 0,
    is_active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS cargueras (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT NOT NULL UNIQUE,
    is_active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- SCD Tipo 2: el rango fecha_inicio..fecha_fin define vigencia.
-- fecha_fin NULL = tarifa actualmente vigente (la abierta).
CREATE TABLE IF NOT EXISTS tarifas_carguera (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    id_carguera INTEGER NOT NULL,
    id_destino INTEGER NOT NULL,
    peso_minimo REAL NOT NULL,
    peso_maximo REAL NOT NULL,
    tarifa_kilo REAL NOT NULL,
    costo_cuarto_frio_kilo REAL DEFAULT 0,
    costo_documentacion_fijo REAL DEFAULT 0,
    fecha_inicio DATE NOT NULL,
    fecha_fin DATE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (id_carguera) REFERENCES cargueras (id),
    FOREIGN KEY (id_destino) REFERENCES destinos (id)
);

CREATE TABLE IF NOT EXISTS tarifas_destino (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    id_destino INTEGER NOT NULL,
    aduana_fija REAL DEFAULT 0,
    transporte_interno_caja REAL DEFAULT 0,
    rubros_dinamicos TEXT,            -- JSON serializado (SQLite no tiene JSONB)
    fecha_inicio DATE NOT NULL,
    fecha_fin DATE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (id_destino) REFERENCES destinos (id)
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
CREATE INDEX IF NOT EXISTS idx_tarifa_carg_vigente ON tarifas_carguera(id_carguera, id_destino, fecha_inicio, fecha_fin);
CREATE INDEX IF NOT EXISTS idx_tarifa_dest_vigente ON tarifas_destino(id_destino, fecha_inicio, fecha_fin);
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
