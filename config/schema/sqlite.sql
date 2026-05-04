-- Schema SQLite — espejo del init-db.js original + tablas del Cotizador.
-- Idempotente: usa CREATE TABLE IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    plain_password TEXT,
    full_name TEXT NOT NULL,
    role TEXT DEFAULT 'user' CHECK(role IN ('admin', 'user')),
    is_active INTEGER DEFAULT 1,
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
