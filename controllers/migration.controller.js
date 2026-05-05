/**
 * Endpoint interno admin para migrar la SQLite del volumen → PostgreSQL.
 *
 * Solo accesible:
 *   - con auth (JWT admin) — protegido por adminMiddleware en la ruta
 *   - cuando DB_DRIVER=sqlite (no tiene sentido si ya es postgres)
 *   - cuando MIGRATION_ENABLED=1 (gate manual extra para evitar accidentes)
 *
 * Lee la SQLite del path indicado, conecta al PG con DATABASE_URL,
 * y corre la misma logica que scripts/migrate-sqlite-to-postgres.js.
 */
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { Pool } = require('pg');

const TABLES = [
    { name: 'users',
      columns: ['id','username','email','password','plain_password','full_name','role','is_active','created_at','updated_at'],
      sequence: 'users_id_seq' },
    { name: 'reports',
      columns: ['id','name','description','embed_url','category','is_active','created_at','updated_at'],
      sequence: 'reports_id_seq' },
    { name: 'user_report_permissions',
      columns: ['id','user_id','report_id','can_view','can_export','granted_at','granted_by'],
      sequence: 'user_report_permissions_id_seq' },
    { name: 'documents',
      columns: ['id','name','description','category','file_name','mime_type','file_size','file_data','is_active','uploaded_by','created_at','updated_at'],
      sequence: 'documents_id_seq',
      bytea: ['file_data'] },
    { name: 'user_document_permissions',
      columns: ['id','user_id','document_id','can_view','granted_at','granted_by'],
      sequence: 'user_document_permissions_id_seq' },
    { name: 'access_logs',
      columns: ['id','user_id','report_id','document_id','action','ip_address','user_agent','timestamp'],
      sequence: 'access_logs_id_seq' },
    { name: 'system_config',
      columns: ['id','config_key','config_value','description','updated_at'],
      sequence: 'system_config_id_seq' },
    { name: 'destinos', optional: true,
      columns: ['id','codigo_iata','nombre','pais','porcentaje_arancel','porcentaje_impuesto_consumo','is_active','created_at'],
      sequence: 'destinos_id_seq' },
    { name: 'cargueras', optional: true,
      columns: ['id','nombre','is_active','created_at'],
      sequence: 'cargueras_id_seq' },
    { name: 'tarifas_carguera', optional: true,
      columns: ['id','id_carguera','id_destino','peso_minimo','peso_maximo','tarifa_kilo','costo_cuarto_frio_kilo','costo_documentacion_fijo','fecha_inicio','fecha_fin','created_at'],
      sequence: 'tarifas_carguera_id_seq' },
    { name: 'tarifas_destino', optional: true,
      columns: ['id','id_destino','aduana_fija','transporte_interno_caja','rubros_dinamicos','fecha_inicio','fecha_fin','created_at'],
      sequence: 'tarifas_destino_id_seq',
      json: ['rubros_dinamicos'] },
    { name: 'cotizaciones_historico', optional: true,
      columns: ['id','user_id','fecha_proyeccion','snapshot','created_at'],
      sequence: 'cotizaciones_historico_id_seq',
      json: ['snapshot'] }
];

function tableExists(sqlite, name) {
    const r = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(name);
    return !!r;
}

function adaptRow(row, table) {
    const out = {};
    for (const col of table.columns) {
        let v = row[col];
        if (table.bytea && table.bytea.includes(col) && v != null && !Buffer.isBuffer(v)) {
            v = Buffer.from(v);
        }
        if (table.json && table.json.includes(col) && v != null && typeof v !== 'string') {
            v = JSON.stringify(v);
        }
        out[col] = v;
    }
    return out;
}

async function migrateHandler(req, res) {
    if (process.env.MIGRATION_ENABLED !== '1') {
        return res.status(403).json({
            success: false,
            message: 'MIGRATION_ENABLED=1 requerido para ejecutar este endpoint'
        });
    }

    if ((process.env.DB_DRIVER || 'sqlite').toLowerCase() !== 'sqlite') {
        return res.status(400).json({
            success: false,
            message: 'Este endpoint solo opera cuando DB_DRIVER=sqlite (lee SQLite, escribe PG)'
        });
    }

    const truncate = req.body && req.body.truncate === true;
    const dryRun   = req.body && req.body.dryRun === true;

    const sqlitePath = path.resolve(process.env.DB_PATH || './database/powerbi_reports.db');
    if (!fs.existsSync(sqlitePath)) {
        return res.status(404).json({ success: false, message: `SQLite no existe: ${sqlitePath}` });
    }
    if (!process.env.DATABASE_URL) {
        return res.status(500).json({ success: false, message: 'DATABASE_URL no configurada' });
    }

    const sqlite = new Database(sqlitePath, { readonly: true });
    const pg = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: process.env.NODE_ENV === 'production' && !process.env.DATABASE_URL.includes('localhost')
            ? { rejectUnauthorized: false } : false
    });

    const log = [];
    const summary = [];

    try {
        // 0. Aplicar schema PG si esta vacio
        const schemaPath = path.join(__dirname, '..', 'config', 'schema', 'postgres.sql');
        if (fs.existsSync(schemaPath)) {
            const sql = fs.readFileSync(schemaPath, 'utf8');
            await pg.query(sql);
            log.push('schema PG aplicado (idempotente)');
        }

        // 1. Truncate si pidio
        if (truncate && !dryRun) {
            const reversed = [...TABLES].reverse();
            const c = await pg.connect();
            try {
                await c.query('BEGIN');
                for (const t of reversed) {
                    try {
                        await c.query(`TRUNCATE TABLE ${t.name} RESTART IDENTITY CASCADE`);
                    } catch (e) { /* ignore tabla inexistente */ }
                }
                await c.query('COMMIT');
                log.push('truncate completado');
            } catch (e) {
                await c.query('ROLLBACK');
                throw new Error('truncate fallo: ' + e.message);
            } finally { c.release(); }
        }

        // 2. Migrar tabla por tabla
        for (const t of TABLES) {
            if (!tableExists(sqlite, t.name)) {
                if (t.optional) {
                    summary.push({ table: t.name, sqlite: 0, pg: 0, skipped: true });
                    continue;
                }
                throw new Error(`Tabla obligatoria ${t.name} no existe en SQLite`);
            }

            const total = sqlite.prepare(`SELECT COUNT(*) as c FROM ${t.name}`).get().c;
            if (total === 0 || dryRun) {
                summary.push({ table: t.name, sqlite: total, pg: dryRun ? 'dry-run' : 0, skipped: false });
                continue;
            }

            const cols = t.columns.join(', ');
            const rows = sqlite.prepare(`SELECT ${cols} FROM ${t.name}`).all();
            const placeholders = t.columns.map((_, i) => `$${i + 1}`).join(', ');
            const insertSql = `INSERT INTO ${t.name} (${cols}) VALUES (${placeholders})`;

            const c = await pg.connect();
            try {
                await c.query('BEGIN');
                let inserted = 0;
                for (const r of rows) {
                    const adapted = adaptRow(r, t);
                    const values = t.columns.map(col => adapted[col]);
                    await c.query(insertSql, values);
                    inserted++;
                }
                await c.query('COMMIT');
                summary.push({ table: t.name, sqlite: total, pg: inserted, skipped: false });
            } catch (e) {
                await c.query('ROLLBACK');
                throw new Error(`fallo en tabla ${t.name}: ${e.message}`);
            } finally { c.release(); }
        }

        // 3. Reset secuencias
        if (!dryRun) {
            for (const t of TABLES) {
                if (!t.sequence) continue;
                if (!tableExists(sqlite, t.name)) continue;
                try {
                    await pg.query(`
                        SELECT setval(
                            '${t.sequence}',
                            COALESCE((SELECT MAX(id) FROM ${t.name}), 1),
                            (SELECT MAX(id) FROM ${t.name}) IS NOT NULL
                        )
                    `);
                } catch (_) { /* ignorar */ }
            }
            log.push('secuencias reseteadas');
        }

        // 4. Verificar counts
        const verify = [];
        let allOk = true;
        for (const t of TABLES) {
            if (!tableExists(sqlite, t.name)) continue;
            const sCount = sqlite.prepare(`SELECT COUNT(*) as c FROM ${t.name}`).get().c;
            let pCount;
            try {
                const r = await pg.query(`SELECT COUNT(*)::int as c FROM ${t.name}`);
                pCount = r.rows[0].c;
            } catch (e) {
                verify.push({ table: t.name, sqlite: sCount, pg: 'ERROR: ' + e.message });
                allOk = false;
                continue;
            }
            const ok = sCount === pCount || dryRun;
            if (!ok) allOk = false;
            verify.push({ table: t.name, sqlite: sCount, pg: pCount, ok });
        }

        res.json({
            success: true,
            dryRun,
            truncate,
            log,
            summary,
            verify,
            countsMatch: allOk
        });
    } catch (e) {
        res.status(500).json({
            success: false,
            message: e.message,
            log,
            summary
        });
    } finally {
        sqlite.close();
        await pg.end();
    }
}

module.exports = { migrateHandler };
