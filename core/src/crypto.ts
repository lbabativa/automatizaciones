import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
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
