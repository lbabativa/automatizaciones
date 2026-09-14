/** Validación y presentación de lotes, compartidas por la API pública, la consola y la página de seguimiento. */
import {
  actualizarLote,
  calcularAvance,
  despacharAvisos,
  enmascararItem,
  itemsDeLote,
  MAX_ITEMS_LOTE,
  tiempoRestanteMs,
  urlPublica,
  type LoteDoc,
  type Modulo,
} from '@startia/core';
import { z } from 'zod';

export const EntradaLote = z.object({
  items: z
    .array(z.record(z.string(), z.unknown()))
    .min(1, 'El lote no tiene filas')
    .max(MAX_ITEMS_LOTE, `Máximo ${MAX_ITEMS_LOTE} filas por lote`),
  nombre: z.string().trim().max(120).optional(),
  forzar: z.boolean().default(false),
  /** Fecha y hora ISO 8601 con zona, por ejemplo 2026-09-14T21:00:00-05:00. */
  programar_para: z.iso.datetime({ offset: true }).optional(),
  /** URL que recibe los avisos de este lote, en vez de la configurada para el cliente. */
  callback_url: z.string().trim().max(2000).optional(),
  /** Crear o no el enlace de seguimiento, en vez de lo configurado para el cliente. */
  progreso: z.boolean().optional(),
});

/** Valida cada fila con el esquema del módulo; devuelve las válidas (con valores por defecto) y los errores por índice. */
export function validarFilas(modulo: Modulo, items: Record<string, unknown>[]) {
  const validos: Record<string, unknown>[] = [];
  const errores: Array<{ indice: number; errores: string[] }> = [];
  items.forEach((item, indice) => {
    const r = modulo.parametros.safeParse(item);
    if (r.success) validos.push(r.data as Record<string, unknown>);
    else errores.push({ indice, errores: r.error.issues.map((x) => `${x.path.join('.') || 'fila'}: ${x.message}`) });
  });
  return { validos, errores };
}

export function fechaProgramada(texto?: string): Date | null {
  if (!texto) return null;
  const d = new Date(texto);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Desde dónde se despachan los avisos cuando los envía la API. */
export const origenDespacho = () => (process.env.VERCEL ? 'nube' : 'api-local');

/**
 * Si el lote cambió de estado sin que se guardara (por ejemplo, lo procesó un robot sin actualizar),
 * lo recalcula; al cerrarse así, despacha su aviso de inmediato.
 */
export async function sincronizarLote(lote: LoteDoc): Promise<LoteDoc> {
  if (lote.estado === 'terminado' || lote.estado === 'cancelado') return lote;
  const avance = await calcularAvance(lote);
  if (avance.estado === lote.estado) return lote;
  const actualizado = (await actualizarLote(lote._id)) ?? lote;
  if (actualizado.estado === 'terminado') await despacharAvisos({ desde: origenDespacho(), limite: 5 }).catch(() => undefined);
  return actualizado;
}

/**
 * Lote para la API: estado, contadores, tiempo estimado, enlace de seguimiento y aviso; con `filas`,
 * también las filas paginadas (enmascaradas si se pide).
 */
export async function presentarLote(lote: LoteDoc, filas?: { desde?: number; limite?: number; estado?: string }, opciones: { enmascarar?: boolean } = {}) {
  const detalle = filas ? await itemsDeLote(lote, filas) : null;
  const guardados = lote.contadores as Record<string, number> | undefined;
  const cerrado = lote.estado === 'terminado' || lote.estado === 'cancelado';
  const avance = detalle
    ? detalle.avance
    : cerrado && guardados && typeof guardados.completado === 'number'
      ? { contadores: guardados, estado: lote.estado, pendientesUnicos: 0 }
      : await calcularAvance(lote);
  const restante = avance.estado === 'terminado' || avance.estado === 'cancelado' ? 0 : await tiempoRestanteMs(lote, avance.pendientesUnicos);
  const progreso = lote.progreso as { token?: string; venceEn?: Date } | undefined;
  const aviso = lote.aviso as { url?: string; eventos?: string[] } | undefined;
  return {
    id: String(lote._id),
    nombre: lote.nombre ?? null,
    cliente: lote.clienteSlug,
    modulo: lote.modulo,
    portal: lote.portal,
    origen: lote.origen,
    archivo: lote.archivo ?? null,
    estado: avance.estado,
    total: lote.total,
    contadores: avance.contadores,
    restante_ms: restante,
    programado_para: lote.programadoPara ?? null,
    creado: lote.createdAt,
    terminado_en: lote.terminadoEn ?? null,
    cancelado_en: lote.canceladoEn ?? null,
    progreso_url: progreso?.token ? `${urlPublica()}/seguimiento/${progreso.token}` : null,
    progreso_vence: progreso?.token ? (progreso.venceEn ?? null) : null,
    aviso_url: aviso?.url ?? null,
    aviso_eventos: aviso?.url ? (aviso.eventos ?? []) : [],
    ...(detalle
      ? { items: opciones.enmascarar ? detalle.items.map(enmascararItem) : detalle.items, pagina: { total: detalle.total, desde: detalle.desde, limite: detalle.limite } }
      : {}),
  };
}
