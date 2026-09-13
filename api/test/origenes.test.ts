/**
 * Prueba de los dominios permitidos (CORS): validación de patrones y coincidencia de orígenes.
 * No necesita Mongo.
 *
 * Uso: npm run test:origenes
 */
import assert from 'node:assert/strict';
import { normalizarOrigen, origenPermitido, validarPatron } from '../src/origenes.js';

assert.equal(validarPatron('https://Portal.CardioIB.com/'), 'https://portal.cardioib.com');
assert.equal(validarPatron('https://portal.cardioib.com:443'), 'https://portal.cardioib.com', 'el puerto por defecto se quita');
assert.equal(validarPatron('https://*.cardioib.com'), 'https://*.cardioib.com');
assert.equal(validarPatron('http://localhost:3000'), 'http://localhost:3000');
assert.equal(validarPatron('portal.cardioib.com'), null, 'sin esquema');
assert.equal(validarPatron('https://portal.cardioib.com/consultas'), null, 'con ruta');
assert.equal(validarPatron('https://*'), null);
assert.equal(validarPatron('ftp://cardioib.com'), null);
console.log('ok  validación y normalización de patrones');

const patrones = ['https://portal.cardioib.com', 'https://*.startia.tech', 'http://localhost:3000'];
assert.ok(origenPermitido('https://portal.cardioib.com', patrones));
assert.ok(origenPermitido('HTTPS://PORTAL.CARDIOIB.COM', patrones));
assert.ok(!origenPermitido('http://portal.cardioib.com', patrones), 'otro esquema');
assert.ok(!origenPermitido('https://portal.cardioib.com.evil.com', patrones));
assert.ok(!origenPermitido('https://portal.cardioib.com:8443', patrones), 'otro puerto');
assert.ok(origenPermitido('https://app.startia.tech', patrones));
assert.ok(origenPermitido('https://a.b.startia.tech', patrones));
assert.ok(!origenPermitido('https://startia.tech', patrones), 'el comodín no incluye el dominio raíz');
assert.ok(!origenPermitido('https://evilstartia.tech', patrones));
assert.ok(origenPermitido('http://localhost:3000', patrones));
assert.ok(!origenPermitido('http://localhost:3001', patrones));
assert.ok(!origenPermitido('null', patrones), 'páginas locales o en sandbox');
assert.ok(!origenPermitido('https://portal.cardioib.com', []), 'sin dominios no se permite ninguno');
assert.equal(normalizarOrigen('HTTPS://Portal.CardioIB.com:443/x'), 'https://portal.cardioib.com');
console.log('ok  coincidencia de orígenes exacta y con comodín');

console.log('\nTodas las pruebas de dominios permitidos pasaron.');
