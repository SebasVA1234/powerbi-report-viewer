const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
require('dotenv').config();

// Validar JWT_SECRET — debe existir, tener ≥32 chars y no ser el default
const JWT_DEFAULT = 'tu_secreto_super_seguro_aqui';
if (!process.env.JWT_SECRET || process.env.JWT_SECRET === JWT_DEFAULT || process.env.JWT_SECRET.length < 32) {
    console.error('❌ ERROR: JWT_SECRET inválido. Debe tener ≥32 caracteres y no ser el valor default.');
    console.error('   Generar uno seguro: node -e "console.log(require(\'crypto\').randomBytes(64).toString(\'hex\'))"');
    process.exit(1);
}

// La inicialización de la DB se hace al final, antes de app.listen() —
// es async ahora porque la capa de DB soporta SQLite y PostgreSQL.
const { init: initDb } = require('./config/init-db');
const storage = require('./config/storage');

// Importar rutas
const authRoutes = require('./routes/auth.routes');
const userRoutes = require('./routes/user.routes');
const reportRoutes = require('./routes/report.routes');
const permissionRoutes = require('./routes/permission.routes');
const configRoutes = require('./routes/config.routes');
const documentRoutes = require('./routes/document.routes');
const cotizadorRoutes = require('./routes/cotizador.routes');
const adminRoutes = require('./routes/admin.routes');
const rbacRoutes = require('./routes/rbac.routes');
const hrRoutes = require('./routes/hr.routes');

const app = express();
const PORT = process.env.PORT || 3000;
const isProduction = process.env.NODE_ENV === 'production';

// =============================================
// SEGURIDAD - Headers HTTP via helmet
// =============================================
//  - frame-ancestors 'self'   -> impide que nuestra app sea embebida en sitios ajenos
//  - worker-src blob:         -> PDF.js necesita levantar un Web Worker desde blob:
//  - frame-src / child-src    -> iframes permitidos: Power BI + Fabric
//  - script/style 'unsafe-inline' se mantiene temporalmente: el HTML actual usa
//    handlers onclick="..." inline. Se endurece en Fase 2 (refactor frontend).
//  - HSTS habilitado: navegadores deben usar HTTPS para los próximos 12 meses.
const powerbiFrames = [
    "https://app.powerbi.com",
    "https://app.fabric.microsoft.com",
    "https://*.powerbi.com",
    "https://*.fabric.microsoft.com",
    // Microsoft OAuth — el iframe de Power BI redirige a login.microsoftonline.com
    // para el flow de autenticación. Sin estos dominios el CSP bloquea el redirect
    // y el iframe queda en blanco (sin mostrar "Sign in" ni nada).
    "https://login.microsoftonline.com",
    "https://login.microsoft.com",
    "https://login.windows.net",
    "https://*.microsoftonline.com",
    "https://*.windows.net",
    "https://aadcdn.msftauth.net"
];
// Conexiones XHR/fetch que el portal hace además de las del iframe. Power BI
// usa endpoints de api.powerbi.com y wabi-*.analysis.windows.net para datos.
const microsoftConnect = [
    "https://*.powerbi.com",
    "https://*.microsoft.com",
    "https://*.microsoftonline.com",
    "https://*.windows.net",
    "https://*.azure.com"
];
app.use(helmet({
    contentSecurityPolicy: {
        useDefaults: false,
        directives: {
            'default-src': ["'self'"],
            // PR-0c: PDF.js ahora se sirve local (/vendor/pdfjs/*) desde
            // node_modules/pdfjs-dist; ya no necesitamos cdnjs.cloudflare.com.
            'script-src': ["'self'", "'unsafe-inline'"],
            // PR-2a: permitir Google Fonts (Inter) para el design system antigravity.
            'style-src':  ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
            'font-src':   ["'self'", "data:", "https://fonts.gstatic.com"],
            'img-src':    ["'self'", "data:", "https:"],
            'connect-src':["'self'", ...microsoftConnect],
            'frame-ancestors': ["'self'"],
            'worker-src': ["'self'", "blob:"],
            'frame-src':  ["'self'", ...powerbiFrames],
            'child-src':  ["'self'", "blob:", ...powerbiFrames],
            // form-action permite que el form POST del login OAuth de Microsoft
            // (action="https://login.microsoftonline.com/...") complete sin que
            // el browser lo bloquee por política CSP.
            'form-action': ["'self'", ...powerbiFrames]
        }
    },
    hsts: { maxAge: 31536000, includeSubDomains: true, preload: false },
    crossOriginEmbedderPolicy: false,
    // CRÍTICO para Power BI OAuth: COOP=same-origin (default de helmet) aísla
    // los popups del iframe cross-origin. Resultado: Power BI abre el popup
    // de Sign-in, intenta navegarlo a login.microsoftonline.com, pero como
    // el popup está "isolated" no recibe la URL → queda en about:blank.
    // 'unsafe-none' (o false) restaura el comportamiento clásico donde el
    // iframe SÍ puede controlar su propio popup.
    crossOriginOpenerPolicy: false,
    // CORP=same-origin (default) bloquea recursos de Microsoft (CDN de
    // login, imágenes del form) cuando son cross-origin. 'cross-origin'
    // permite que assets de otros dominios se carguen sin error.
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    // 'strict-origin-when-cross-origin' rompía el OAuth popup de Power BI:
    // Microsoft necesita el referrer completo para validar la sesión del
    // user al hacer Sign-in dentro del iframe. Con la política estricta el
    // popup quedaba en about:blank. 'origin-when-cross-origin' es el
    // balance: mantiene la privacidad (no exporta paths internos cross-site)
    // pero envía el origin que Microsoft necesita.
    referrerPolicy: { policy: 'origin-when-cross-origin' }
}));

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
// RATE_LIMIT_LOGIN_MAX puede subirse temporalmente para pruebas masivas
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutos
    max: parseInt(process.env.RATE_LIMIT_LOGIN_MAX) || 5,
    message: {
        success: false,
        message: 'Demasiados intentos de login, intente en 15 minutos'
    }
});

// Configuración de CORS — whitelist explícita por env var
// ALLOWED_ORIGINS=* (legacy) o ALLOWED_ORIGINS=https://a.com,https://b.com
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
const corsOptions = {
    origin: allowedOrigins.length === 0 || allowedOrigins.includes('*')
        ? '*'
        : allowedOrigins,
    credentials: true,
    optionsSuccessStatus: 200
};
if (isProduction && (allowedOrigins.length === 0 || allowedOrigins.includes('*'))) {
    console.warn('⚠️  ALLOWED_ORIGINS está vacío o "*" en producción. Recomendado: setear la(s) URL(s) exactas.');
}

// Middlewares Globales
app.use(cors(corsOptions));
app.use(express.json({ limit: '1mb' })); // Limitar tamaño de payload
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use('/api/', limiter);
app.use('/api/auth/login', loginLimiter);

// Servir archivos estáticos (el frontend)
app.use(express.static(path.join(__dirname, 'public')));

// PR-0c: servir PDF.js v4 local (ESM + worker) desde node_modules/pdfjs-dist.
// Cache largo + immutable porque la URL contiene el path versionado por npm.
app.use('/vendor/pdfjs', express.static(
    path.join(__dirname, 'node_modules', 'pdfjs-dist', 'legacy', 'build'),
    { maxAge: '7d', immutable: true }
));
app.use('/vendor/pdfjs/cmaps', express.static(
    path.join(__dirname, 'node_modules', 'pdfjs-dist', 'cmaps'),
    { maxAge: '7d', immutable: true }
));

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
app.use('/api/rbac', rbacRoutes);
app.use('/api/hr', hrRoutes);

// 404 JSON para cualquier ruta /api/* no matcheada por las routes de arriba.
// Antes el catch-all SPA agarraba estas rutas y devolvía index.html con 200,
// confundiendo a clientes API y enmascarando endpoints inexistentes.
app.use('/api', (req, res) => {
    res.status(404).json({ success: false, message: 'Endpoint no encontrado' });
});

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
        // PR-0c: asegurar que el dir de documentos existe (./data/documents
        // local, /app/data/documents en Railway con DOCUMENTS_DIR seteado).
        storage.ensureDocumentsDir();
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