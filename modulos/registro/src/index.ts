import type { Modulo } from '@startia/core';
import sanitasAutorizaciones from '@startia/modulo-sanitas-autorizaciones';

/**
 * Catálogo de módulos de la plataforma, de cualquier sector y para cualquier cliente.
 * Para agregar un módulo nuevo: crear el paquete en modulos/<sector>/<nombre>, añadirlo como
 * dependencia de este paquete e incluirlo en la lista.
 */
const lista: Modulo[] = [
  // salud
  sanitasAutorizaciones as unknown as Modulo,
  // banca, seguros, gobierno... se agregan aquí
];

export const registro: Record<string, Modulo> = Object.fromEntries(lista.map((m) => [m.nombre, m]));

export function obtenerModulo(nombre: string): Modulo | undefined {
  return registro[nombre];
}

export function listarModulos(): Array<Pick<Modulo, 'nombre' | 'sector' | 'portal' | 'version' | 'descripcion'>> {
  return lista.map(({ nombre, sector, portal, version, descripcion }) => ({ nombre, sector, portal, version, descripcion }));
}
