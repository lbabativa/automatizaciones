/**
 * Lotes: muchas consultas de una automatización en una sola solicitud.
 *
 * Cada fila única se vuelve un trabajo de la cola con prioridad menor que las consultas
 * sueltas, para no hacerlas esperar. Las filas repetidas comparten trabajo y las consultadas
 * en las últimas horas reutilizan el resultado. Un lote programado deja sus trabajos en
 * estado `programado` hasta la hora (los pasa a la cola `activarProgramados`, en el worker).
 * El avance siempre se calcula desde los trabajos.
 */
import mongoose from 'mongoose';
import { huellaTrabajo } from './crypto.js';
import { Lote, type LoteDoc } from './modelos/Lote.js';
import { Trabajo, type TrabajoDoc } from './modelos/Trabajo.js';

export const MAX_ITEMS_LOTE = 1000;
/** Las consultas sueltas (prioridad 0) pasan delante de las de un lote. */
export const PRIORIDAD_LOTE = -1;
const ACTIVOS = new Set(['programado', 'pendiente', 'en_proceso']);

type Id = mongoose.Types.ObjectId | string;

export interface NuevoLote {
  clienteSlug: string;
  modulo: string;
  portal: string;
  /** Parámetros ya validados, uno por fila. */
  items: Record<string, unknown>[];
  nombre?: string;
  origen: 'api' | 'consola';
  archivo?: string;
  /** No reutilizar resultados recientes. */
  forzar?: boolean;
  /** Si es futura, los trabajos esperan en estado programado hasta esa hora. */
  programadoPara?: Date | null;
  cacheHoras: number;
}

export interface ContadoresLote {
  programado: number;
  pendiente: number;
  en_proceso: number;
  completado: number;
  fallido: number;
  desde_cache: number;
}

export interface AvanceLote {
  contadores: ContadoresLote;
  estado: string;
  /** Trabajos distintos que faltan por terminar (las filas repetidas cuentan una vez). */
  pendientesUnicos: number;
}

export async function crearLote(d: NuevoLote): Promise<LoteDoc> {
  if (!d.items.length) throw new Error('El lote no tiene filas');
  if (d.items.length > MAX_ITEMS_LOTE) throw new Error(`Máximo ${MAX_ITEMS_LOTE} filas por lote`);
  const huellas = d.items.map((p) => huellaTrabajo(d.clienteSlug, d.modulo, p));

  const cache = new Map<string, mongoose.Types.ObjectId>();
  if (!d.forzar && d.cacheHoras > 0) {
    const desde = new Date(Date.now() - d.cacheHoras * 3_600_000);
    const hechos = await Trabajo.find({ huella: { $in: [...new Set(huellas)] }, estado: 'completado', terminadoEn: { $gte: desde } })
      .sort({ terminadoEn: -1 })
      .select('_id huella')
      .lean<Array<Pick<TrabajoDoc, '_id' | 'huella'>>>();
    for (const t of hechos) if (!cache.has(t.huella)) cache.set(t.huella, t._id);
  }

  const loteId = new mongoose.Types.ObjectId();
  const programado = d.programadoPara && d.programadoPara.getTime() > Date.now() + 60_000 ? d.programadoPara : null;
  const propios = new Map<string, mongoose.Types.ObjectId>();
  const nuevos: Record<string, unknown>[] = [];
  const items = d.items.map((parametros, i) => {
    const huella = huellas[i];
    const cacheado = cache.get(huella);
    if (cacheado) return { parametros, huella, trabajoId: cacheado, desdeCache: true };
    let trabajoId = propios.get(huella);
    if (!trabajoId) {
      trabajoId = new mongoose.Types.ObjectId();
      propios.set(huella, trabajoId);
      nuevos.push({
        _id: trabajoId,
        clienteSlug: d.clienteSlug,
        modulo: d.modulo,
        portal: d.portal,
        parametros,
        huella,
        estado: programado ? 'programado' : 'pendiente',
        ...(programado ? { disponibleDesde: programado } : {}),
        prioridad: PRIORIDAD_LOTE,
        modo: 'async',
        loteId,
      });
    }
    return { parametros, huella, trabajoId, desdeCache: false };
  });

  await Lote.create({
    _id: loteId,
    clienteSlug: d.clienteSlug,
    modulo: d.modulo,
    portal: d.portal,
    nombre: d.nombre,
    origen: d.origen,
    archivo: d.archivo,
    estado: programado ? 'programado' : 'en_cola',
    programadoPara: programado ?? undefined,
    total: items.length,
    items,
  });
  try {
    if (nuevos.length) await Trabajo.insertMany(nuevos);
  } catch (e) {
    await Promise.all([Lote.deleteOne({ _id: loteId }), Trabajo.deleteMany({ loteId })]);
    throw e;
  }
  return (await actualizarLote(loteId)) as LoteDoc;
}

async function estadosDeTrabajos(items: LoteDoc['items']): Promise<Map<string, string>> {
  const ids = [...new Set(items.map((i) => String(i.trabajoId)))];
  const trabajos = await Trabajo.find({ _id: { $in: ids } }).select('estado').lean<Array<Pick<TrabajoDoc, '_id' | 'estado'>>>();
  return new Map(trabajos.map((t) => [String(t._id), t.estado]));
}

export async function calcularAvance(lote: Pick<LoteDoc, 'items' | 'estado'>, estados?: Map<string, string>): Promise<AvanceLote> {
  const porId = estados ?? (await estadosDeTrabajos(lote.items));
  const contadores: ContadoresLote = { programado: 0, pendiente: 0, en_proceso: 0, completado: 0, fallido: 0, desde_cache: 0 };
  let propiosTerminados = 0;
  const activos = new Set<string>();
  for (const it of lote.items) {
    const id = String(it.trabajoId);
    // Un trabajo borrado cuenta como fallido para que el lote no quede abierto para siempre.
    const e = porId.get(id) ?? 'fallido';
    if (e in contadores) contadores[e as keyof ContadoresLote]++;
    if (it.desdeCache) contadores.desde_cache++;
    else if (e === 'completado' || e === 'fallido') propiosTerminados++;
    if (ACTIVOS.has(e)) activos.add(id);
  }
  let estado: string;
  if (lote.estado === 'cancelado') estado = 'cancelado';
  else if (!activos.size) estado = 'terminado';
  else if (contadores.en_proceso > 0 || propiosTerminados > 0) estado = 'procesando';
  else if (contadores.programado > 0 && contadores.pendiente === 0) estado = 'programado';
  else estado = 'en_cola';
  return { contadores, estado, pendientesUnicos: activos.size };
}

/** Recalcula contadores y estado del lote desde sus trabajos y los guarda. */
export async function actualizarLote(loteId: Id): Promise<LoteDoc | null> {
  const lote = await Lote.findById(loteId).select('items.trabajoId items.desdeCache estado terminadoEn').lean<LoteDoc>();
  if (!lote) return null;
  const { contadores, estado } = await calcularAvance(lote);
  const cambios: Record<string, unknown> = { contadores, estado };
  if (estado === 'terminado' && !lote.terminadoEn) cambios.terminadoEn = new Date();
  return Lote.findByIdAndUpdate(loteId, { $set: cambios }, { returnDocument: 'after' }).lean<LoteDoc>();
}

export interface ItemDeLote {
  indice: number;
  parametros: Record<string, unknown>;
  estado: string;
  desde_cache: boolean;
  resultado: unknown;
  error: { codigo: string; mensaje: string } | null;
  terminado_en: Date | null;
  duracion_ms: number | null;
  trabajo_id: string;
}

/** Filas del lote con el resultado de su trabajo, paginadas y opcionalmente filtradas por estado ("activos" = sin terminar). */
export async function itemsDeLote(
  lote: LoteDoc,
  opciones: { desde?: number; limite?: number; estado?: string } = {},
): Promise<{ total: number; desde: number; limite: number; items: ItemDeLote[]; avance: AvanceLote }> {
  const porId = await estadosDeTrabajos(lote.items);
  const todos = lote.items.map((it, indice) => ({ it, indice, estado: porId.get(String(it.trabajoId)) ?? 'fallido' }));
  const filtro = opciones.estado;
  const filtrados = filtro ? todos.filter((x) => (filtro === 'activos' ? ACTIVOS.has(x.estado) : x.estado === filtro)) : todos;
  const desde = Math.max(0, Number.isFinite(opciones.desde) ? Math.floor(opciones.desde as number) : 0);
  const limite = Math.min(Math.max(1, Number.isFinite(opciones.limite) ? Math.floor(opciones.limite as number) : 100), MAX_ITEMS_LOTE);
  const pagina = filtrados.slice(desde, desde + limite);
  const ids = [...new Set(pagina.map((x) => String(x.it.trabajoId)))];
  const trabajos = await Trabajo.find({ _id: { $in: ids } }).select('resultado error terminadoEn duracionMs').lean<TrabajoDoc[]>();
  const detalle = new Map(trabajos.map((t) => [String(t._id), t]));
  return {
    total: filtrados.length,
    desde,
    limite,
    avance: await calcularAvance(lote, porId),
    items: pagina.map(({ it, indice, estado }) => {
      const t = detalle.get(String(it.trabajoId));
      return {
        indice,
        parametros: (it.parametros ?? {}) as Record<string, unknown>,
        estado,
        desde_cache: Boolean(it.desdeCache),
        resultado: t?.resultado ?? null,
        error: t?.error ? { codigo: t.error.codigo, mensaje: t.error.mensaje } : null,
        terminado_en: t?.terminadoEn ?? null,
        duracion_ms: t?.duracionMs ?? null,
        trabajo_id: String(it.trabajoId),
      };
    }),
  };
}

/** Estimación con un robot: duración media de las consultas ya hechas del lote (o 60 s) más la pausa entre consultas. */
export async function tiempoRestanteMs(lote: Pick<LoteDoc, '_id'>, pendientesUnicos: number, pausaMs = 30_000): Promise<number> {
  if (!pendientesUnicos) return 0;
  const [media] = await Trabajo.aggregate<{ ms: number }>([
    { $match: { loteId: lote._id, estado: { $in: ['completado', 'fallido'] }, duracionMs: { $gt: 0 } } },
    { $group: { _id: null, ms: { $avg: '$duracionMs' } } },
  ]);
  return Math.round(pendientesUnicos * ((media?.ms ?? 60_000) + pausaMs));
}

/** Cancela lo que no ha empezado; lo que ya está en curso termina normalmente. */
export async function cancelarLote(loteId: Id): Promise<LoteDoc | null> {
  const lote = await Lote.findById(loteId).select('estado').lean<Pick<LoteDoc, '_id' | 'estado'>>();
  if (!lote) return null;
  if (lote.estado !== 'terminado' && lote.estado !== 'cancelado') {
    const ahora = new Date();
    await Trabajo.updateMany(
      { loteId: lote._id, estado: { $in: ['programado', 'pendiente'] } },
      { $set: { estado: 'fallido', error: { codigo: 'CANCELADO', mensaje: 'El lote se canceló antes de consultar esta fila' }, terminadoEn: ahora } },
    );
    await Lote.updateOne({ _id: lote._id }, { $set: { estado: 'cancelado', canceladoEn: ahora } });
  }
  return actualizarLote(lote._id);
}

/** Pasa a la cola las consultas programadas cuya hora llegó. Devuelve cuántas. */
export async function activarProgramados(): Promise<number> {
  const ahora = new Date();
  const r = await Trabajo.updateMany({ estado: 'programado', disponibleDesde: { $lte: ahora } }, { $set: { estado: 'pendiente' } });
  if (r.modifiedCount) await Lote.updateMany({ estado: 'programado', programadoPara: { $lte: ahora } }, { $set: { estado: 'en_cola' } });
  return r.modifiedCount;
}
