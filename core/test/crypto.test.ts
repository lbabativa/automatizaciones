/** Prueba del cifrado de credenciales: simétrico clásico y con clave pública (consola → worker). Uso: npm run test:crypto */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
process.env.MASTER_KEY = randomBytes(32).toString('hex');
const { cifrar, descifrar, cifrarConClavePublica, clavePublicaWorker, esPayloadV2 } = await import('../src/crypto.js');

const clasico = cifrar('secreto-1');
assert.equal(descifrar(clasico), 'secreto-1');
assert.equal(esPayloadV2(clasico), false);

const publica = clavePublicaWorker();
assert.equal(publica, clavePublicaWorker(), 'la clave pública es determinista a partir de MASTER_KEY');
const v2 = cifrarConClavePublica('Clave*Portal 2026', publica);
assert.ok(esPayloadV2(v2));
assert.equal(descifrar(v2), 'Clave*Portal 2026', 'el worker descifra lo que la consola cifró con la pública');
assert.notEqual(cifrarConClavePublica('x', publica), cifrarConClavePublica('x', publica), 'cada cifrado usa una clave efímera distinta');

process.env.MASTER_KEY = randomBytes(32).toString('hex');
assert.throws(() => descifrar(v2), 'otra MASTER_KEY no descifra');
console.log('ok  cifrado simétrico y con clave pública');
