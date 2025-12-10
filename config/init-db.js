const db = require('./database');
const bcrypt = require('bcryptjs');

console.log('🔧 Inicializando base de datos...');

try {
    // Crear tabla de usuarios
    db.exec(`
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            email TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL,
            plain_password TEXT NOT NULL,
            full_name TEXT NOT NULL,
            role TEXT DEFAULT 'user' CHECK(role IN ('admin', 'user')),
            is_active BOOLEAN DEFAULT 1,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // Crear tabla de reportes
    db.exec(`
        CREATE TABLE IF NOT EXISTS reports (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            description TEXT,
            embed_url TEXT NOT NULL,
            category TEXT,
            is_active BOOLEAN DEFAULT 1,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // Crear tabla de permisos (relación muchos a muchos)
    db.exec(`
        CREATE TABLE IF NOT EXISTS user_report_permissions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            report_id INTEGER NOT NULL,
            can_view BOOLEAN DEFAULT 1,
            can_export BOOLEAN DEFAULT 0,
            granted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            granted_by INTEGER,
            FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
            FOREIGN KEY (report_id) REFERENCES reports (id) ON DELETE CASCADE,
            FOREIGN KEY (granted_by) REFERENCES users (id),
            UNIQUE(user_id, report_id)
        )
    `);

    // Crear tabla de logs de acceso
    db.exec(`
        CREATE TABLE IF NOT EXISTS access_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            report_id INTEGER,
            action TEXT NOT NULL,
            ip_address TEXT,
            user_agent TEXT,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
            FOREIGN KEY (report_id) REFERENCES reports (id) ON DELETE CASCADE
        )
    `);

    // Crear tabla de configuración del sistema
    db.exec(`
        CREATE TABLE IF NOT EXISTS system_config (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            config_key TEXT UNIQUE NOT NULL,
            config_value TEXT NOT NULL,
            description TEXT,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // Insertar configuraciones por defecto
    const insertConfig = db.prepare(`
        INSERT OR IGNORE INTO system_config (config_key, config_value, description)
        VALUES (?, ?, ?)
    `);
    insertConfig.run('max_report_windows', '5', 'Máximo de ventanas de reportes abiertas simultáneamente');

    // Crear índices para optimización
    db.exec(`
        CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
        CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
        CREATE INDEX IF NOT EXISTS idx_permissions_user ON user_report_permissions(user_id);
        CREATE INDEX IF NOT EXISTS idx_permissions_report ON user_report_permissions(report_id);
        CREATE INDEX IF NOT EXISTS idx_logs_user ON access_logs(user_id);
        CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON access_logs(timestamp);
    `);

    // Crear índice UNIQUE para nombre de reportes (evitar duplicados)
    // Solo funciona si no hay duplicados existentes
    try {
        db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_reports_name_unique ON reports(name)`);
        console.log('🔒 Índice único en reportes creado');
    } catch (e) {
        console.log('⚠️ No se pudo crear índice único en reportes (posibles duplicados existentes)');
    }

    // Insertar usuario admin por defecto
    const adminPassword = bcrypt.hashSync('admin123', 10);
    const insertAdmin = db.prepare(`
        INSERT OR IGNORE INTO users (username, email, password,plain_password,full_name, role) 
        VALUES (?, ?, ?, ?, ?, ?)
    `);
    insertAdmin.run('admin', 'admin@powerbi.local', adminPassword, 'admin123','Administrador', 'admin');

    // Insertar reportes de ejemplo SOLO si no hay reportes en la base de datos
    const reportCount = db.prepare('SELECT COUNT(*) as count FROM reports').get();
    
    if (reportCount.count === 0) {
        const insertReport = db.prepare(`
            INSERT INTO reports (name, description, embed_url, category) 
            VALUES (?, ?, ?, ?)
        `);

        const sampleReports = [
            {
                name: 'Dashboard Ventas 2024',
                description: 'Dashboard principal de ventas con métricas clave',
                embed_url: 'https://app.powerbi.com/view?r=ejemplo_url_1',
                category: 'Ventas'
            },
            {
                name: 'Reporte Financiero Mensual',
                description: 'Análisis financiero detallado por mes',
                embed_url: 'https://app.powerbi.com/view?r=ejemplo_url_2',
                category: 'Finanzas'
            },
            {
                name: 'KPIs Operacionales',
                description: 'Indicadores clave de rendimiento operacional',
                embed_url: 'https://app.powerbi.com/view?r=ejemplo_url_3',
                category: 'Operaciones'
            }
        ];

        sampleReports.forEach(report => {
            insertReport.run(report.name, report.description, report.embed_url, report.category);
        });
        
        console.log('📊 3 reportes de ejemplo creados');
    } else {
        console.log('📊 Reportes existentes: ' + reportCount.count);
    }

    // Crear usuario de prueba
    const testUserPassword = bcrypt.hashSync('user123', 10);
    const insertTestUser = db.prepare(`
        INSERT OR IGNORE INTO users (username, email, password, plain_password,full_name, role) 
        VALUES (?, ?, ?, ?, ?, ?)
    `);
    insertTestUser.run('usuario1', 'usuario1@test.com', testUserPassword, 'user123','Usuario de Prueba', 'user');

    // Asignar permisos de ejemplo (solo si el usuario y reporte existen)
    try {
        const userExists = db.prepare('SELECT id FROM users WHERE id = 2').get();
        const reportExists = db.prepare('SELECT id FROM reports WHERE id = 1').get();
        
        if (userExists && reportExists) {
            const assignPermission = db.prepare(`
                INSERT OR IGNORE INTO user_report_permissions (user_id, report_id, can_view, can_export, granted_by) 
                VALUES (?, ?, ?, ?, ?)
            `);
            assignPermission.run(2, 1, 1, 0, 1);
        }
    } catch (e) {
        // Ignorar si falla la asignación de permisos de ejemplo
    }

    console.log('✅ Base de datos inicializada correctamente');
    console.log('👤 Usuario admin creado: admin / admin123');
    console.log('👤 Usuario de prueba creado: usuario1 / user123');

} catch (error) {
    console.error('Error inicializando base de datos:', error);
    process.exit(1);
}
    

