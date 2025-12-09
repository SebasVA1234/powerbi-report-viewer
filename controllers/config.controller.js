const db = require('../config/database');

// Obtener configuración pública (sin autenticación)
const getPublicConfig = (req, res) => {
    try {
        const publicKeys = ['max_report_windows'];
        
        const placeholders = publicKeys.map(() => '?').join(',');
        const configs = db.prepare(`
            SELECT config_key, config_value 
            FROM system_config 
            WHERE config_key IN (${placeholders})
        `).all(...publicKeys);

        const configObj = {};
        configs.forEach(c => {
            configObj[c.config_key] = c.config_value;
        });

        res.json({
            success: true,
            data: configObj
        });
    } catch (error) {
        console.error('Error obteniendo configuración pública:', error);
        res.status(500).json({
            success: false,
            message: 'Error al obtener configuración'
        });
    }
};

// Obtener todas las configuraciones (solo admin)
const getAllConfig = (req, res) => {
    try {
        const configs = db.prepare('SELECT config_key, config_value, description FROM system_config').all();
        
        const configObj = {};
        configs.forEach(c => {
            configObj[c.config_key] = {
                value: c.config_value,
                description: c.description
            };
        });

        res.json({
            success: true,
            data: configObj
        });
    } catch (error) {
        console.error('Error obteniendo configuración:', error);
        res.status(500).json({
            success: false,
            message: 'Error al obtener configuración'
        });
    }
};

// Actualizar una configuración (solo admin)
const updateConfig = (req, res) => {
    try {
        const { key } = req.params;
        const { value } = req.body;

        if (value === undefined || value === null) {
            return res.status(400).json({
                success: false,
                message: 'El valor es requerido'
            });
        }

        // Validaciones específicas
        if (key === 'max_report_windows') {
            const numValue = parseInt(value);
            if (isNaN(numValue) || numValue < 1 || numValue > 10) {
                return res.status(400).json({
                    success: false,
                    message: 'El máximo de ventanas debe estar entre 1 y 10'
                });
            }
        }

        const result = db.prepare(`
            UPDATE system_config 
            SET config_value = ?, updated_at = CURRENT_TIMESTAMP 
            WHERE config_key = ?
        `).run(value.toString(), key);

        if (result.changes === 0) {
            return res.status(404).json({
                success: false,
                message: 'Configuración no encontrada'
            });
        }

        res.json({
            success: true,
            message: 'Configuración actualizada correctamente',
            data: {
                key: key,
                value: value.toString()
            }
        });
    } catch (error) {
        console.error('Error actualizando configuración:', error);
        res.status(500).json({
            success: false,
            message: 'Error al actualizar configuración'
        });
    }
};

module.exports = {
    getPublicConfig,
    getAllConfig,
    updateConfig
};
