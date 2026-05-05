const express = require('express');
const cors = require('cors');
const path = require('path');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
require('dotenv').config();

// Validar JWT_SECRET en producción
if (process.env.NODE_ENV === 'production' && !process.env.JWT_SECRET) {
    console.error('❌ ERROR: JWT_SECRET no está configurado en producción');
    process.exit(1);
}

// La inicialización de la DB se hace al final, antes de app.listen() —
// es async ahora porque la capa de DB soporta SQLite y PostgreSQL.
const { init: initDb } = require('./config/init-db');

// Importar rutas
const authRoutes = require('./routes/auth.routes');
const userRoutes = require('./routes/user.routes');
const reportRoutes = require('./routes/report.routes');
const permissionRoutes = require('./routes/permission.routes');
const configRoutes = require('./routes/config.routes');
const documentRoutes = require('./routes/document.routes');
const cotizadorRoutes = require('./routes/cotizador.routes');
const adminRoutes = require('./routes/admin.routes');

const app = express();
const PORT = process.env.PORT || 3000;
const isProduction = process.env.NODE_ENV === 'production';

// =============================================
// SEGURIDAD - Headers HTTP
// =============================================
app.use((req, res, next) => {
    // Prevenir clickjacking
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    // Prevenir sniffing de MIME type
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // XSS Protection
    res.setHeader('X-XSS-Protection', '1; mode=block');
    // Referrer Policy
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    // Content Security Policy
    //  - frame-ancestors 'self'   -> impide que nuestra app sea embebida en sitios ajenos
    //  - worker-src blob:         -> PDF.js necesita levantar un Web Worker desde blob:
    //  - frame-src / child-src    -> iframes permitidos: Power BI + Fabric
    //                                 (child-src es fallback para navegadores viejos)
    const powerbiFrames = [
        "https://app.powerbi.com",
        "https://app.fabric.microsoft.com",
        "https://*.powerbi.com",
        "https://*.fabric.microsoft.com"
    ].join(' ');
    res.setHeader(
        'Content-Security-Policy',
        [
            "frame-ancestors 'self'",
            "worker-src 'self' blob:",
            `frame-src 'self' ${powerbiFrames}`,
            `child-src 'self' blob: ${powerbiFrames}`
        ].join('; ')
    );
    next();
});

// Rate limiting (Seguridad contra ataques de fuerza bruta)
const limiter = rateLimit({
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
    max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 100,
    message: {
        success: false,
        message: 'Demasiadas peticiones, intente más tarde'
    },
    standardHeaders: true,
    legacyHeaders: false
});

// Rate limit más estricto para login (prevenir fuerza bruta)
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutos
    max: 5, // máximo 5 intentos de login
    message: {
        success: false,
        message: 'Demasiados intentos de login, intente en 15 minutos'
    }
});

// Configuración de CORS
const corsOptions = {
    origin: process.env.ALLOWED_ORIGINS === '*' 
        ? '*' 
        : process.env.ALLOWED_ORIGINS?.split(',') || '*',
    credentials: true,
    optionsSuccessStatus: 200
};

// Middlewares Globales
app.use(cors(corsOptions));
app.use(express.json({ limit: '1mb' })); // Limitar tamaño de payload
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use('/api/', limiter);
app.use('/api/auth/login', loginLimiter);

// Servir archivos estáticos (el frontend)
app.use(express.static(path.join(__dirname, 'public')));

// =============================================
// HEALTH CHECK - Para Railway
// =============================================
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
    });
});

// Definición de Rutas API
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/permissions', permissionRoutes);
app.use('/api/config', configRoutes);
app.use('/api/documents', documentRoutes);
app.use('/api/cotizador', cotizadorRoutes);
app.use('/api/_admin', adminRoutes);

// Ruta para cualquier otra petición (SPA - Single Page Application)
// Esto hace que si refrescas la página en /dashboard, no de error 404
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Manejo de errores global
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({
        success: false,
        message: 'Error interno del servidor'
    });
});

// Iniciar servidor — primero inicializa la DB (async), después escucha
(async () => {
    try {
        await initDb();
    } catch (err) {
        console.error('❌ Error inicializando la base de datos:', err);
        process.exit(1);
    }

    app.listen(PORT, '0.0.0.0', () => {
        console.log(`🚀 Servidor corriendo en http://localhost:${PORT}`);
        console.log(`📊 Sistema de Gestión de Reportes Power BI activo`);
        console.log(`🔒 Modo: ${isProduction ? 'PRODUCCIÓN' : 'DESARROLLO'}`);
        if (isProduction) {
            console.log(`✅ Health check disponible en /api/health`);
        }
    });
})();