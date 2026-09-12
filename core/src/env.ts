import { config } from 'dotenv';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// Carga .env.local (prioridad) y luego .env desde la raíz del monorepo, sin importar desde qué paquete se ejecute.
const raices = [process.cwd(), resolve(process.cwd(), '..'), resolve(process.cwd(), '..', '..')];
let raizDetectada: string | null = null;
for (const archivo of ['.env.local', '.env']) {
  const ruta = raices.map((r) => resolve(r, archivo)).find((p) => existsSync(p));
  if (ruta) {
    config({ path: ruta });
    raizDetectada ??= dirname(ruta);
  }
}

/**
 * Raíz del proyecto: la carpeta donde está el .env. Las rutas relativas de la
 * configuración (perfiles, evidencias, inspección) se resuelven desde aquí y no
 * desde el cwd, que npm cambia al paquete del workspace.
 */
export const RAIZ_PROYECTO = raizDetectada ?? process.cwd();

export function rutaProyecto(...partes: string[]): string {
  return resolve(RAIZ_PROYECTO, ...partes);
}

export function env(nombre: string, porDefecto?: string): string {
  const v = process.env[nombre] ?? porDefecto;
  if (v === undefined) throw new Error(`Falta la variable de entorno ${nombre}`);
  return v;
}

export function envNum(nombre: string, porDefecto: number): number {
  const v = process.env[nombre];
  if (v === undefined || v === '') return porDefecto;
  const n = Number(v);
  if (Number.isNaN(n)) throw new Error(`La variable ${nombre} debe ser numérica`);
  return n;
}
