import { createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, scryptSync, timingSafeEqual, type KeyObject } from 'node:crypto';
import { env } from './env.js';

function claveMaestra(): Buffer {
  const hex = env('MASTER_KEY');
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error('MASTER_KEY debe ser 32 bytes en hexadecimal (64 caracteres)');
  }
  return Buffer.from(hex, 'hex');
}

/** Cifra texto con AES-256-GCM. Devuelve iv.tag.datos en base64. */
export function cifrar(texto: string): string {
  const iv = randomBytes(12);
  const cifrador = createCipheriv('aes-256-gcm', claveMaestra(), iv);
  const datos = Buffer.concat([cifrador.update(texto, 'utf8'), cifrador.final()]);
  const tag = cifrador.getAuthTag();
  return [iv, tag, datos].map((b) => b.toString('base64')).join('.');
}

export function descifrar(payload: string): string {
  if (esPayloadV2(payload)) return descifrarV2(payload);
  const partes = payload.split('.');
  if (partes.length !== 3) throw new Error('Payload cifrado con formato inválido');
  const [iv, tag, datos] = partes.map((p) => Buffer.from(p, 'base64'));
  const descifrador = createDecipheriv('aes-256-gcm', claveMaestra(), iv);
  descifrador.setAuthTag(tag);
  return Buffer.concat([descifrador.update(datos), descifrador.final()]).toString('utf8');
}

export function hashApiKey(apiKey: string): string {
  return createHash('sha256').update(apiKey).digest('hex');
}

/** Genera una clave de API. El prefijo permite identificar al cliente en logs sin exponer la clave. */
export function generarApiKey(slugCliente: string): { apiKey: string; prefijo: string } {
  const prefijo = `rpa_${slugCliente}_`;
  return { apiKey: prefijo + randomBytes(24).toString('base64url'), prefijo };
}

/** Huella estable de (cliente, módulo, parámetros) para caché e idempotencia. */
export function huellaTrabajo(clienteSlug: string, modulo: string, parametros: Record<string, unknown>): string {
  const ordenado = Object.keys(parametros)
    .sort()
    .reduce<Record<string, unknown>>((acc, k) => ((acc[k] = parametros[k]), acc), {});
  return createHash('sha256').update(`${clienteSlug}|${modulo}|${JSON.stringify(ordenado)}`).digest('hex');
}

/** Hash de contraseña con scrypt y sal aleatoria. Formato: scrypt$<sal>$<hash> en base64url. */
export function hashPassword(password: string): string {
  const sal = randomBytes(16);
  const hash = scryptSync(password, sal, 32);
  return `scrypt$${sal.toString('base64url')}$${hash.toString('base64url')}`;
}

/** Compara en tiempo constante una contraseña con un hash generado por hashPassword. */
export function verificarPassword(password: string, almacenado: string): boolean {
  const partes = almacenado.split('$');
  if (partes.length !== 3 || partes[0] !== 'scrypt') return false;
  const sal = Buffer.from(partes[1], 'base64url');
  const esperado = Buffer.from(partes[2], 'base64url');
  const calculado = scryptSync(password, sal, esperado.length);
  return calculado.length === esperado.length && timingSafeEqual(calculado, esperado);
}

// ---------------------------------------------------------------------------------
// Cifrado asimétrico: la consola (sin MASTER_KEY) cifra con la clave pública del
// worker; solo quien tiene MASTER_KEY deriva la privada y descifra.
// ---------------------------------------------------------------------------------

const PKCS8_X25519 = Buffer.from('302e020100300506032b656e04220420', 'hex');
const PREFIJO_V2 = 'v2.';

/** Clave privada X25519 derivada de MASTER_KEY (determinista: la misma llave da el mismo par). */
function clavePrivadaWorker(): KeyObject {
  const semilla = hkdfSync('sha256', claveMaestra(), 'startia-automatizaciones', 'x25519-credenciales', 32);
  return createPrivateKey({ key: Buffer.concat([PKCS8_X25519, Buffer.from(semilla)]), format: 'der', type: 'pkcs8' });
}

/** Clave pública (SPKI en base64) que el worker publica para que la consola cifre credenciales. */
export function clavePublicaWorker(): string {
  return createPublicKey(clavePrivadaWorker()).export({ type: 'spki', format: 'der' }).toString('base64');
}

/**
 * Cifra texto para el worker con su clave pública: X25519 efímero + HKDF + AES-256-GCM.
 * Formato: v2.<pubEfimera>.<iv>.<tag>.<datos> en base64.
 */
export function cifrarConClavePublica(texto: string, clavePublicaB64: string): string {
  const publica = createPublicKey({ key: Buffer.from(clavePublicaB64, 'base64'), format: 'der', type: 'spki' });
  const efimero = generateKeyPairSync('x25519');
  const compartido = diffieHellman({ privateKey: efimero.privateKey, publicKey: publica });
  const clave = Buffer.from(hkdfSync('sha256', compartido, 'startia-automatizaciones', 'credenciales-v2', 32));
  const iv = randomBytes(12);
  const cifrador = createCipheriv('aes-256-gcm', clave, iv);
  const datos = Buffer.concat([cifrador.update(texto, 'utf8'), cifrador.final()]);
  const pubEfimera = efimero.publicKey.export({ type: 'spki', format: 'der' });
  return PREFIJO_V2 + [pubEfimera, iv, cifrador.getAuthTag(), datos].map((b) => b.toString('base64')).join('.');
}

function descifrarV2(payload: string): string {
  const partes = payload.slice(PREFIJO_V2.length).split('.');
  if (partes.length !== 4) throw new Error('Payload v2 con formato inválido');
  const [pubEfimera, iv, tag, datos] = partes.map((p) => Buffer.from(p, 'base64'));
  const compartido = diffieHellman({ privateKey: clavePrivadaWorker(), publicKey: createPublicKey({ key: pubEfimera, format: 'der', type: 'spki' }) });
  const clave = Buffer.from(hkdfSync('sha256', compartido, 'startia-automatizaciones', 'credenciales-v2', 32));
  const descifrador = createDecipheriv('aes-256-gcm', clave, iv);
  descifrador.setAuthTag(tag);
  return Buffer.concat([descifrador.update(datos), descifrador.final()]).toString('utf8');
}

/** Cifrado con clave pública ("v2.") o simétrico clásico. */
export function esPayloadV2(payload: string): boolean {
  return payload.startsWith(PREFIJO_V2);
}
