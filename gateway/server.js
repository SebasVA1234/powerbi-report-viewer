/**
 * Gateway de borde de Helper Ecualand (estilo Bifrost).
 *
 * Es la ÚNICA puerta pública del sistema. Su trabajo es chico y claro:
 *   1) Recibir el tráfico público (TLS lo termina Railway en el borde).
 *   2) Rate-limit de BORDE (frena floods ANTES de llegar al backend).
 *   3) Cabeceras de seguridad base (defensa en profundidad).
 *   4) Reenviar la IP real del cliente (X-Forwarded-For) al backend.
 *   5) Hacer PROXY de TODO al backend PRIVADO (red interna de Railway).
 *
 * El backend (la app Express monolito) queda SIN dominio público: sólo lo
 * alcanza este gateway por red privada. La base de datos ya es privada.
 *
 * Diseño deliberadamente mínimo (sin "camisas de fuerza"): ~1 archivo, sin
 * lógica de negocio. Si un junior lee esto, entiende qué hace en 2 minutos.
 */
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { createProxyMiddleware } = require('http-proxy-middleware');

const app = express();
const PORT = process.env.PORT || 8080;

// Destino PRIVADO: el servicio backend en la red interna de Railway. Se setea por
// env para no hardcodear; el default apunta al nombre interno del servicio actual.
// El backend escucha en el puerto 3000 (ver su Dockerfile).
const BACKEND_URL = process.env.BACKEND_URL || 'http://powerbi-report-viewer.railway.internal:3000';

// Detrás del proxy de Railway: confiamos en X-Forwarded-* para ver la IP real del
// cliente (si no, el rate-limit contaría todo como una sola IP, la del borde).
app.set('trust proxy', 1);

// Cabeceras de seguridad de borde. NO ponemos CSP acá: la define el backend, que
// conoce sus orígenes (iframes de Power BI). Duplicarla rompería esos iframes.
app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: false,
    crossOriginResourcePolicy: false
}));

// Health del PROPIO gateway (para el healthcheck de Railway). Responde sin tocar
// el backend, así Railway no mata el gateway si el backend tiene un hipo puntual.
// Path con prefijo raro para no colisionar con rutas reales de la app.
app.get('/__gateway/health', (req, res) => {
    res.json({ status: 'ok', role: 'gateway', target: BACKEND_URL });
});

// Rate-limit de BORDE. Generoso (app interna), pero corta abusos antes del backend.
// El backend mantiene SU propio rate-limit → doble red (defensa en profundidad).
const limiter = rateLimit({
    windowMs: parseInt(process.env.GATEWAY_RATE_WINDOW_MS, 10) || 15 * 60 * 1000,
    max: parseInt(process.env.GATEWAY_RATE_MAX, 10) || 1000,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, message: 'Demasiadas peticiones (gateway). Intentá más tarde.' }
});
app.use(limiter);

// PROXY de TODO al backend privado.
//  - changeOrigin: ajusta el Host al del target.
//  - xfwd: agrega X-Forwarded-For/Host/Proto (IP real del cliente para el backend).
//  - NO montamos express.json() antes: así el body de POST/PUT se reenvía en crudo.
//  - onError: si el backend no responde, devolvemos 502 limpio (no se cuelga).
app.use('/', createProxyMiddleware({
    target: BACKEND_URL,
    changeOrigin: true,
    xfwd: true,
    proxyTimeout: 30_000,
    timeout: 30_000,
    onError(err, req, res) {
        console.error('[gateway] error de proxy:', err.message);
        if (res && !res.headersSent) {
            res.status(502).json({ success: false, message: 'Gateway: el backend no está disponible' });
        }
    }
}));

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🛡️  Gateway escuchando en :${PORT}  →  ${BACKEND_URL}`);
});
