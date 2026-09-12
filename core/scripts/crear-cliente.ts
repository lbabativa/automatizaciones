/**
 * Registra un cliente en la plataforma y le entrega su clave de API.
 *
 * Uso:
 *   CRED_SANITAS_USUARIO=... CRED_SANITAS_PASSWORD=... \
 *   npm run cliente:crear -- --slug cardioib --nombre "CARDIOIB SAS" --nit 900000000 \
 *     --modulo sanitas-autorizaciones --config sanitas-autorizaciones.prestadorCodigo=176805
 *
 * Las credenciales se leen SOLO de variables de entorno con el patrón CRED_<PORTAL>_<CAMPO>
 * (nunca por argumentos, para que no queden en el historial de la terminal) y se guardan cifradas.
 */
import { parseArgs } from 'node:util';
import { Cliente, cerrarDb, cifrar, conectarDb, generarApiKey, hashApiKey } from '../src/index.js';

const { values } = parseArgs({
  options: {
    slug: { type: 'string' },
    nombre: { type: 'string' },
    nit: { type: 'string' },
    modulo: { type: 'string', multiple: true, default: [] },
    config: { type: 'string', multiple: true, default: [] },
    'limite-por-minuto': { type: 'string', default: '30' },
  },
});

if (!values.slug || !values.nombre) {
  console.error('Faltan --slug y --nombre');
  process.exit(1);
}

const slug = values.slug.toLowerCase();

// --config <modulo>.<clave>=<valor>
const configPorModulo: Record<string, Record<string, string>> = {};
for (const par of values.config ?? []) {
  const m = /^([a-z0-9-]+)\.([A-Za-z0-9_]+)=(.*)$/.exec(par);
  if (!m) {
    console.error(`--config inválido: ${par}. Formato: modulo.clave=valor`);
    process.exit(1);
  }
  (configPorModulo[m[1]] ??= {})[m[2]] = m[3];
}

// CRED_<PORTAL>_<CAMPO>=valor  →  credenciales[portal][campo] = cifrado(valor)
const credenciales: Record<string, Record<string, string>> = {};
for (const [k, v] of Object.entries(process.env)) {
  const m = /^CRED_([A-Z0-9]+)_([A-Z0-9_]+)$/.exec(k);
  if (!m || !v) continue;
  const portal = m[1].toLowerCase().replace(/_/g, '-');
  const campo = m[2].toLowerCase();
  (credenciales[portal] ??= {})[campo] = cifrar(v);
}

await conectarDb();
try {
  if (await Cliente.exists({ slug })) {
    console.error(`Ya existe un cliente con slug "${slug}". Usa cliente:rotar-clave para una clave nueva.`);
    process.exit(1);
  }
  const { apiKey, prefijo } = generarApiKey(slug);
  await Cliente.create({
    slug,
    nombre: values.nombre,
    nit: values.nit,
    apiKeyHash: hashApiKey(apiKey),
    apiKeyPrefijo: prefijo,
    limitePorMinuto: Number(values['limite-por-minuto']),
    modulos: (values.modulo ?? []).map((nombre) => ({ nombre, activo: true, config: configPorModulo[nombre] ?? {} })),
    credenciales,
  });

  console.log(`\nCliente "${values.nombre}" (${slug}) creado.`);
  console.log(`Módulos: ${(values.modulo ?? []).join(', ') || 'ninguno'}`);
  console.log(`Portales con credenciales: ${Object.keys(credenciales).join(', ') || 'ninguno'}`);
  console.log('\nClave de API (se muestra UNA sola vez, guárdala en el gestor de secretos del cliente):\n');
  console.log(`  ${apiKey}\n`);
} finally {
  await cerrarDb();
}
