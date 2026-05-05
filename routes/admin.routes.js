const express = require('express');
const router = express.Router();
const { authMiddleware, adminMiddleware } = require('../middleware/auth.middleware');
const { migrateHandler } = require('../controllers/migration.controller');

// Endpoint interno para migrar SQLite -> PostgreSQL desde el container.
// Doble candado:
//   - JWT admin (authMiddleware + adminMiddleware)
//   - env var MIGRATION_ENABLED=1 (gate explicito)
//   - Solo cuando DB_DRIVER=sqlite (verificado dentro del controller)
router.post('/migrate-from-sqlite', authMiddleware, adminMiddleware, migrateHandler);

// Health check del propio endpoint (para verificar que está disponible
// despues del deploy sin disparar nada).
router.get('/migrate-status', authMiddleware, adminMiddleware, (req, res) => {
    res.json({
        success: true,
        data: {
            db_driver: process.env.DB_DRIVER || 'sqlite',
            db_path: process.env.DB_PATH || './database/powerbi_reports.db',
            migration_enabled: process.env.MIGRATION_ENABLED === '1',
            has_database_url: !!process.env.DATABASE_URL
        }
    });
});

module.exports = router;
