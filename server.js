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

// Inicializar base de datos si no existe
require('./config/init-db');

// Importar rutas
const authRoutes = require('./routes/auth.routes');
const userRoutes = require('./routes/user.routes');
const reportRoutes = require('./routes/report.routes');
const permissionRoutes = require('./routes/permission.routes');
const configRoutes = require('./routes/config.routes');

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
    // Content Security Policy básica
    res.setHeader('Content-Security-Policy', "frame-ancestors 'self'");
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

// Iniciar servidor
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Servidor corriendo en http://localhost:${PORT}`);
    console.log(`📊 Sistema de Gestión de Reportes Power BI activo`);
    console.log(`🔒 Modo: ${isProduction ? 'PRODUCCIÓN' : 'DESARROLLO'}`);
    if (isProduction) {
        console.log(`✅ Health check disponible en /api/health`);
    }
});