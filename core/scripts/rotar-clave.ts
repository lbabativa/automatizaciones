/** Genera una clave de API nueva para un cliente e invalida la anterior. Uso: npm run cliente:rotar-clave -- --slug cardioib */
import { parseArgs } from 'node:util';
import { Cliente, cerrarDb, conectarDb, generarApiKey, hashApiKey } from '../src/index.js';

const { values } = parseArgs({ options: { slug: { type: 'string' } } });
if (!values.slug) {
  console.error('Falta --slug');
  process.exit(1);
}

await conectarDb();
try {
  const slug = values.slug.toLowerCase();
  const { apiKey, prefijo } = generarApiKey(slug);
  const r = await Cliente.updateOne({ slug }, { $set: { apiKeyHash: hashApiKey(apiKey), apiKeyPrefijo: prefijo } });
  if (r.matchedCount === 0) {
    console.error(`No existe el cliente "${slug}"`);
    process.exit(1);
  }
  console.log(`\nClave nueva para ${slug} (la anterior ya no sirve):\n\n  ${apiKey}\n`);
} finally {
  await cerrarDb();
}
