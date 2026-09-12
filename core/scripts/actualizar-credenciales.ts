/**
 * Actualiza las credenciales de portal de un cliente existente, leyéndolas de
 * variables CRED_<PORTAL>_<CAMPO> (por ejemplo en .env.local). Solo toca los
 * portales presentes en las variables; los demás se conservan.
 *
 * Uso: npm run cliente:credenciales -- --slug cardioib
 */
import { parseArgs } from 'node:util';
import { Cliente, cerrarDb, cifrar, conectarDb, Sesion } from '../src/index.js';

const { values } = parseArgs({ options: { slug: { type: 'string' } } });
if (!values.slug) {
  console.error('Falta --slug');
  process.exit(1);
}
const slug = values.slug.toLowerCase();

const nuevas: Record<string, Record<string, string>> = {};
for (const [k, v] of Object.entries(process.env)) {
  const m = /^CRED_([A-Z0-9]+)_([A-Z0-9_]+)$/.exec(k);
  if (!m || !v) continue;
  const portal = m[1].toLowerCase().replace(/_/g, '-');
  (nuevas[portal] ??= {})[m[2].toLowerCase()] = cifrar(v);
}
if (Object.keys(nuevas).length === 0) {
  console.error('No hay variables CRED_<PORTAL>_<CAMPO> definidas');
  process.exit(1);
}

await conectarDb();
try {
  const cliente = await Cliente.findOne({ slug });
  if (!cliente) {
    console.error(`No existe el cliente "${slug}"`);
    process.exit(1);
  }
  const actuales = (cliente.get('credenciales') as Record<string, Record<string, string>>) ?? {};
  cliente.set('credenciales', { ...actuales, ...nuevas });
  cliente.markModified('credenciales');
  await cliente.save();
  // La sesión guardada pudo abrirse con las credenciales viejas: se invalida para forzar un login nuevo.
  await Sesion.updateMany({ clienteSlug: slug, portal: { $in: Object.keys(nuevas) } }, { $set: { valida: false } });
  for (const [portal, campos] of Object.entries(nuevas)) {
    console.log(`Credenciales de ${portal} actualizadas para ${slug}: ${Object.keys(campos).join(', ')}`);
  }
} finally {
  await cerrarDb();
}
