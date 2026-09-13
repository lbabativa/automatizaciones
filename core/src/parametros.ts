import { z, type ZodType } from 'zod';
import type { ParametroDef } from './flujos/esquema.js';

/**
 * Describe los parámetros de un módulo en código (esquema zod) con la misma forma que los de
 * un flujo declarativo, para pintar formularios y asignar columnas de un Excel.
 */
export function parametrosDesdeZod(esquema: ZodType): ParametroDef[] {
  let js: { properties?: Record<string, Record<string, unknown>>; required?: string[] };
  try {
    js = z.toJSONSchema(esquema, { io: 'input', unrepresentable: 'any' }) as typeof js;
  } catch {
    return [];
  }
  const requeridos = new Set(js.required ?? []);
  return Object.entries(js.properties ?? {}).map(([nombre, p]) => {
    const patron = typeof p.pattern === 'string' ? p.pattern : undefined;
    const esFecha = p.format === 'date' || patron === '^\\d{4}-\\d{2}-\\d{2}$';
    const opciones = Array.isArray(p.enum) ? p.enum.map(String) : undefined;
    const tipo: ParametroDef['tipo'] = opciones
      ? 'opcion'
      : p.type === 'number' || p.type === 'integer'
        ? 'numero'
        : p.type === 'boolean'
          ? 'booleano'
          : esFecha
            ? 'fecha'
            : 'texto';
    const def: ParametroDef = { nombre, etiqueta: typeof p.title === 'string' ? p.title : nombre, tipo, requerido: requeridos.has(nombre) && p.default === undefined };
    if (opciones) def.opciones = opciones;
    if (p.default !== undefined) def.por_defecto = p.default;
    if (patron && tipo === 'texto') def.patron = patron;
    if (typeof p.description === 'string') def.ayuda = p.description;
    return def;
  });
}
