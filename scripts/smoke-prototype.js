/**
 * Smoke test integral para feature/finalize-prototype:
 * - Login admin (must_change_password=1)
 * - changeMyPassword
 * - Re-login con la nueva pass
 * - PR-0c: subir un PDF chico, listar, ver via streamDocument (chequear bytes)
 * - PR-3d: emitir memo a "all", listar inbox, verificar hash, acusar
 * - hotfix: crear empleado dummy → DELETE /api/hr/employees/:id → confirmar 404
 *
 * Run: node scripts/smoke-prototype.js
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const HOST = '127.0.0.1';
const PORT = process.env.PORT || 3001;

function req(method, urlPath, opts = {}) {
    const { token, body, contentType, raw } = opts;
    return new Promise((resolve, reject) => {
        const headers = {};
        if (token) headers['Authorization'] = 'Bearer ' + token;
        let payload = null;
        if (body !== undefined) {
            if (Buffer.isBuffer(body) || typeof body === 'string') {
                payload = body;
                if (contentType) headers['Content-Type'] = contentType;
            } else {
                payload = Buffer.from(JSON.stringify(body));
                headers['Content-Type'] = 'application/json';
            }
            headers['Content-Length'] = payload.length;
        }
        const r = http.request({ host: HOST, port: PORT, path: urlPath, method, headers }, (res) => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => {
                const buf = Buffer.concat(chunks);
                if (raw) return resolve({ status: res.statusCode, headers: res.headers, body: buf });
                let parsed;
                try { parsed = JSON.parse(buf.toString('utf8')); } catch { parsed = buf.toString('utf8'); }
                resolve({ status: res.statusCode, body: parsed });
            });
        });
        r.on('error', reject);
        if (payload) r.write(payload);
        r.end();
    });
}

function buildMultipart(fields, fileField, fileName, fileBuffer, mimeType) {
    const boundary = '----SmokeBoundary' + Math.random().toString(36).slice(2);
    const parts = [];
    for (const [k, v] of Object.entries(fields || {})) {
        parts.push(Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`
        ));
    }
    parts.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${fileField}"; filename="${fileName}"\r\nContent-Type: ${mimeType}\r\n\r\n`
    ));
    parts.push(fileBuffer);
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
    return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

function assert(cond, msg) {
    if (!cond) { console.error('❌ FAIL:', msg); process.exit(1); }
    console.log('   ✓', msg);
}

(async () => {
    console.log('=== smoke prototype ===');

    // 1. Health
    let r = await req('GET', '/api/health');
    assert(r.status === 200 && r.body.status === 'ok', 'health responde 200');

    // 2. Login admin con seed.
    r = await req('POST', '/api/auth/login', { body: { username: 'admin', password: 'admin123' } });
    assert(r.status === 200 && r.body.success, 'login admin exitoso');
    let token = r.body.data.token;

    // 3. Change password (must_change_password=1).
    const NEW_PASS = 'SmokeTestNew123!';
    r = await req('POST', '/api/auth/change-my-password',
        { token, body: { current_password: 'admin123', new_password: NEW_PASS } });
    assert(r.status === 200 && r.body.success, 'change-my-password OK');

    // 4. Re-login con la nueva.
    r = await req('POST', '/api/auth/login', { body: { username: 'admin', password: NEW_PASS } });
    assert(r.status === 200 && r.body.success, 'login con nueva pass OK');
    token = r.body.data.token;

    // 5. PR-0c: subir un PDF mínimo válido.
    // Generamos un PDF mínimo (header válido + EOF) — PDF.js no lo abrirá pero
    // streamDocument solo necesita que se persista y se devuelva igual.
    const pdfBuf = Buffer.from(
        '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
        '2 0 obj<</Type/Pages/Count 0/Kids[]>>endobj\n' +
        'xref\n0 3\n0000000000 65535 f \n0000000009 00000 n \n0000000054 00000 n \n' +
        'trailer<</Size 3/Root 1 0 R>>\nstartxref\n95\n%%EOF\n', 'binary'
    );
    const mp = buildMultipart(
        { name: 'Smoke Doc', description: 'PDF de prueba', category: 'Pruebas' },
        'file', 'smoke.pdf', pdfBuf, 'application/pdf'
    );
    r = await req('POST', '/api/documents', { token, body: mp.body, contentType: mp.contentType });
    assert(r.status === 201 && r.body.success, 'createDocument OK');
    const docId = r.body.data.id;

    // 6. Verificar archivo en el filesystem.
    const docsDir = process.env.DOCUMENTS_DIR || path.join(process.cwd(), 'data', 'documents');
    const files = fs.readdirSync(docsDir);
    assert(files.length >= 1, `archivo persistido en ${docsDir} (${files.length} files)`);

    // 7. Stream del documento. Comparar bytes.
    r = await req('GET', `/api/documents/${docId}/stream`, { token, raw: true });
    assert(r.status === 200, 'streamDocument 200');
    assert(r.body.equals(pdfBuf), 'bytes del stream coinciden con el PDF subido');

    // 8. Listar mis documentos (admin ve todos).
    r = await req('GET', '/api/documents/my-documents', { token });
    assert(r.status === 200 && r.body.success && r.body.data.documents.length >= 1, 'getMyDocuments incluye el subido');

    // 9. PR-3d: emitir memo "all".
    r = await req('POST', '/api/hr/memos', {
        token,
        body: {
            subject: 'Bienvenidos al portal Helper Ecualand',
            content: 'Memo de bienvenida con hash inmutable.',
            target_type: 'all',
            severity: 'info'
        }
    });
    assert(r.status === 201 && r.body.success, 'createMemo all OK');
    const memoId = r.body.data.id;
    const expectedHash = crypto.createHash('sha256')
        .update('Bienvenidos al portal Helper Ecualand\nMemo de bienvenida con hash inmutable.', 'utf8')
        .digest('hex');
    assert(r.body.data.content_hash === expectedHash, 'hash SHA-256 calculado correctamente');

    // 10. Listar inbox.
    r = await req('GET', '/api/hr/memos/inbox', { token });
    assert(r.status === 200 && r.body.success, 'inbox responde 200');
    const found = r.body.data.memos.find(m => m.id === memoId);
    assert(!!found, 'memo aparece en la inbox del admin');

    // 11. Get detalle, verificar integridad.
    r = await req('GET', `/api/hr/memos/${memoId}`, { token });
    assert(r.status === 200 && r.body.success, 'getMemo 200');
    assert(r.body.data.content_integrity === true, 'content_integrity=true');

    // 12. Acusar.
    r = await req('POST', `/api/hr/memos/${memoId}/ack`, { token });
    assert(r.status === 200 && r.body.success, 'ack OK');

    // 13. Idempotencia ack.
    r = await req('POST', `/api/hr/memos/${memoId}/ack`, { token });
    assert(r.status === 200, 'ack idempotente');

    // 14. Hotfix: crear empleado dummy y borrarlo.
    r = await req('POST', '/api/hr/employees', {
        token, body: { full_name: 'Dummy SmokeTest', hire_date: '2026-01-01' }
    });
    assert(r.status === 201 && r.body.success, 'createEmployee dummy OK');
    const empId = r.body.data.id;

    r = await req('DELETE', `/api/hr/employees/${empId}`, { token });
    assert(r.status === 200 && r.body.success, 'DELETE employee OK');

    r = await req('GET', `/api/hr/employees/${empId}`, { token });
    assert(r.status === 404, 'empleado borrado responde 404');

    // 15. Borrar el documento (cleanup) y comprobar que el archivo desaparece.
    r = await req('DELETE', `/api/documents/${docId}`, { token });
    assert(r.status === 200 && r.body.success, 'deleteDocument OK');
    const filesAfter = fs.readdirSync(docsDir);
    assert(filesAfter.length === files.length - 1, 'archivo desapareció del volumen tras delete');

    console.log('\n✅ TODOS los smoke tests pasaron.');
})().catch(err => { console.error('❌ smoke crash:', err); process.exit(1); });
