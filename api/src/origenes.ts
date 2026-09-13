/**
 * Dominios permitidos por cliente (CORS) para la API pública /v1.
 *
 * Un patrón es un origen completo, sin ruta: `https://portal.cardioib.com`, o con
 * comodín de subdominios `https://*.cardioib.com` (no incluye el dominio raíz).
 * El preflight OPTIONS no trae la clave, así que se responde con la unión de los
 * dominios de todos los clientes; ya autenticada la clave, `autenticar` verifica
 * el origen contra la lista de ese cliente.
 */
import { Cliente } from '@startia/core';
import type { Context, Next } from 'hono';

/** "HTTPS://Portal.CardioIB.com:443/x" → "https://portal.cardioib.com"; null si no es http(s). */
export function normalizarOrigen(origen: string): string | null {
  try {
    const u = new URL(origen.trim());
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return `${u.protocol}//${u.host}`.toLowerCase();
  } catch {
    return null;
  }
}

/** Valida y normaliza un patrón escrito en la consola; null si no es un origen válido. */
export function validarPatron(patron: string): string | null {
  const s = patron.trim().toLowerCase().replace(/\/+$/, '');
  if (!/^https?:\/\/(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)*(:\d{1,5})?$/.test(s)) return null;
  return s.includes('*') ? s : normalizarOrigen(s);
}

export function origenPermitido(origen: string, patrones: string[]): boolean {
  const o = normalizarOrigen(origen);
  if (!o) return false;
  const u = new URL(o);
  return patrones.some((p) => {
    if (!p.includes('*')) return p === o;
    const [esquema, resto] = p.split('://');
    const [host, puerto = ''] = resto.slice(2).split(':');
    return u.protocol === `${esquema}:` && u.hostname.endsWith(`.${host}`) && u.port === puerto;
  });
}

// Unión de dominios de todos los clientes, para el preflight. Se refresca cada minuto
// y al guardar desde la consola (en esta instancia).
let cache: { patrones: string[]; hasta: number } | null = null;

export async function todosLosPatrones(): Promise<string[]> {
  if (cache && cache.hasta > Date.now()) return cache.patrones;
  const patrones = ((await Cliente.distinct('origenesPermitidos')) as unknown[]).filter((p): p is string => typeof p === 'string' && p !== '');
  cache = { patrones, hasta: Date.now() + 60_000 };
  return patrones;
}

export function olvidarPatrones(): void {
  cache = null;
}

const CABECERAS = 'x-api-key, authorization, content-type';

/** Middleware CORS de /v1: responde el preflight y agrega Access-Control-Allow-Origin a los dominios configurados. */
export async function cors(c: Context, next: Next) {
  const origen = c.req.header('origin');
  if (c.req.method === 'OPTIONS') {
    if (origen && origenPermitido(origen, await todosLosPatrones())) {
      return c.body(null, 204, {
        'access-control-allow-origin': origen,
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': CABECERAS,
        'access-control-max-age': '600',
        vary: 'Origin',
      });
    }
    return c.body(null, 403, { vary: 'Origin' });
  }
  await next();
  if (origen && origenPermitido(origen, await todosLosPatrones())) {
    c.res.headers.set('access-control-allow-origin', origen);
    c.res.headers.append('vary', 'Origin');
  }
}
