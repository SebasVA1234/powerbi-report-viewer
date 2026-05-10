/**
 * PR-0c: storage helper para documentos (PDFs).
 *
 * En desarrollo (sin DOCUMENTS_DIR seteado): ./data/documents (relativo al
 * cwd del proceso). En Railway: /app/data/documents → montaje del volumen
 * powerbi-report-viewer-volu... Idempotente: si la carpeta no existe la crea.
 *
 * Por qué a filesystem y no a BLOB en la DB:
 *   - Postgres BYTEA fuerza al driver a deserializar buffers grandes a memoria
 *     en cada SELECT, dispara TOAST y degrada queries. Filesystem es O(1).
 *   - Permite respaldar el volumen aparte de la DB.
 *   - El schema histórico (file_data BLOB) sigue funcionando para docs viejos
 *     mientras los nuevos se escriben al filesystem (storage_key).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function getDocumentsDir() {
    return process.env.DOCUMENTS_DIR || path.join(process.cwd(), 'data', 'documents');
}

function ensureDocumentsDir() {
    const dir = getDocumentsDir();
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        console.log(`📁 Carpeta de documentos creada: ${dir}`);
    }
    return dir;
}

// storage_key estable (random + extensión). Se persiste en DB documents.storage_key
// y se usa para resolver la ruta absoluta al servir/borrar.
function newStorageKey(originalName) {
    const ext = (path.extname(originalName) || '.pdf').toLowerCase();
    const safeExt = /^\.[a-z0-9]{1,8}$/.test(ext) ? ext : '.pdf';
    return crypto.randomBytes(16).toString('hex') + safeExt;
}

function resolveStoragePath(storageKey) {
    if (!storageKey || /[\\/]/.test(storageKey) || storageKey.includes('..')) {
        throw new Error('storage_key inválida');
    }
    return path.join(getDocumentsDir(), storageKey);
}

function writeBufferToStorage(storageKey, buffer) {
    const full = resolveStoragePath(storageKey);
    fs.writeFileSync(full, buffer);
    return full;
}

function deleteFromStorage(storageKey) {
    if (!storageKey) return;
    const full = resolveStoragePath(storageKey);
    if (fs.existsSync(full)) fs.unlinkSync(full);
}

module.exports = {
    getDocumentsDir,
    ensureDocumentsDir,
    newStorageKey,
    resolveStoragePath,
    writeBufferToStorage,
    deleteFromStorage
};
