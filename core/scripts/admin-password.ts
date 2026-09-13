/**
 * Genera el hash para ADMIN_PASSWORD_HASH a partir de la variable ADMIN_PASSWORD
 * (se lee del entorno, nunca de argumentos, para que no quede en el historial).
 * Uso: ADMIN_PASSWORD=... npm run admin:password
 */
import { hashPassword } from '../src/crypto.js';

const password = process.env.ADMIN_PASSWORD;
if (!password) {
  console.error('Falta la variable ADMIN_PASSWORD');
  process.exit(1);
}
console.log(`ADMIN_PASSWORD_HASH=${hashPassword(password)}`);
