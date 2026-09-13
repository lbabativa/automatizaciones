import { Flujo, moduloDesdeFlujo, type FlujoDef, type FlujoDoc, type Modulo, type ParametroDef } from '@startia/core';
import sanitasAutorizaciones from '@startia/modulo-sanitas-autorizaciones';

/**
 * Catálogo de módulos de la plataforma, de cualquier sector y para cualquier cliente.
 *
 * Hay dos clases de módulos:
 * - En código: paquetes en modulos/<sector>/<nombre>, listados aquí.
 * - Declarativos: flujos guardados en la colección `flujos` (estado publicado),
 *   que el intérprete del núcleo convierte en Modulo. Se resuelven por nombre
 *   con `resolverModulo`, que consulta primero la lista en código.
 */
const lista: Modulo[] = [
  // salud
  sanitasAutorizaciones as unknown as Modulo,
  // banca, seguros, gobierno... se agregan aquí
];

export const registro: Record<string, Modulo> = Object.fromEntries(lista.map((m) => [m.nombre, m]));

/** Solo módulos en código (síncrono). Para incluir flujos declarativos usar resolverModulo. */
export function obtenerModulo(nombre: string): Modulo | undefined {
  return registro[nombre];
}

export interface ResumenModulo {
  nombre: string;
  sector: string;
  portal: string;
  version: string;
  descripcion: string;
  /** Solo en flujos declarativos: definición de los campos de entrada, para pintar el formulario. */
  parametros?: ParametroDef[];
  origen: 'codigo' | 'flujo';
}

function resumir(m: Modulo, origen: ResumenModulo['origen'], parametros?: ParametroDef[]): ResumenModulo {
  return { nombre: m.nombre, sector: m.sector, portal: m.portal, version: m.version, descripcion: m.descripcion, parametros, origen };
}

export function listarModulos(): ResumenModulo[] {
  return lista.map((m) => resumir(m, 'codigo'));
}

export interface OpcionesResolver {
  /** Usar la definición en borrador (pruebas desde el editor) en vez de la publicada. */
  borrador?: boolean;
  /** Captura después de cada paso visual. */
  capturarCadaPaso?: boolean;
}

/** Módulo en código o flujo declarativo con ese nombre (publicado, o su borrador si se pide). */
export async function resolverModulo(nombre: string, opciones: OpcionesResolver = {}): Promise<Modulo | undefined> {
  const enCodigo = registro[nombre];
  if (enCodigo) return enCodigo;
  const doc = await Flujo.findOne({ nombre }).lean<FlujoDoc>();
  if (!doc) return undefined;
  const def = (opciones.borrador ? (doc.borrador ?? doc.definicion) : doc.estado === 'publicado' ? doc.definicion : null) as FlujoDef | null;
  if (!def) return undefined;
  return moduloDesdeFlujo(def, doc.version, { capturarCadaPaso: opciones.capturarCadaPaso });
}

/** Catálogo completo: módulos en código más flujos publicados. */
export async function listarModulosDisponibles(): Promise<ResumenModulo[]> {
  const flujos = await Flujo.find({ estado: 'publicado' }).lean<FlujoDoc[]>();
  const declarativos = flujos
    .filter((f) => f.definicion && !registro[f.nombre])
    .map((f) => {
      const def = f.definicion as FlujoDef;
      return resumir(moduloDesdeFlujo(def, f.version), 'flujo', def.parametros);
    });
  return [...listarModulos(), ...declarativos];
}

/** Nombres que un worker puede ejecutar: los de código más todos los flujos (los borradores solo llegan como pruebas). */
export async function nombresModulosSoportados(): Promise<string[]> {
  const flujos = await Flujo.find({}).select('nombre').lean<Array<{ nombre: string }>>();
  return [...new Set([...Object.keys(registro), ...flujos.map((f) => f.nombre)])];
}
