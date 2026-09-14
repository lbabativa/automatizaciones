/**
 * Entrega de resultados: configuración por cliente y automatización, enlaces de progreso de los
 * lotes y avisos firmados al servicio del cliente.
 *
 * Los avisos van a una bandeja de salida (colección `avisos`) y los envía `despacharAvisos`:
 * normalmente desde la nube (el worker invoca a la API en Vercel) y, si no responde, desde el PC
 * del worker. Cada aviso se reclama de forma atómica, se firma con HMAC-SHA256 y se reintenta
 * hasta 5 veces durante unos 30 minutos.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import type mongoose from 'mongoose';
import { env } from './env.js';
import { Aviso, type AvisoDoc } from './modelos/Aviso.js';
import { Cliente, type ClienteDoc } from './modelos/Cliente.js';
import { Lote, type LoteDoc } from './modelos/Lote.js';
import { Trabajo, type TrabajoDoc } from './modelos/Trabajo.js';

export const EVENTOS_AVISO = ['lote', 'consulta'] as const;
/** Minutos antes de cada reintento: el aviso se intenta a los 0, 1, 4, 12 y 27 minutos. */
const ESPERAS_MIN = [1, 3, 8, 15];

type Id = mongoose.Types.ObjectId | string;

export interface EntregaConfig {
  progreso: { activo: boolean; dias: number; enmascarar: boolean };
  aviso: { url: string | null; eventos: string[] };
}

/** Dirección pública de la API, para los enlaces que van en avisos y respuestas. */
export function urlPublica(): string {
  return env('PUBLIC_URL', 'https://startia-automatizaciones.vercel.app').replace(/\/+$/, '');
}

function ipPrivada(ip: string): boolean {
  if (ip.includes(':')) return ip === '::1' || ip === '::' || /^f[cd]/i.test(ip) || /^fe80/i.test(ip);
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

/**
 * Una URL de aviso debe ser https y no apuntar a direcciones internas. Fuera de Vercel se permite
 * http hacia este mismo equipo, para pruebas locales. Devuelve el problema, o null si sirve.
 */
export function validarUrlAviso(url: string): string | null {
  let u: URL;
  try {
    u = new URL(String(url).trim());
  } catch {
    return 'no es una URL válida';
  }
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const local = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  if (u.protocol === 'http:' && local && !process.env.VERCEL) return null;
  if (u.protocol !== 'https:') return 'debe empezar por https://';
  if (u.username || u.password) return 'no puede llevar usuario ni contraseña';
  if (local || host.endsWith('.local') || host.endsWith('.internal') || (isIP(host) && ipPrivada(host))) return 'no puede apuntar a una dirección interna';
  return null;
}

/** Completa una configuración guardada con los valores por defecto (enlace activo, 7 días, enmascarado; sin aviso). */
export function normalizarEntrega(e: unknown): EntregaConfig {
  const x = (e ?? {}) as { progreso?: Partial<EntregaConfig['progreso']>; aviso?: { url?: unknown; eventos?: unknown } };
  const dias = Number(x.progreso?.dias);
  const eventos = Array.isArray(x.aviso?.eventos) ? (x.aviso.eventos as unknown[]).map(String).filter((v) => (EVENTOS_AVISO as readonly string[]).includes(v)) : ['lote'];
  return {
    progreso: {
      activo: x.progreso?.activo !== false,
      dias: Number.isFinite(dias) && dias >= 1 ? Math.min(Math.round(dias), 90) : 7,
      enmascarar: x.progreso?.enmascarar !== false,
    },
    aviso: { url: typeof x.aviso?.url === 'string' && x.aviso.url ? x.aviso.url : null, eventos: [...new Set(eventos)] },
  };
}

/** Entrega de un cliente para una automatización: la propia de la automatización o, si no tiene, la general. */
export function entregaDe(cliente: Pick<ClienteDoc, 'entrega' | 'modulos'>, modulo: string): EntregaConfig {
  const propia = (cliente.modulos ?? []).find((m) => m.nombre === modulo)?.entrega;
  return normalizarEntrega(propia ?? cliente.entrega);
}

export function nuevoProgreso(dias: number, enmascarar: boolean) {
  return { token: randomBytes(18).toString('base64url'), venceEn: new Date(Date.now() + dias * 86_400_000), enmascarar };
}

export const generarSecretoAviso = () => `whsec_${randomBytes(24).toString('base64url')}`;

/** Firma: v1= HMAC-SHA256 en hexadecimal de `${fecha}.${cuerpo}`, con la fecha en segundos Unix. */
export function firmarAviso(secreto: string, fecha: number, cuerpo: string): string {
  return 'v1=' + createHmac('sha256', secreto).update(`${fecha}.${cuerpo}`).digest('hex');
}

/** Clave de firma del cliente; la crea si todavía no tiene. */
export async function asegurarSecreto(slug: string): Promise<string> {
  const actual = await Cliente.findOne({ slug }).select('+avisoSecreto').lean<{ avisoSecreto?: string }>();
  if (actual?.avisoSecreto) return actual.avisoSecreto;
  const nuevo = generarSecretoAviso();
  await Cliente.updateOne({ slug, $or: [{ avisoSecreto: { $exists: false } }, { avisoSecreto: null }] }, { $set: { avisoSecreto: nuevo } });
  const guardado = await Cliente.findOne({ slug }).select('+avisoSecreto').lean<{ avisoSecreto?: string }>();
  return guardado?.avisoSecreto ?? nuevo;
}

export interface NuevoAviso {
  clienteSlug: string;
  evento: string;
  url: string;
  cuerpo: Record<string, unknown>;
  loteId?: Id | null;
  trabajoId?: Id | null;
  maxIntentos?: number;
}

export async function crearAviso(d: NuevoAviso): Promise<AvisoDoc> {
  const doc = await Aviso.create({
    clienteSlug: d.clienteSlug,
    evento: d.evento,
    url: d.url,
    cuerpo: d.cuerpo,
    ...(d.loteId ? { loteId: d.loteId } : {}),
    ...(d.trabajoId ? { trabajoId: d.trabajoId } : {}),
    maxIntentos: d.maxIntentos ?? 5,
    proximoIntento: new Date(),
  });
  return doc.toObject() as AvisoDoc;
}

/** Aviso de cierre o cancelación de un lote, si el lote tiene aviso de lote configurado. */
export async function avisarLote(lote: LoteDoc, evento: 'lote.terminado' | 'lote.cancelado'): Promise<AvisoDoc | null> {
  const aviso = lote.aviso as { url?: string; eventos?: string[] } | undefined;
  if (!aviso?.url || !(aviso.eventos ?? []).includes('lote')) return null;
  const base = urlPublica();
  const id = String(lote._id);
  const progreso = lote.progreso as { token?: string } | undefined;
  return crearAviso({
    clienteSlug: lote.clienteSlug,
    evento,
    url: aviso.url,
    loteId: lote._id,
    cuerpo: {
      evento,
      cliente: lote.clienteSlug,
      lote: {
        id,
        nombre: lote.nombre ?? null,
        modulo: lote.modulo,
        estado: lote.estado,
        total: lote.total,
        contadores: lote.contadores ?? {},
        creado: lote.createdAt,
        terminado_en: lote.terminadoEn ?? null,
        cancelado_en: lote.canceladoEn ?? null,
        estado_url: `${base}/v1/lotes/${id}`,
        resultado_url: `${base}/v1/lotes/${id}/resultado?formato=xlsx`,
        progreso_url: progreso?.token ? `${base}/seguimiento/${progreso.token}` : null,
      },
    },
  });
}

/**
 * Aviso de una consulta terminada. Destino: el aviso del lote si la consulta es de un lote y avisa
 * consultas; si no, el `callback_url` de la llamada; si no, la entrega configurada del cliente.
 */
export async function avisarConsulta(trabajoId: Id): Promise<AvisoDoc | null> {
  const t = await Trabajo.findById(trabajoId).lean<TrabajoDoc>();
  if (!t || t.prueba || (t.estado !== 'completado' && t.estado !== 'fallido')) return null;
  let url: string | null = null;
  if (t.loteId) {
    const lote = await Lote.findById(t.loteId).select('aviso').lean<{ aviso?: { url?: string; eventos?: string[] } }>();
    if (lote?.aviso?.url && (lote.aviso.eventos ?? []).includes('consulta')) url = lote.aviso.url;
  } else if (t.callbackUrl) {
    url = t.callbackUrl;
  } else {
    const cliente = await Cliente.findOne({ slug: t.clienteSlug }).select('entrega modulos').lean<ClienteDoc>();
    const entrega = cliente ? entregaDe(cliente, t.modulo) : null;
    if (entrega?.aviso.url && entrega.aviso.eventos.includes('consulta')) url = entrega.aviso.url;
  }
  if (!url) return null;
  const evento = t.estado === 'completado' ? 'consulta.completada' : 'consulta.fallida';
  const id = String(t._id);
  return crearAviso({
    clienteSlug: t.clienteSlug,
    evento,
    url,
    trabajoId: t._id,
    loteId: t.loteId ?? null,
    cuerpo: {
      evento,
      cliente: t.clienteSlug,
      consulta: {
        id,
        modulo: t.modulo,
        estado: t.estado,
        parametros: t.parametros,
        resultado: t.resultado ?? null,
        error: t.error ? { codigo: t.error.codigo, mensaje: t.error.mensaje } : null,
        capturas: t.capturas ?? [],
        lote_id: t.loteId ? String(t.loteId) : null,
        terminado_en: t.terminadoEn ?? null,
        duracion_ms: t.duracionMs ?? null,
        estado_url: `${urlPublica()}/v1/trabajos/${id}`,
      },
    },
  });
}

export async function hayAvisosPendientes(): Promise<boolean> {
  return Boolean(await Aviso.exists({ estado: 'pendiente', proximoIntento: { $lte: new Date() } }));
}

/** Envía los avisos que tocan. `desde` queda en el historial; `ids` limita el envío a esos avisos. */
export async function despacharAvisos(opciones: { desde: string; limite?: number; ids?: Id[] }): Promise<{ enviados: number; fallidos: number }> {
  const limite = opciones.limite ?? 25;
  const secretos = new Map<string, string>();
  let enviados = 0;
  let fallidos = 0;
  for (let i = 0; i < limite; i++) {
    const ahora = new Date();
    const filtro: Record<string, unknown> = { $or: [{ estado: 'pendiente', proximoIntento: { $lte: ahora } }, { estado: 'enviando', bloqueadoHasta: { $lt: ahora } }] };
    if (opciones.ids) filtro._id = { $in: opciones.ids };
    const a = await Aviso.findOneAndUpdate(filtro, { $set: { estado: 'enviando', bloqueadoHasta: new Date(ahora.getTime() + 60_000) }, $inc: { intentos: 1 } }, { sort: { proximoIntento: 1 }, returnDocument: 'after' }).lean<AvisoDoc>();
    if (!a) break;

    let codigo: number | undefined;
    let error: string | undefined = validarUrlAviso(a.url) ?? undefined;
    if (error) error = `URL no permitida: ${error}`;
    else {
      let secreto = secretos.get(a.clienteSlug);
      if (!secreto) {
        secreto = await asegurarSecreto(a.clienteSlug);
        secretos.set(a.clienteSlug, secreto);
      }
      const fecha = Math.floor(Date.now() / 1000);
      const cuerpo = JSON.stringify({ id: String(a._id), fecha: new Date(fecha * 1000).toISOString(), ...(a.cuerpo as Record<string, unknown>) });
      try {
        const r = await fetch(a.url, {
          method: 'POST',
          redirect: 'manual',
          signal: AbortSignal.timeout(10_000),
          headers: {
            'content-type': 'application/json',
            'user-agent': 'StartIA-Avisos/1',
            'x-startia-evento': a.evento,
            'x-startia-id': String(a._id),
            'x-startia-fecha': String(fecha),
            'x-startia-firma': firmarAviso(secreto, fecha, cuerpo),
          },
          body: cuerpo,
        });
        codigo = r.status;
        await r.body?.cancel().catch(() => undefined);
        if (r.status < 200 || r.status >= 300) error = `respondió ${r.status}`;
      } catch (e) {
        error = (e as Error).name === 'TimeoutError' ? 'no respondió en 10 segundos' : (e as Error).message;
      }
    }

    const intento = { fecha: new Date(), codigo, error, desde: opciones.desde };
    if (!error) {
      await Aviso.updateOne({ _id: a._id }, { $set: { estado: 'entregado', entregadoEn: new Date(), ultimoCodigo: codigo }, $unset: { ultimoError: '', bloqueadoHasta: '' }, $push: { historial: { $each: [intento], $slice: -10 } } });
      enviados++;
    } else {
      const agotado = a.intentos >= a.maxIntentos || error.startsWith('URL no permitida');
      await Aviso.updateOne(
        { _id: a._id },
        {
          $set: { estado: agotado ? 'fallido' : 'pendiente', ultimoError: error, proximoIntento: new Date(Date.now() + (ESPERAS_MIN[a.intentos - 1] ?? 15) * 60_000), ...(codigo ? { ultimoCodigo: codigo } : {}) },
          $unset: { bloqueadoHasta: '', ...(codigo ? {} : { ultimoCodigo: '' }) },
          $push: { historial: { $each: [intento], $slice: -10 } },
        },
      );
      fallidos++;
    }
  }
  return { enviados, fallidos };
}

/** Vuelve a poner un aviso en cola ya mismo, con al menos un intento más. */
export async function reintentarAviso(id: Id): Promise<AvisoDoc | null> {
  const a = await Aviso.findById(id).lean<AvisoDoc>();
  if (!a || a.estado === 'entregado' || a.estado === 'enviando') return a;
  await Aviso.updateOne({ _id: a._id }, { $set: { estado: 'pendiente', proximoIntento: new Date(), maxIntentos: Math.max(a.maxIntentos, a.intentos + 1) } });
  return Aviso.findById(id).lean<AvisoDoc>();
}

export function presentarAviso(a: AvisoDoc) {
  return {
    id: String(a._id),
    evento: a.evento,
    url: a.url,
    estado: a.estado,
    intentos: a.intentos,
    max_intentos: a.maxIntentos,
    ultimo_codigo: a.ultimoCodigo ?? null,
    ultimo_error: a.ultimoError ?? null,
    proximo_intento: a.estado === 'pendiente' ? a.proximoIntento : null,
    entregado_en: a.entregadoEn ?? null,
    creado: a.createdAt,
    lote_id: a.loteId ? String(a.loteId) : null,
    consulta_id: a.trabajoId ? String(a.trabajoId) : null,
    historial: (a.historial ?? []).map((h) => ({ fecha: h.fecha, codigo: h.codigo ?? null, error: h.error ?? null, desde: h.desde ?? null })),
  };
}
