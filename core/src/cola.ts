import { huellaTrabajo } from './crypto.js';
import { Trabajo, type ErrorTrabajo, type TrabajoDoc } from './modelos/Trabajo.js';

export interface NuevoTrabajo {
  clienteSlug: string;
  modulo: string;
  portal: string;
  parametros: Record<string, unknown>;
  modo?: 'sync' | 'async';
  callbackUrl?: string;
  prioridad?: number;
}

export async function encolar(datos: NuevoTrabajo): Promise<TrabajoDoc> {
  const huella = huellaTrabajo(datos.clienteSlug, datos.modulo, datos.parametros);
  const doc = await Trabajo.create({ ...datos, huella, modo: datos.modo ?? 'async' });
  return doc.toObject() as TrabajoDoc;
}

/** Si ya hay un trabajo idéntico pendiente o en proceso, lo devuelve para no duplicar consultas. */
export async function buscarEnCurso(clienteSlug: string, modulo: string, parametros: Record<string, unknown>): Promise<TrabajoDoc | null> {
  const huella = huellaTrabajo(clienteSlug, modulo, parametros);
  return Trabajo.findOne({ huella, estado: { $in: ['pendiente', 'en_proceso'] } }).lean<TrabajoDoc>();
}

/** Resultado completado reciente para los mismos parámetros. */
export async function buscarEnCache(clienteSlug: string, modulo: string, parametros: Record<string, unknown>, horas: number): Promise<TrabajoDoc | null> {
  if (horas <= 0) return null;
  const huella = huellaTrabajo(clienteSlug, modulo, parametros);
  const desde = new Date(Date.now() - horas * 3_600_000);
  return Trabajo.findOne({ huella, estado: 'completado', terminadoEn: { $gte: desde } })
    .sort({ terminadoEn: -1 })
    .lean<TrabajoDoc>();
}

/** Reclama atómicamente el siguiente trabajo pendiente de los módulos que este worker soporta. */
export async function reclamar(workerId: string, modulos: string[]): Promise<TrabajoDoc | null> {
  return Trabajo.findOneAndUpdate(
    { estado: 'pendiente', modulo: { $in: modulos } },
    { $set: { estado: 'en_proceso', workerId, iniciadoEn: new Date() }, $inc: { intentos: 1 } },
    { sort: { prioridad: -1, createdAt: 1 }, new: true },
  ).lean<TrabajoDoc>();
}

export async function completar(id: TrabajoDoc['_id'], resultado: unknown, capturas: string[]): Promise<void> {
  const ahora = new Date();
  const doc = await Trabajo.findById(id).select('iniciadoEn').lean<Pick<TrabajoDoc, 'iniciadoEn'>>();
  await Trabajo.updateOne(
    { _id: id },
    {
      $set: {
        estado: 'completado',
        resultado,
        capturas,
        terminadoEn: ahora,
        duracionMs: doc?.iniciadoEn ? ahora.getTime() - doc.iniciadoEn.getTime() : undefined,
      },
      $unset: { error: '' },
    },
  );
}

/**
 * Marca el trabajo como fallido o lo devuelve a la cola si quedan intentos.
 * Devuelve true si se reencoló.
 */
export async function fallar(id: TrabajoDoc['_id'], error: ErrorTrabajo, capturas: string[], reintentar: boolean): Promise<boolean> {
  const doc = await Trabajo.findById(id).select('intentos maxIntentos iniciadoEn').lean<Pick<TrabajoDoc, 'intentos' | 'maxIntentos' | 'iniciadoEn'>>();
  const puedeReintentar = reintentar && doc !== null && doc.intentos < doc.maxIntentos;
  const ahora = new Date();
  await Trabajo.updateOne(
    { _id: id },
    {
      $set: puedeReintentar
        ? { estado: 'pendiente', error, capturas, workerId: null }
        : {
            estado: 'fallido',
            error,
            capturas,
            terminadoEn: ahora,
            duracionMs: doc?.iniciadoEn ? ahora.getTime() - doc.iniciadoEn.getTime() : undefined,
          },
    },
  );
  return puedeReintentar;
}

/** Espera a que un trabajo termine, consultando la base cada `intervaloMs`. Devuelve null si vence el tiempo. */
export async function esperarResultado(id: TrabajoDoc['_id'], timeoutMs: number, intervaloMs = 1500): Promise<TrabajoDoc | null> {
  const limite = Date.now() + timeoutMs;
  while (Date.now() < limite) {
    const doc = await Trabajo.findById(id).lean<TrabajoDoc>();
    if (doc && (doc.estado === 'completado' || doc.estado === 'fallido')) return doc;
    await new Promise((r) => setTimeout(r, intervaloMs));
  }
  return null;
}

/** Trabajos que un worker dejó en proceso hace más de `minutos` (worker caído). Se devuelven a la cola. */
export async function rescatarHuerfanos(minutos = 15): Promise<number> {
  const limite = new Date(Date.now() - minutos * 60_000);
  const r = await Trabajo.updateMany(
    { estado: 'en_proceso', iniciadoEn: { $lt: limite } },
    { $set: { estado: 'pendiente', workerId: null } },
  );
  return r.modifiedCount;
}
