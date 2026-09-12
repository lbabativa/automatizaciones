/**
 * Consola de operador de StartIA. Sirve el panel web y una API interna protegida
 * con ADMIN_KEY (independiente de las claves por cliente). Permite ejecutar
 * consultas de cualquier cliente, ver su historial y capturas, y ajustar la
 * configuración de los módulos por cliente.
 */
import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { Cliente, encolar, env, esperarResultado, rutaProyecto, Sesion, Trabajo, type ClienteDoc, type TrabajoDoc } from '@startia/core';
import { listarModulos, obtenerModulo } from '@startia/modulos';
import { Hono } from 'hono';
import mongoose from 'mongoose';

export const admin = new Hono();

function claveOk(c: { req: { header: (n: string) => string | undefined; query: (n: string) => string | undefined } }): boolean {
  let esperada: string;
  try {
    esperada = env('ADMIN_KEY');
  } catch {
    return false; // sin ADMIN_KEY configurada, la consola queda cerrada
  }
  const dada = c.req.header('x-admin-key') ?? c.req.query('k');
  return Boolean(dada) && dada === esperada;
}

// El HTML del panel es público (no expone datos); las rutas de datos exigen la clave.
admin.get('/', async (c) => {
  try {
    const html = await readFile(rutaProyecto('api', 'public', 'panel.html'), 'utf8');
    return c.html(html);
  } catch {
    return c.text('No se encontró api/public/panel.html', 500);
  }
});

admin.use('/api/*', async (c, next) => {
  if (!claveOk(c)) return c.json({ error: 'ADMIN_KEY_INVALIDA', mensaje: 'Falta o no coincide x-admin-key' }, 401);
  await next();
});

admin.get('/api/estado', async (c) => {
  const db = mongoose.connection.readyState === 1;
  const [pendientes, enProceso] = db ? await Promise.all([Trabajo.countDocuments({ estado: 'pendiente' }), Trabajo.countDocuments({ estado: 'en_proceso' })]) : [0, 0];
  return c.json({ ok: db, pendientes, enProceso, modulos: listarModulos() });
});

admin.get('/api/clientes', async (c) => {
  const clientes = await Cliente.find().sort({ nombre: 1 }).lean<ClienteDoc[]>();
  const sesiones = await Sesion.find().lean<Array<{ clienteSlug: string; portal: string; valida: boolean; origen: string; updatedAt: Date }>>();
  const porCliente = (slug: string) => sesiones.filter((s) => s.clienteSlug === slug).map((s) => ({ portal: s.portal, valida: s.valida, origen: s.origen, actualizada: s.updatedAt }));
  return c.json({
    clientes: clientes.map((cl) => ({
      slug: cl.slug,
      nombre: cl.nombre,
      activo: cl.activo,
      apiKeyPrefijo: cl.apiKeyPrefijo,
      modulos: cl.modulos.map((m) => ({ nombre: m.nombre, activo: m.activo, config: m.config })),
      portales: Object.keys((cl.credenciales as Record<string, unknown>) ?? {}),
      sesiones: porCliente(cl.slug),
    })),
  });
});

// Ajusta la config de un módulo para un cliente (por ejemplo prestadorCodigo).
admin.put('/api/clientes/:slug/modulos/:modulo/config', async (c) => {
  const { slug, modulo } = c.req.param();
  let config: unknown;
  try {
    config = await c.req.json();
  } catch {
    return c.json({ error: 'JSON_INVALIDO' }, 400);
  }
  const cliente = await Cliente.findOne({ slug });
  if (!cliente) return c.json({ error: 'CLIENTE_NO_ENCONTRADO' }, 404);
  const m = (cliente.get('modulos') as Array<{ nombre: string }>).findIndex((x) => x.nombre === modulo);
  if (m < 0) return c.json({ error: 'MODULO_NO_HABILITADO' }, 404);
  cliente.set(`modulos.${m}.config`, config);
  cliente.markModified('modulos');
  await cliente.save();
  return c.json({ ok: true, config });
});

admin.get('/api/trabajos', async (c) => {
  const limite = Math.min(Number(c.req.query('limite') ?? 50), 200);
  const filtro: Record<string, unknown> = {};
  const slug = c.req.query('cliente');
  const estado = c.req.query('estado');
  if (slug) filtro.clienteSlug = slug;
  if (estado) filtro.estado = estado;
  const trabajos = await Trabajo.find(filtro).sort({ createdAt: -1 }).limit(limite).lean<TrabajoDoc[]>();
  return c.json({ trabajos: trabajos.map(resumen) });
});

admin.get('/api/trabajos/:id', async (c) => {
  const id = c.req.param('id');
  if (!mongoose.isValidObjectId(id)) return c.json({ error: 'ID_INVALIDO' }, 400);
  const t = await Trabajo.findById(id).lean<TrabajoDoc>();
  if (!t) return c.json({ error: 'NO_ENCONTRADO' }, 404);
  return c.json(detalle(t));
});

admin.post('/api/ejecutar', async (c) => {
  let cuerpo: { cliente?: string; modulo?: string; parametros?: Record<string, unknown>; modo?: 'sync' | 'async'; forzar?: boolean };
  try {
    cuerpo = await c.req.json();
  } catch {
    return c.json({ error: 'JSON_INVALIDO' }, 400);
  }
  const { cliente: slug, modulo: nombre, parametros = {}, modo = 'async' } = cuerpo;
  if (!slug || !nombre) return c.json({ error: 'FALTAN_CAMPOS', mensaje: 'Se requieren cliente y modulo' }, 400);

  const cliente = await Cliente.findOne({ slug }).lean<ClienteDoc>();
  if (!cliente) return c.json({ error: 'CLIENTE_NO_ENCONTRADO' }, 404);
  const modulo = obtenerModulo(nombre);
  if (!modulo) return c.json({ error: 'MODULO_INEXISTENTE' }, 404);
  if (!cliente.modulos.some((m) => m.nombre === nombre && m.activo)) return c.json({ error: 'MODULO_NO_HABILITADO' }, 403);

  const val = modulo.parametros.safeParse(parametros);
  if (!val.success) return c.json({ error: 'PARAMETROS_INVALIDOS', detalles: val.error.issues }, 400);

  const trabajo = await encolar({ clienteSlug: slug, modulo: nombre, portal: modulo.portal, parametros: val.data as Record<string, unknown>, modo });
  if (modo === 'sync') {
    const listo = await esperarResultado(trabajo._id, 120_000);
    return c.json(detalle(listo ?? trabajo), listo?.estado === 'completado' ? 200 : 202);
  }
  return c.json(detalle(trabajo), 202);
});

// Sirve una captura local (evidencias/ o inspeccion/) para verla en el panel.
admin.get('/api/captura', async (c) => {
  const ruta = c.req.query('ruta');
  if (!ruta) return c.json({ error: 'FALTA_RUTA' }, 400);
  const abs = resolve(ruta);
  const permitidas = [rutaProyecto('evidencias'), rutaProyecto('inspeccion')];
  if (!permitidas.some((base) => abs.startsWith(base))) return c.json({ error: 'RUTA_NO_PERMITIDA' }, 403);
  try {
    const datos = await readFile(abs);
    const tipo = extname(abs).toLowerCase() === '.png' ? 'image/png' : 'application/octet-stream';
    return c.body(datos, 200, { 'content-type': tipo, 'cache-control': 'no-store' });
  } catch {
    return c.json({ error: 'NO_ENCONTRADA' }, 404);
  }
});

function resumen(t: TrabajoDoc) {
  return {
    id: String(t._id),
    cliente: t.clienteSlug,
    modulo: t.modulo,
    estado: t.estado,
    parametros: t.parametros,
    semaforo: (t.resultado as { semaforo?: string } | null)?.semaforo ?? null,
    error: t.error?.codigo ?? null,
    creado: t.createdAt,
    terminado: t.terminadoEn ?? null,
    duracion_ms: t.duracionMs ?? null,
  };
}

function detalle(t: TrabajoDoc) {
  return {
    ...resumen(t),
    resultado: t.resultado ?? null,
    error_mensaje: t.error?.mensaje ?? null,
    intentos: t.intentos,
    // Cloudinary devuelve http(s); las locales se sirven por /admin/api/captura.
    capturas: (t.capturas ?? []).map((ruta) => (/^https?:\/\//.test(ruta) ? ruta : `/admin/api/captura?ruta=${encodeURIComponent(ruta)}`)),
  };
}
