/**
 * Consola de operador de StartIA. Sirve el panel web y una API interna que
 * permite ejecutar consultas de cualquier cliente, ver su historial y capturas,
 * y ajustar la configuración de los módulos por cliente.
 *
 * Acceso: un único operador definido por ADMIN_USER y ADMIN_PASSWORD_HASH
 * (ver core/scripts/admin-password.ts). Al entrar se emite una cookie firmada
 * con HMAC usando ADMIN_KEY como secreto. ADMIN_KEY también sirve como clave
 * directa en el encabezado x-admin-key para integraciones o pruebas con curl.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  cifrarConClavePublica,
  Cliente,
  Configuracion,
  encolar,
  generarApiKey,
  hashApiKey,
  env,
  esperarResultado,
  esquemaParametros,
  Flujo,
  FlujoDefSchema,
  Grabacion,
  Inspeccion,
  rutaProyecto,
  Sesion,
  Trabajo,
  verificarPassword,
  type ClienteDoc,
  type FlujoDef,
  type FlujoDoc,
  type GrabacionDoc,
  type InspeccionDoc,
  type TrabajoDoc,
} from '@startia/core';
import { listarModulosDisponibles, registro, resolverModulo } from '@startia/modulos';
import { z } from 'zod';
import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import mongoose from 'mongoose';

export const admin = new Hono();

const COOKIE = 'startia_sesion';
const SESION_HORAS = 12;

function secreto(): string | null {
  try {
    return env('ADMIN_KEY');
  } catch {
    return null; // sin ADMIN_KEY configurada, la consola queda cerrada
  }
}

function iguales(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

function firmar(datos: string, clave: string): string {
  return createHmac('sha256', clave).update(datos).digest('base64url');
}

/** Token de sesión: base64url({ u, exp }) + "." + HMAC. */
function emitirSesion(usuario: string, clave: string): string {
  const datos = Buffer.from(JSON.stringify({ u: usuario, exp: Date.now() + SESION_HORAS * 3600_000 })).toString('base64url');
  return `${datos}.${firmar(datos, clave)}`;
}

function leerSesion(token: string | undefined, clave: string): string | null {
  if (!token) return null;
  const [datos, firma] = token.split('.');
  if (!datos || !firma || !iguales(firma, firmar(datos, clave))) return null;
  try {
    const { u, exp } = JSON.parse(Buffer.from(datos, 'base64url').toString('utf8')) as { u: string; exp: number };
    return typeof u === 'string' && typeof exp === 'number' && exp > Date.now() ? u : null;
  } catch {
    return null;
  }
}

/** Usuario autenticado: por cookie de sesión, o por ADMIN_KEY directa (encabezado o ?k=). */
function usuarioActual(c: Context): string | null {
  const clave = secreto();
  if (!clave) return null;
  const directa = c.req.header('x-admin-key') ?? c.req.query('k');
  if (directa && iguales(directa, clave)) return 'admin-key';
  return leerSesion(getCookie(c, COOKIE), clave);
}

function esHttps(c: Context): boolean {
  return c.req.header('x-forwarded-proto') === 'https' || c.req.url.startsWith('https://');
}

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

// El HTML de las páginas es público (no expone datos); las rutas de datos exigen sesión.
// Se busca junto al código (serverless) y desde la raíz del proyecto (local).
async function leerPagina(archivo: string): Promise<string | null> {
  const aquí = fileURLToPath(new URL('.', import.meta.url));
  const candidatos = [resolve(aquí, '..', 'public', archivo), resolve(aquí, 'public', archivo), rutaProyecto('api', 'public', archivo)];
  for (const ruta of candidatos) {
    try {
      return await readFile(ruta, 'utf8');
    } catch {
      /* siguiente candidato */
    }
  }
  return null;
}
admin.get('/', async (c) => {
  const html = await leerPagina('panel.html');
  return html ? c.html(html) : c.text('No se encontró api/public/panel.html', 500);
});
admin.get('/flujos', async (c) => {
  const html = await leerPagina('flujos.html');
  return html ? c.html(html) : c.text('No se encontró api/public/flujos.html', 500);
});
admin.get('/clientes', async (c) => {
  const html = await leerPagina('clientes.html');
  return html ? c.html(html) : c.text('No se encontró api/public/clientes.html', 500);
});

// Inicio de sesión del operador. Responde igual de lento si falla, para no dar pistas.
admin.post('/api/login', async (c) => {
  let cuerpo: { usuario?: string; password?: string };
  try {
    cuerpo = await c.req.json();
  } catch {
    return c.json({ error: 'JSON_INVALIDO' }, 400);
  }
  const clave = secreto();
  let usuarioEsperado: string;
  let hash: string;
  try {
    usuarioEsperado = env('ADMIN_USER');
    hash = env('ADMIN_PASSWORD_HASH');
  } catch {
    return c.json({ error: 'SIN_CONFIGURAR', mensaje: 'Faltan ADMIN_USER o ADMIN_PASSWORD_HASH en el servidor' }, 503);
  }
  const usuario = String(cuerpo.usuario ?? '').trim().toLowerCase();
  const password = String(cuerpo.password ?? '');
  const ok = Boolean(clave) && usuario !== '' && iguales(usuario, usuarioEsperado.trim().toLowerCase()) && verificarPassword(password, hash);
  if (!ok || !clave) {
    await dormir(600);
    return c.json({ error: 'CREDENCIALES_INVALIDAS', mensaje: 'Usuario o contraseña incorrectos' }, 401);
  }
  setCookie(c, COOKIE, emitirSesion(usuario, clave), {
    httpOnly: true,
    sameSite: 'Lax',
    secure: esHttps(c),
    path: '/admin',
    maxAge: SESION_HORAS * 3600,
  });
  return c.json({ ok: true, usuario });
});

admin.post('/api/logout', (c) => {
  deleteCookie(c, COOKIE, { path: '/admin' });
  return c.json({ ok: true });
});

admin.use('/api/*', async (c, next) => {
  const usuario = usuarioActual(c);
  if (!usuario) return c.json({ error: 'NO_AUTENTICADO', mensaje: 'Inicie sesión en la consola' }, 401);
  c.set('usuario' as never, usuario as never);
  await next();
});

admin.get('/api/yo', (c) => c.json({ usuario: usuarioActual(c) }));

admin.get('/api/estado', async (c) => {
  const db = mongoose.connection.readyState === 1;
  const [pendientes, enProceso] = db ? await Promise.all([Trabajo.countDocuments({ estado: 'pendiente' }), Trabajo.countDocuments({ estado: 'en_proceso' })]) : [0, 0];
  return c.json({ ok: db, pendientes, enProceso, modulos: db ? await listarModulosDisponibles() : [] });
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
      nit: cl.nit ?? null,
      modulos: cl.modulos.map((m) => ({ nombre: m.nombre, activo: m.activo, config: m.config })),
      portales: Object.keys((cl.credenciales as Record<string, unknown>) ?? {}),
      /** Solo los nombres de los campos guardados por portal, nunca los valores. */
      credenciales: Object.fromEntries(Object.entries((cl.credenciales as Record<string, Record<string, string>>) ?? {}).map(([p, campos]) => [p, Object.keys(campos ?? {})])),
      sesiones: porCliente(cl.slug),
    })),
  });
});

// ---------------------------------------------------------------------------------
// Gestión de clientes: alta, clave de API, credenciales por portal (cifradas con la
// clave pública del worker: la consola nunca puede leerlas).
// ---------------------------------------------------------------------------------

async function clavePublica(): Promise<string | null> {
  const doc = await Configuracion.findOne({ clave: 'clavePublica' }).lean<{ valor?: string }>();
  return typeof doc?.valor === 'string' ? doc.valor : null;
}

/** Portales conocidos con los campos de credenciales que piden sus módulos o flujos. */
admin.get('/api/portales', async (c) => {
  const portales = new Map<string, Set<string>>();
  for (const m of Object.values(registro)) {
    const s = portales.get(m.portal) ?? new Set<string>();
    m.credencialesRequeridas.forEach((x) => s.add(x));
    portales.set(m.portal, s);
  }
  const flujos = await Flujo.find().lean<FlujoDoc[]>();
  for (const f of flujos) {
    const def = (f.borrador ?? f.definicion) as FlujoDef | null;
    if (!def?.portal) continue;
    const s = portales.get(def.portal) ?? new Set<string>();
    (def.credenciales_requeridas ?? []).forEach((x) => s.add(x));
    portales.set(def.portal, s);
  }
  const clientes = await Cliente.find().select('credenciales').lean<ClienteDoc[]>();
  for (const cl of clientes) for (const p of Object.keys((cl.credenciales as Record<string, unknown>) ?? {})) if (!portales.has(p)) portales.set(p, new Set());
  return c.json({ portales: [...portales.entries()].map(([portal, campos]) => ({ portal, campos: [...campos] })).sort((a, b) => a.portal.localeCompare(b.portal)), clavePublica: Boolean(await clavePublica()) });
});

admin.post('/api/clientes', async (c) => {
  let cuerpo: { slug?: string; nombre?: string; nit?: string };
  try {
    cuerpo = await c.req.json();
  } catch {
    return c.json({ error: 'JSON_INVALIDO' }, 400);
  }
  const slug = String(cuerpo.slug ?? '').trim().toLowerCase();
  const nombre = String(cuerpo.nombre ?? '').trim();
  if (!/^[a-z][a-z0-9-]{1,40}$/.test(slug)) return c.json({ error: 'SLUG_INVALIDO', mensaje: 'El identificador va en minúsculas, números y guiones' }, 400);
  if (!nombre) return c.json({ error: 'FALTA_NOMBRE' }, 400);
  if (await Cliente.exists({ slug })) return c.json({ error: 'YA_EXISTE', mensaje: `Ya existe el cliente ${slug}` }, 409);
  const { apiKey, prefijo } = generarApiKey(slug);
  await Cliente.create({ slug, nombre, nit: cuerpo.nit || undefined, apiKeyHash: hashApiKey(apiKey), apiKeyPrefijo: prefijo, modulos: [], credenciales: {} });
  return c.json({ ok: true, slug, apiKey }, 201);
});

admin.put('/api/clientes/:slug', async (c) => {
  const slug = c.req.param('slug');
  let cuerpo: { nombre?: string; nit?: string; activo?: boolean };
  try {
    cuerpo = await c.req.json();
  } catch {
    return c.json({ error: 'JSON_INVALIDO' }, 400);
  }
  const cambios: Record<string, unknown> = {};
  if (typeof cuerpo.nombre === 'string' && cuerpo.nombre.trim()) cambios.nombre = cuerpo.nombre.trim();
  if (typeof cuerpo.nit === 'string') cambios.nit = cuerpo.nit.trim() || undefined;
  if (typeof cuerpo.activo === 'boolean') cambios.activo = cuerpo.activo;
  const r = await Cliente.updateOne({ slug }, { $set: cambios });
  if (!r.matchedCount) return c.json({ error: 'CLIENTE_NO_ENCONTRADO' }, 404);
  return c.json({ ok: true });
});

/** Genera una clave de API nueva; la anterior deja de servir. Se muestra una sola vez. */
admin.post('/api/clientes/:slug/rotar-clave', async (c) => {
  const slug = c.req.param('slug');
  const { apiKey, prefijo } = generarApiKey(slug);
  const r = await Cliente.updateOne({ slug }, { $set: { apiKeyHash: hashApiKey(apiKey), apiKeyPrefijo: prefijo } });
  if (!r.matchedCount) return c.json({ error: 'CLIENTE_NO_ENCONTRADO' }, 404);
  return c.json({ ok: true, apiKey });
});

/** Guarda las credenciales de un portal para un cliente. Los campos vacíos conservan el valor anterior. */
admin.put('/api/clientes/:slug/credenciales/:portal', async (c) => {
  const { slug, portal } = c.req.param();
  let campos: Record<string, unknown>;
  try {
    campos = await c.req.json();
  } catch {
    return c.json({ error: 'JSON_INVALIDO' }, 400);
  }
  if (!/^[a-z][a-z0-9-]*$/.test(portal)) return c.json({ error: 'PORTAL_INVALIDO' }, 400);
  const publica = await clavePublica();
  if (!publica) return c.json({ error: 'SIN_CLAVE_PUBLICA', mensaje: 'Ningún worker ha publicado su clave todavía. Arranque el worker una vez (con la MASTER_KEY) y vuelva a intentar.' }, 503);
  const cliente = await Cliente.findOne({ slug });
  if (!cliente) return c.json({ error: 'CLIENTE_NO_ENCONTRADO' }, 404);
  const actuales = ((cliente.get('credenciales') as Record<string, Record<string, string>>) ?? {})[portal] ?? {};
  const nuevas: Record<string, string> = { ...actuales };
  for (const [k, v] of Object.entries(campos)) {
    if (!/^[a-z][a-z0-9_]*$/i.test(k)) continue;
    if (v === null) delete nuevas[k];
    else if (typeof v === 'string' && v !== '') nuevas[k] = cifrarConClavePublica(v, publica);
  }
  cliente.set(`credenciales.${portal}`, nuevas);
  cliente.markModified('credenciales');
  await cliente.save();
  // Al cambiar credenciales, la sesión guardada del portal deja de ser fiable.
  await Sesion.updateOne({ clienteSlug: slug, portal }, { $set: { valida: false } });
  return c.json({ ok: true, campos: Object.keys(nuevas) });
});

admin.delete('/api/clientes/:slug/credenciales/:portal', async (c) => {
  const { slug, portal } = c.req.param();
  const cliente = await Cliente.findOne({ slug });
  if (!cliente) return c.json({ error: 'CLIENTE_NO_ENCONTRADO' }, 404);
  const creds = { ...((cliente.get('credenciales') as Record<string, unknown>) ?? {}) };
  delete creds[portal];
  cliente.set('credenciales', creds);
  cliente.markModified('credenciales');
  await cliente.save();
  return c.json({ ok: true });
});

admin.delete('/api/clientes/:slug', async (c) => {
  const slug = c.req.param('slug');
  const enCurso = await Trabajo.countDocuments({ clienteSlug: slug, estado: { $in: ['pendiente', 'en_proceso'] } });
  if (enCurso) return c.json({ error: 'CON_TRABAJOS', mensaje: 'El cliente tiene consultas en cola o en curso' }, 409);
  const r = await Cliente.deleteOne({ slug });
  if (!r.deletedCount) return c.json({ error: 'CLIENTE_NO_ENCONTRADO' }, 404);
  await Sesion.deleteMany({ clienteSlug: slug });
  return c.json({ ok: true });
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
  const modulo = c.req.query('modulo');
  const prueba = c.req.query('prueba');
  if (slug) filtro.clienteSlug = slug;
  if (estado) filtro.estado = estado;
  if (modulo) filtro.modulo = modulo;
  if (prueba === '1') filtro.prueba = { $exists: true };
  if (prueba === '0') filtro.prueba = { $exists: false };
  const trabajos = await Trabajo.find(filtro).sort({ createdAt: -1 }).limit(limite).lean<TrabajoDoc[]>();
  return c.json({ trabajos: trabajos.map(resumen) });
});

/** Inspecciones (elementos por captura) de un trabajo de prueba, sin los elementos. */
admin.get('/api/trabajos/:id/inspecciones', async (c) => {
  const id = c.req.param('id');
  if (!mongoose.isValidObjectId(id)) return c.json({ error: 'ID_INVALIDO' }, 400);
  const lista = await Inspeccion.find({ trabajoId: id }).select('captura url ancho alto elementos').lean<InspeccionDoc[]>();
  return c.json({ inspecciones: lista.map((i) => ({ captura: i.captura, url: i.url, ancho: i.ancho, alto: i.alto, elementos: i.elementos.length })) });
});

admin.get('/api/trabajos/:id/inspecciones/:captura', async (c) => {
  const { id, captura } = c.req.param();
  if (!mongoose.isValidObjectId(id)) return c.json({ error: 'ID_INVALIDO' }, 400);
  const i = await Inspeccion.findOne({ trabajoId: id, captura }).lean<InspeccionDoc>();
  if (!i) return c.json({ error: 'NO_ENCONTRADA' }, 404);
  return c.json({ captura: i.captura, url: i.url, ancho: i.ancho, alto: i.alto, elementos: i.elementos });
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
  const modulo = await resolverModulo(nombre);
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

// ---------------------------------------------------------------------------------
// Flujos declarativos: editor de la consola
// ---------------------------------------------------------------------------------

function resumenFlujo(f: FlujoDoc) {
  const def = (f.borrador ?? f.definicion) as FlujoDef | null;
  return {
    nombre: f.nombre,
    titulo: def?.titulo ?? f.nombre,
    portal: def?.portal ?? null,
    sector: def?.sector ?? null,
    estado: f.estado,
    version: f.version,
    pasos: def?.pasos.length ?? 0,
    tieneBorrador: Boolean(f.borrador),
    publicadoEn: f.publicadoEn ?? null,
    actualizado: f.updatedAt,
  };
}

admin.get('/api/flujos', async (c) => {
  const flujos = await Flujo.find().sort({ nombre: 1 }).lean<FlujoDoc[]>();
  const clientes = await Cliente.find().select('slug nombre modulos').lean<ClienteDoc[]>();
  const habilitadoEn = (nombre: string) => clientes.filter((cl) => cl.modulos.some((m) => m.nombre === nombre && m.activo)).map((cl) => cl.slug);
  return c.json({
    flujos: flujos.map((f) => ({ ...resumenFlujo(f), clientes: habilitadoEn(f.nombre) })),
    tiposPaso: ['ir', 'clic', 'escribir', 'seleccionar', 'presionar', 'esperar', 'leer', 'leer_lista', 'leer_tabla', 'leer_lineas', 'capturar', 'asignar', 'agregar', 'buscar', 'transformar', 'elegir', 'decidir', 'si', 'para_cada', 'error', 'fin'],
    modulosEnCodigo: Object.keys(registro),
  });
});

admin.get('/api/flujos/:nombre', async (c) => {
  const f = await Flujo.findOne({ nombre: c.req.param('nombre') }).lean<FlujoDoc>();
  if (!f) return c.json({ error: 'NO_ENCONTRADO' }, 404);
  const clientes = await Cliente.find().select('slug nombre modulos').lean<ClienteDoc[]>();
  return c.json({
    ...resumenFlujo(f),
    definicion: f.definicion ?? null,
    borrador: f.borrador ?? null,
    clientes: clientes.map((cl) => ({ slug: cl.slug, nombre: cl.nombre, habilitado: cl.modulos.some((m) => m.nombre === f.nombre && m.activo) })),
  });
});

/** Guarda el borrador. Valida la definición y devuelve los errores legibles si no cumple el esquema. */
admin.put('/api/flujos/:nombre', async (c) => {
  const nombre = c.req.param('nombre');
  let cuerpo: unknown;
  try {
    cuerpo = await c.req.json();
  } catch {
    return c.json({ error: 'JSON_INVALIDO' }, 400);
  }
  const val = FlujoDefSchema.safeParse(cuerpo);
  if (!val.success) return c.json({ error: 'FLUJO_INVALIDO', mensaje: z.prettifyError(val.error), detalles: val.error.issues }, 400);
  if (val.data.nombre !== nombre) return c.json({ error: 'NOMBRE_DISTINTO', mensaje: 'El nombre del flujo no coincide con la URL' }, 400);
  if (registro[nombre]) return c.json({ error: 'NOMBRE_RESERVADO', mensaje: `Ya existe un módulo en código llamado ${nombre}` }, 409);
  await Flujo.updateOne({ nombre }, { $set: { borrador: val.data }, $setOnInsert: { estado: 'borrador', version: 0 } }, { upsert: true });
  const f = await Flujo.findOne({ nombre }).lean<FlujoDoc>();
  return c.json({ ok: true, ...resumenFlujo(f as FlujoDoc) });
});

/** Publica el borrador: pasa a ser la definición que ejecutan API y worker. */
admin.post('/api/flujos/:nombre/publicar', async (c) => {
  const nombre = c.req.param('nombre');
  const f = await Flujo.findOne({ nombre }).lean<FlujoDoc>();
  if (!f) return c.json({ error: 'NO_ENCONTRADO' }, 404);
  const def = (f.borrador ?? f.definicion) as FlujoDef | null;
  if (!def) return c.json({ error: 'SIN_DEFINICION', mensaje: 'No hay nada que publicar' }, 400);
  const val = FlujoDefSchema.safeParse(def);
  if (!val.success) return c.json({ error: 'FLUJO_INVALIDO', mensaje: z.prettifyError(val.error) }, 400);
  const version = (f.version ?? 0) + 1;
  const ahora = new Date();
  await Flujo.updateOne(
    { nombre },
    {
      $set: { estado: 'publicado', version, definicion: val.data, borrador: null, publicadoEn: ahora },
      $push: { versiones: { $each: [{ version, definicion: val.data, publicadoEn: ahora }], $slice: -30 } },
    },
  );
  return c.json({ ok: true, version });
});

/** Historial de versiones publicadas (sin las definiciones completas). */
admin.get('/api/flujos/:nombre/versiones', async (c) => {
  const f = await Flujo.findOne({ nombre: c.req.param('nombre') }).lean<FlujoDoc>();
  if (!f) return c.json({ error: 'NO_ENCONTRADO' }, 404);
  const versiones = (f.versiones ?? []) as Array<{ version: number; definicion: FlujoDef; publicadoEn: Date }>;
  return c.json({
    actual: f.version,
    versiones: versiones
      .slice()
      .reverse()
      .map((v) => ({ version: v.version, publicadoEn: v.publicadoEn, pasos: v.definicion?.pasos?.length ?? 0, parametros: v.definicion?.parametros?.length ?? 0, titulo: v.definicion?.titulo })),
  });
});

admin.get('/api/flujos/:nombre/versiones/:v', async (c) => {
  const f = await Flujo.findOne({ nombre: c.req.param('nombre') }).lean<FlujoDoc>();
  if (!f) return c.json({ error: 'NO_ENCONTRADO' }, 404);
  const v = Number(c.req.param('v'));
  const encontrada = ((f.versiones ?? []) as Array<{ version: number; definicion: FlujoDef; publicadoEn: Date }>).find((x) => x.version === v);
  if (!encontrada) return c.json({ error: 'VERSION_NO_ENCONTRADA' }, 404);
  return c.json(encontrada);
});

/** Copia una versión anterior al borrador; publicar después la convierte en la versión vigente. */
admin.post('/api/flujos/:nombre/versiones/:v/restaurar', async (c) => {
  const nombre = c.req.param('nombre');
  const f = await Flujo.findOne({ nombre }).lean<FlujoDoc>();
  if (!f) return c.json({ error: 'NO_ENCONTRADO' }, 404);
  const v = Number(c.req.param('v'));
  const encontrada = ((f.versiones ?? []) as Array<{ version: number; definicion: FlujoDef }>).find((x) => x.version === v);
  if (!encontrada) return c.json({ error: 'VERSION_NO_ENCONTRADA' }, 404);
  await Flujo.updateOne({ nombre }, { $set: { borrador: encontrada.definicion } });
  return c.json({ ok: true, version: v });
});

/** Descarta el borrador y vuelve a la versión publicada. */
admin.post('/api/flujos/:nombre/descartar', async (c) => {
  const nombre = c.req.param('nombre');
  const f = await Flujo.findOne({ nombre }).lean<FlujoDoc>();
  if (!f) return c.json({ error: 'NO_ENCONTRADO' }, 404);
  if (!f.definicion) {
    await Flujo.deleteOne({ nombre });
    return c.json({ ok: true, eliminado: true });
  }
  await Flujo.updateOne({ nombre }, { $set: { borrador: null } });
  return c.json({ ok: true });
});

admin.delete('/api/flujos/:nombre', async (c) => {
  const nombre = c.req.param('nombre');
  const enUso = await Cliente.countDocuments({ modulos: { $elemMatch: { nombre, activo: true } } });
  if (enUso) return c.json({ error: 'EN_USO', mensaje: `El flujo está habilitado en ${enUso} cliente(s); deshabilítelo primero` }, 409);
  const r = await Flujo.deleteOne({ nombre });
  return c.json({ ok: r.deletedCount === 1 });
});

/**
 * Prueba el borrador con un cliente real: encola un trabajo marcado como prueba. El worker
 * usa la definición en borrador, captura después de cada paso y escribe la bitácora en vivo.
 */
admin.post('/api/flujos/:nombre/probar', async (c) => {
  const nombre = c.req.param('nombre');
  let cuerpo: { cliente?: string; parametros?: Record<string, unknown>; origen?: 'borrador' | 'publicado' };
  try {
    cuerpo = await c.req.json();
  } catch {
    return c.json({ error: 'JSON_INVALIDO' }, 400);
  }
  const f = await Flujo.findOne({ nombre }).lean<FlujoDoc>();
  if (!f) return c.json({ error: 'NO_ENCONTRADO' }, 404);
  const origen = cuerpo.origen ?? 'borrador';
  const def = (origen === 'borrador' ? (f.borrador ?? f.definicion) : f.definicion) as FlujoDef | null;
  if (!def) return c.json({ error: 'SIN_DEFINICION', mensaje: 'Guarde el flujo antes de probarlo' }, 400);
  if (!cuerpo.cliente) return c.json({ error: 'FALTA_CLIENTE', mensaje: 'Elija el cliente con cuya sesión se hará la prueba' }, 400);
  const cliente = await Cliente.findOne({ slug: cuerpo.cliente }).lean<ClienteDoc>();
  if (!cliente) return c.json({ error: 'CLIENTE_NO_ENCONTRADO' }, 404);
  const val = esquemaParametros(def.parametros).safeParse(cuerpo.parametros ?? {});
  if (!val.success) return c.json({ error: 'PARAMETROS_INVALIDOS', detalles: val.error.issues }, 400);
  const trabajo = await encolar({
    clienteSlug: cliente.slug,
    modulo: nombre,
    portal: def.portal,
    parametros: val.data as Record<string, unknown>,
    modo: 'async',
    prioridad: 10,
    prueba: { origen, capturarCadaPaso: true },
  });
  return c.json(detalle(trabajo), 202);
});

// ---------------------------------------------------------------------------------
// Grabador de acciones
// ---------------------------------------------------------------------------------

const presentarGrabacion = (g: GrabacionDoc) => ({
  id: String(g._id),
  flujo: g.flujoNombre ?? null,
  cliente: g.clienteSlug,
  portal: g.portal,
  url: g.urlInicio,
  estado: g.estado,
  detener: g.detener,
  worker: g.workerId ?? null,
  pasos: g.pasos ?? [],
  error: g.error ?? null,
  creada: g.createdAt,
  iniciada: g.iniciadaEn ?? null,
  terminada: g.terminadaEn ?? null,
});

/** Solicita una grabación; la toma el primer worker con ventana visible. */
admin.post('/api/grabaciones', async (c) => {
  let cuerpo: { flujo?: string; cliente?: string; portal?: string; url?: string; parametros?: Record<string, unknown> };
  try {
    cuerpo = await c.req.json();
  } catch {
    return c.json({ error: 'JSON_INVALIDO' }, 400);
  }
  if (!cuerpo.cliente) return c.json({ error: 'FALTA_CLIENTE', mensaje: 'Elija el cliente con cuya sesión se grabará' }, 400);
  const cliente = await Cliente.findOne({ slug: cuerpo.cliente }).lean<ClienteDoc>();
  if (!cliente) return c.json({ error: 'CLIENTE_NO_ENCONTRADO' }, 404);
  const flujo = cuerpo.flujo ? await Flujo.findOne({ nombre: cuerpo.flujo }).lean<FlujoDoc>() : null;
  const def = (flujo?.borrador ?? flujo?.definicion ?? null) as FlujoDef | null;
  const portal = cuerpo.portal ?? def?.portal;
  const url = cuerpo.url ?? def?.url_inicio;
  if (!portal || !url) return c.json({ error: 'FALTAN_DATOS', mensaje: 'Se requieren portal y URL de inicio (o un flujo guardado que los tenga)' }, 400);
  const pendiente = await Grabacion.findOne({ estado: { $in: ['solicitada', 'grabando'] } }).lean<GrabacionDoc>();
  if (pendiente && grabacionHuerfana(pendiente)) {
    await Grabacion.updateOne({ _id: pendiente._id }, { $set: { estado: 'terminada', detener: true, terminadaEn: new Date(), error: 'El worker dejó de responder; se cerró al iniciar otra grabación' } });
  } else if (pendiente) {
    return c.json({ error: 'GRABACION_EN_CURSO', mensaje: 'Ya hay una grabación en curso; deténgala antes de iniciar otra', id: String(pendiente._id) }, 409);
  }
  const g = await Grabacion.create({ flujoNombre: cuerpo.flujo, clienteSlug: cliente.slug, portal, urlInicio: url, parametrosPrueba: cuerpo.parametros ?? {} });
  return c.json(presentarGrabacion(g.toObject() as GrabacionDoc), 202);
});

admin.get('/api/grabaciones', async (c) => {
  const filtro: Record<string, unknown> = {};
  const flujo = c.req.query('flujo');
  if (flujo) filtro.flujoNombre = flujo;
  const lista = await Grabacion.find(filtro).sort({ createdAt: -1 }).limit(10).lean<GrabacionDoc[]>();
  return c.json({ grabaciones: lista.map((g) => ({ ...presentarGrabacion(g), pasos: (g.pasos ?? []).length })) });
});

admin.get('/api/grabaciones/:id', async (c) => {
  const id = c.req.param('id');
  if (!mongoose.isValidObjectId(id)) return c.json({ error: 'ID_INVALIDO' }, 400);
  const g = await Grabacion.findById(id).lean<GrabacionDoc>();
  if (!g) return c.json({ error: 'NO_ENCONTRADA' }, 404);
  return c.json(presentarGrabacion(g));
});

/** Una grabación "grabando" cuyo worker no da latido hace más de 45 s está huérfana (el worker se cerró). */
const grabacionHuerfana = (g: GrabacionDoc) => g.estado === 'grabando' && Date.now() - new Date(g.ultimaSenal ?? g.iniciadaEn ?? g.createdAt).getTime() > 45_000;

/** Pide al worker cerrar la grabación; si nadie la había tomado o el worker desapareció, la cierra aquí mismo. */
admin.post('/api/grabaciones/:id/detener', async (c) => {
  const id = c.req.param('id');
  if (!mongoose.isValidObjectId(id)) return c.json({ error: 'ID_INVALIDO' }, 400);
  const g = await Grabacion.findById(id).lean<GrabacionDoc>();
  if (!g) return c.json({ error: 'NO_ENCONTRADA' }, 404);
  if (g.estado === 'solicitada') {
    await Grabacion.updateOne({ _id: id }, { $set: { estado: 'cancelada', detener: true, terminadaEn: new Date() } });
    return c.json({ ok: true, estado: 'cancelada' });
  }
  if (grabacionHuerfana(g)) {
    // Se conservan los pasos grabados hasta ese momento.
    await Grabacion.updateOne({ _id: id }, { $set: { estado: 'terminada', detener: true, terminadaEn: new Date(), error: `El worker ${g.workerId ?? ''} dejó de responder; se cerró desde la consola` } });
    return c.json({ ok: true, estado: 'terminada', huerfana: true });
  }
  await Grabacion.updateOne({ _id: id }, { $set: { detener: true } });
  return c.json({ ok: true, estado: g.estado });
});

/** Habilita o deshabilita un módulo (en código o flujo) para un cliente, conservando su config. */
admin.put('/api/clientes/:slug/modulos/:modulo', async (c) => {
  const { slug, modulo } = c.req.param();
  let cuerpo: { activo?: boolean; config?: Record<string, unknown> };
  try {
    cuerpo = await c.req.json();
  } catch {
    return c.json({ error: 'JSON_INVALIDO' }, 400);
  }
  const existe = registro[modulo] || (await Flujo.exists({ nombre: modulo }));
  if (!existe) return c.json({ error: 'MODULO_INEXISTENTE' }, 404);
  const cliente = await Cliente.findOne({ slug });
  if (!cliente) return c.json({ error: 'CLIENTE_NO_ENCONTRADO' }, 404);
  const lista = cliente.get('modulos') as Array<{ nombre: string; activo: boolean; config: Record<string, unknown> }>;
  const i = lista.findIndex((m) => m.nombre === modulo);
  const activo = cuerpo.activo ?? true;
  if (i < 0) lista.push({ nombre: modulo, activo, config: cuerpo.config ?? {} });
  else {
    lista[i].activo = activo;
    if (cuerpo.config) lista[i].config = cuerpo.config;
  }
  cliente.set('modulos', lista);
  cliente.markModified('modulos');
  await cliente.save();
  return c.json({ ok: true, activo });
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
    prueba: t.prueba ?? null,
    bitacora: (t.bitacora ?? []).map((a) => ({ t: a.t, mensaje: a.mensaje })),
    // Cloudinary devuelve http(s); las locales se sirven por /admin/api/captura.
    capturas: (t.capturas ?? []).map((ruta) => (/^https?:\/\//.test(ruta) ? ruta : `/admin/api/captura?ruta=${encodeURIComponent(ruta)}`)),
  };
}
