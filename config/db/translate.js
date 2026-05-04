/**
 * Traduce SQL con placeholders estilo SQLite (?) a PostgreSQL ($1, $2, ...).
 * Respeta strings con comillas simples y dobles, escapes '', "".
 *
 * Ejemplo:
 *   "SELECT * FROM users WHERE id = ? AND name = 'foo?bar'"
 *   -> "SELECT * FROM users WHERE id = $1 AND name = 'foo?bar'"
 */
function translateToPg(sql) {
    let out = '';
    let i = 0;
    let counter = 0;
    let inString = false;
    let stringChar = null;

    while (i < sql.length) {
        const c = sql[i];

        if (inString) {
            out += c;
            if (c === stringChar) {
                // SQL escapa la quote duplicandola: '' o ""
                if (sql[i + 1] === stringChar) {
                    out += sql[i + 1];
                    i += 2;
                    continue;
                }
                inString = false;
            }
            i++;
            continue;
        }

        if (c === "'" || c === '"') {
            inString = true;
            stringChar = c;
            out += c;
            i++;
            continue;
        }

        if (c === '?') {
            counter++;
            out += '$' + counter;
            i++;
            continue;
        }

        out += c;
        i++;
    }

    return out;
}

module.exports = { translateToPg };
