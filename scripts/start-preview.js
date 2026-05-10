// Wrapper para preview_start: cambia el cwd a _remote_clone antes de
// cargar server.js, así dotenv lee el .env correcto.
const path = require('path');
process.chdir(path.join(__dirname, '..'));
require('../server.js');
