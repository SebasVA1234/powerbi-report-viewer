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
    plain_password TEXT,
    full_name TEXT NOT NULL,
    role TEXT DEFAULT 'user' CHECK(role IN ('admin', 'user')),
    is_active INTEGER DEFAULT 1,
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
-- COTIZADOR LANDED COST (SCD Tipo 2)
-- ============================================================

CREATE TABLE IF NOT EXISTS destinos (
    id SERIAL PRIMARY KEY,
    codigo_iata TEXT NOT NULL UNIQUE,
    nombre TEXT NOT NULL,
    pais TEXT,
    porcentaje_arancel NUMERIC(8,4) DEFAULT 0,
    porcentaje_impuesto_consumo NUMERIC(8,4) DEFAULT 0,
    is_active INTEGER DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS cargueras (
    id SERIAL PRIMARY KEY,
    nombre TEXT NOT NULL UNIQUE,
    is_active INTEGER DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS tarifas_carguera (
    id SERIAL PRIMARY KEY,
    id_carguera INTEGER NOT NULL,
    id_destino INTEGER NOT NULL,
    peso_minimo NUMERIC(10,2) NOT NULL,
    peso_maximo NUMERIC(10,2) NOT NULL,
    tarifa_kilo NUMERIC(10,4) NOT NULL,
    costo_cuarto_frio_kilo NUMERIC(10,4) DEFAULT 0,
    costo_documentacion_fijo NUMERIC(10,2) DEFAULT 0,
    fecha_inicio DATE NOT NULL,
    fecha_fin DATE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (id_carguera) REFERENCES cargueras (id),
    FOREIGN KEY (id_destino) REFERENCES destinos (id)
);

CREATE TABLE IF NOT EXISTS tarifas_destino (
    id SERIAL PRIMARY KEY,
    id_destino INTEGER NOT NULL,
    aduana_fija NUMERIC(10,2) DEFAULT 0,
    transporte_interno_caja NUMERIC(10,2) DEFAULT 0,
    rubros_dinamicos JSONB,
    fecha_inicio DATE NOT NULL,
    fecha_fin DATE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (id_destino) REFERENCES destinos (id)
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
CREATE INDEX IF NOT EXISTS idx_tarifa_carg_vigente ON tarifas_carguera(id_carguera, id_destino, fecha_inicio, fecha_fin);
CREATE INDEX IF NOT EXISTS idx_tarifa_dest_vigente ON tarifas_destino(id_destino, fecha_inicio, fecha_fin);
CREATE INDEX IF NOT EXISTS idx_cotizaciones_user ON cotizaciones_historico(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_reports_name_unique ON reports(name);
