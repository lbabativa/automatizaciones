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
import { Cliente, encolar, env, esperarResultado, rutaProyecto, Sesion, Trabajo, verificarPassword, type ClienteDoc, type TrabajoDoc } from '@startia/core';
import { listarModulos, obtenerModulo } from '@startia/modulos';
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

// El HTML del panel es público (no expone datos); las rutas de datos exigen la clave.
// Se busca junto al código (serverless) y desde la raíz del proyecto (local).
async function leerPanel(): Promise<string | null> {
  const aquí = fileURLToPath(new URL('.', import.meta.url));
  const candidatos = [resolve(aquí, '..', 'public', 'panel.html'), resolve(aquí, 'public', 'panel.html'), rutaProyecto('api', 'public', 'panel.html')];
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
  const html = await leerPanel();
  return html ? c.html(html) : c.text('No se encontró api/public/panel.html', 500);
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
