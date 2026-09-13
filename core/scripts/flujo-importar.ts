/**
 * Importa un flujo declarativo desde un archivo JSON a la colección `flujos`.
 * Valida contra FlujoDefSchema y guarda como borrador; con --publicar lo deja
 * publicado (sube la versión) para que API y worker lo ejecuten.
 *
 * Uso: npm run flujo:importar -- flujos/sanitas-autorizaciones.json [--publicar]
 */
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { cerrarDb, conectarDb, Flujo, FlujoDefSchema, type FlujoDoc } from '../src/index.js';

const { values, positionals } = parseArgs({ options: { publicar: { type: 'boolean', default: false } }, allowPositionals: true });
const archivo = positionals[0];
if (!archivo) {
  console.error('Uso: npm run flujo:importar -- <archivo.json> [--publicar]');
  process.exit(1);
}

const crudo = JSON.parse(await readFile(archivo, 'utf8'));
const val = FlujoDefSchema.safeParse(crudo);
if (!val.success) {
  console.error('El flujo no es válido:');
  console.error(z.prettifyError(val.error));
  process.exit(1);
}
const def = val.data;

await conectarDb();
try {
  const actual = await Flujo.findOne({ nombre: def.nombre }).lean<FlujoDoc>();
  const version = (actual?.version ?? 0) + (values.publicar ? 1 : 0);
  await Flujo.updateOne(
    { nombre: def.nombre },
    values.publicar
      ? { $set: { estado: 'publicado', version, definicion: def, borrador: null, publicadoEn: new Date() } }
      : { $set: { borrador: def }, $setOnInsert: { estado: 'borrador', version: 0 } },
    { upsert: true },
  );
  console.log(
    values.publicar
      ? `Flujo "${def.nombre}" publicado (versión ${version}, ${def.pasos.length} pasos, portal ${def.portal}).`
      : `Flujo "${def.nombre}" guardado como borrador (${def.pasos.length} pasos). Publicar con --publicar.`,
  );
} finally {
  await cerrarDb();
}
