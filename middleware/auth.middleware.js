const jwt = require('jsonwebtoken');

// Endpoints permitidos cuando el user tiene must_change_password=1.
// Cualquier otro endpoint devolverá 403 con code:'PASSWORD_CHANGE_REQUIRED'
// hasta que cambie su pass.
const PASSWORD_CHANGE_ALLOWED_PATHS = new Set([
    '/api/auth/change-my-password',
    '/api/auth/logout',
    '/api/auth/verify'
]);

const authMiddleware = (req, res, next) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];

        if (!token) {
            return res.status(401).json({
                success: false,
                message: 'Token de autenticación no proporcionado'
            });
        }

        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.user = decoded;

        // Bloqueo por cambio de contraseña pendiente: el user solo puede
        // golpear el endpoint que cambia su pass (o cerrar sesión).
        if (decoded.must_change_password) {
            const fullPath = req.baseUrl + req.path;
            if (!PASSWORD_CHANGE_ALLOWED_PATHS.has(fullPath)) {
                return res.status(403).json({
                    success: false,
                    code: 'PASSWORD_CHANGE_REQUIRED',
                    message: 'Debes cambiar tu contraseña antes de continuar'
                });
            }
        }

        next();
    } catch (error) {
        if (error.name === 'TokenExpiredError') {
            return res.status(401).json({
                success: false,
                message: 'Token expirado, por favor inicie sesión nuevamente'
            });
        }

        return res.status(401).json({
            success: false,
            message: 'Token inválido'
        });
    }
};

const adminMiddleware = (req, res, next) => {
    if (req.user.role !== 'admin') {
        return res.status(403).json({
            success: false,
            message: 'Acceso denegado. Se requieren permisos de administrador'
        });
    }
    next();
};

module.exports = {
    authMiddleware,
    adminMiddleware
};
