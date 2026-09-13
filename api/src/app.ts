import { buscarEnCache, buscarEnCurso, cancelarLote, conectarDb, crearLote, encolar, envNum, esperarResultado, Lote, Trabajo, type LoteDoc, type TrabajoDoc } from '@startia/core';
import { listarModulosDisponibles, resolverModulo } from '@startia/modulos';
import { Hono, type Context } from 'hono';
import { logger } from 'hono/logger';
import mongoose from 'mongoose';
import { z } from 'zod';
import { admin } from './admin.js';
import { autenticar, type Variables } from './auth.js';
import { cors } from './origenes.js';
import { respuestaResultado } from './exportar.js';
import { EntradaLote, fechaProgramada, presentarLote, validarFilas } from './lotes.js';

export const app = new Hono<{ Variables: Variables }>();
app.use(logger());

// En serverless (Vercel) cada invocación puede arrancar en frío: se asegura la
// conexión a Mongo en la primera petición. conectarDb cachea la promesa.
let dbLista: Promise<unknown> | null = null;
app.use('*', async (_c, next) => {
  if (mongoose.connection.readyState !== 1) {
    dbLista ??= conectarDb();
    await dbLista;
  }
  await next();
});

// Consola de operador (panel web + su API interna con ADMIN_KEY).
app.route('/admin', admin);

app.get('/', (c) => c.json({ servicio: 'startia-automatizaciones', version: '0.1.0', panel: '/admin' }));
// CORS de /v1 con los dominios permitidos de cada cliente (se configuran en la consola).
app.use('/v1/*', cors);
app.get('/v1/salud', async (c) => {
  const db = mongoose.connection.readyState === 1;
  const pendientes = db ? await Trabajo.countDocuments({ estado: 'pendiente' }) : null;
  return c.json({ ok: db, db, pendientes }, db ? 200 : 503);
});

app.use('/v1/*', autenticar);

/** Módulos habilitados para el cliente autenticado. */
app.get('/v1/modulos', async (c) => {
  const cliente = c.get('cliente');
  const habilitados = new Set(cliente.modulos.filter((m) => m.activo).map((m) => m.nombre));
  const modulos = (await listarModulosDisponibles()).filter((m) => habilitados.has(m.nombre));
  return c.json({ modulos: modulos.map(({ parametros: _p, origen: _o, ...m }) => m) });
});

app.get('/v1/trabajos/:id', async (c) => {
  const cliente = c.get('cliente');
  const id = c.req.param('id');
  if (!mongoose.isValidObjectId(id)) return c.json({ error: 'ID_INVALIDO' }, 400);
  const t = await Trabajo.findOne({ _id: id, clienteSlug: cliente.slug }).lean<TrabajoDoc>();
  if (!t) return c.json({ error: 'NO_ENCONTRADO' }, 404);
  return c.json(presentar(t));
});

const Reservados = z.object({
  modo: z.enum(['sync', 'async']).default('async'),
  callback_url: z.url().optional(),
  forzar: z.boolean().default(false),
  prioridad: z.number().int().min(0).max(10).default(0),
});

/**
 * Ejecuta un módulo. Los parámetros van en el cuerpo JSON (nunca en la URL: son datos personales).
 * Campos reservados: modo, callback_url, forzar, prioridad. El resto son parámetros del módulo.
 */
app.post('/v1/:portal/:modulo', async (c) => {
  const cliente = c.get('cliente');
  const nombre = c.req.param('modulo');
  const portal = c.req.param('portal');

  const modulo = await resolverModulo(nombre);
  if (!modulo || modulo.portal !== portal) return c.json({ error: 'MODULO_INEXISTENTE', mensaje: `No existe el módulo ${portal}/${nombre}` }, 404);
  const habilitado = cliente.modulos.find((m) => m.nombre === nombre && m.activo);
  if (!habilitado) return c.json({ error: 'MODULO_NO_CONTRATADO', mensaje: `El módulo ${nombre} no está habilitado para ${cliente.slug}` }, 403);

  let cuerpo: unknown;
  try {
    cuerpo = await c.req.json();
  } catch {
    return c.json({ error: 'JSON_INVALIDO', mensaje: 'El cuerpo debe ser JSON' }, 400);
  }
  const { modo, callback_url, forzar, prioridad, ...resto } = { ...(cuerpo as Record<string, unknown>) };
  const reservados = Reservados.safeParse({ modo, callback_url, forzar, prioridad });
  if (!reservados.success) return c.json({ error: 'PARAMETROS_INVALIDOS', detalles: z.treeifyError(reservados.error) }, 400);
  const parametros = modulo.parametros.safeParse(resto);
  if (!parametros.success) return c.json({ error: 'PARAMETROS_INVALIDOS', detalles: z.treeifyError(parametros.error) }, 400);
  const params = parametros.data as Record<string, unknown>;

  if (!reservados.data.forzar) {
    const cache = await buscarEnCache(cliente.slug, nombre, params, envNum('CACHE_HORAS', 12));
    if (cache) return c.json({ ...presentar(cache), desde_cache: true });
  }

  let trabajo = await buscarEnCurso(cliente.slug, nombre, params);
  if (!trabajo) {
    trabajo = await encolar({
      clienteSlug: cliente.slug,
      modulo: nombre,
      portal,
      parametros: params,
      modo: reservados.data.modo,
      callbackUrl: reservados.data.callback_url,
      prioridad: reservados.data.prioridad,
    });
  }

  if (reservados.data.modo === 'sync') {
    const listo = await esperarResultado(trabajo._id, envNum('SYNC_TIMEOUT_MS', 90_000));
    if (listo) return c.json(presentar(listo), listo.estado === 'completado' ? 200 : 422);
    const actual = await Trabajo.findById(trabajo._id).lean<TrabajoDoc>();
    return c.json({ ...presentar(actual ?? trabajo), mensaje: 'El robot sigue trabajando; consulte estado_url' }, 202);
  }
  return c.json(presentar(trabajo), 202);
});

// ---------------------------------------------------------------------------------
// Lotes: muchas consultas en una sola llamada
// ---------------------------------------------------------------------------------

/**
 * Crea un lote. Cuerpo: { items: [{ ...parámetros }], nombre?, forzar?, programar_para? }.
 * Si alguna fila no cumple los parámetros no se crea nada y se devuelve el motivo de cada una.
 */
app.post('/v1/:portal/:modulo/lote', async (c) => {
  const cliente = c.get('cliente');
  const portal = c.req.param('portal');
  const nombre = c.req.param('modulo');
  const modulo = await resolverModulo(nombre);
  if (!modulo || modulo.portal !== portal) return c.json({ error: 'MODULO_INEXISTENTE', mensaje: `No existe el módulo ${portal}/${nombre}` }, 404);
  if (!cliente.modulos.some((m) => m.nombre === nombre && m.activo)) {
    return c.json({ error: 'MODULO_NO_CONTRATADO', mensaje: `El módulo ${nombre} no está habilitado para ${cliente.slug}` }, 403);
  }
  let cuerpo: unknown;
  try {
    cuerpo = await c.req.json();
  } catch {
    return c.json({ error: 'JSON_INVALIDO', mensaje: 'El cuerpo debe ser JSON' }, 400);
  }
  const entrada = EntradaLote.safeParse(cuerpo);
  if (!entrada.success) return c.json({ error: 'LOTE_INVALIDO', detalles: z.treeifyError(entrada.error) }, 400);
  const { validos, errores } = validarFilas(modulo, entrada.data.items);
  if (errores.length) {
    return c.json({ error: 'ITEMS_INVALIDOS', mensaje: `${errores.length} fila(s) con parámetros inválidos; no se creó el lote`, detalles: errores.slice(0, 200) }, 400);
  }
  const lote = await crearLote({
    clienteSlug: cliente.slug,
    modulo: nombre,
    portal,
    items: validos,
    nombre: entrada.data.nombre,
    origen: 'api',
    forzar: entrada.data.forzar,
    programadoPara: fechaProgramada(entrada.data.programar_para),
    cacheHoras: envNum('CACHE_HORAS', 12),
  });
  const p = await presentarLote(lote);
  return c.json({ ...p, estado_url: `/v1/lotes/${p.id}`, resultado_url: `/v1/lotes/${p.id}/resultado?formato=xlsx` }, 202);
});

async function loteDelCliente(c: Context<{ Variables: Variables }>): Promise<LoteDoc | null> {
  const id = c.req.param('id');
  if (!id || !mongoose.isValidObjectId(id)) return null;
  return Lote.findOne({ _id: id, clienteSlug: c.get('cliente').slug }).lean<LoteDoc>();
}

/** Estado, contadores, tiempo estimado y filas (?desde=0&limite=100&estado=completado|fallido|activos). */
app.get('/v1/lotes/:id', async (c) => {
  const lote = await loteDelCliente(c);
  if (!lote) return c.json({ error: 'NO_ENCONTRADO' }, 404);
  return c.json(await presentarLote(lote, { desde: Number(c.req.query('desde') ?? 0), limite: Number(c.req.query('limite') ?? 100), estado: c.req.query('estado') }));
});

app.post('/v1/lotes/:id/cancelar', async (c) => {
  const lote = await loteDelCliente(c);
  if (!lote) return c.json({ error: 'NO_ENCONTRADO' }, 404);
  return c.json(await presentarLote((await cancelarLote(lote._id)) ?? lote));
});

/** Resultados en Excel (?formato=xlsx, por defecto) o CSV (?formato=csv). */
app.get('/v1/lotes/:id/resultado', async (c) => {
  const lote = await loteDelCliente(c);
  if (!lote) return c.json({ error: 'NO_ENCONTRADO' }, 404);
  return respuestaResultado(c, lote);
});

function presentar(t: TrabajoDoc) {
  return {
    id: String(t._id),
    estado: t.estado,
    modulo: t.modulo,
    parametros: t.parametros,
    resultado: t.resultado ?? null,
    error: t.error ?? null,
    capturas: t.capturas ?? [],
    intentos: t.intentos,
    creado_en: t.createdAt,
    terminado_en: t.terminadoEn ?? null,
    duracion_ms: t.duracionMs ?? null,
    estado_url: `/v1/trabajos/${String(t._id)}`,
  };
}
