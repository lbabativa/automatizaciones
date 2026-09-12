import { Cliente, hashApiKey, type ClienteDoc } from '@startia/core';
import type { Context, Next } from 'hono';

export type Variables = { cliente: ClienteDoc };

// Límite por minuto en memoria. Suficiente para un proceso; con varias réplicas se pasa a Mongo o Redis.
const ventanas = new Map<string, { inicio: number; cuenta: number }>();

export async function autenticar(c: Context<{ Variables: Variables }>, next: Next) {
  const apiKey = c.req.header('x-api-key') ?? c.req.header('authorization')?.replace(/^Bearer\s+/i, '');
  if (!apiKey) return c.json({ error: 'FALTA_API_KEY', mensaje: 'Envíe la clave en el encabezado x-api-key' }, 401);

  const cliente = await Cliente.findOne({ apiKeyHash: hashApiKey(apiKey) }).lean<ClienteDoc>();
  if (!cliente) return c.json({ error: 'API_KEY_INVALIDA', mensaje: 'La clave no corresponde a ningún cliente' }, 401);
  if (!cliente.activo) return c.json({ error: 'CLIENTE_INACTIVO', mensaje: 'El cliente está desactivado' }, 403);

  const ahora = Date.now();
  const v = ventanas.get(cliente.slug);
  if (!v || ahora - v.inicio > 60_000) ventanas.set(cliente.slug, { inicio: ahora, cuenta: 1 });
  else if (++v.cuenta > (cliente.limitePorMinuto ?? 30)) {
    return c.json({ error: 'LIMITE_EXCEDIDO', mensaje: `Máximo ${cliente.limitePorMinuto} solicitudes por minuto` }, 429);
  }

  c.set('cliente', cliente);
  await next();
}
