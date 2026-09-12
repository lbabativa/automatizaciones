/**
 * Ejecuta un módulo directamente, sin pasar por la cola, con el perfil y las
 * credenciales del cliente. Guarda capturas de cada paso en inspeccion/<portal>/probar-<fecha>/
 * e imprime el resultado. Sirve para desarrollar y verificar módulos.
 *
 * Uso: npm run probar -- <cliente> <modulo> '<parametros JSON>'
 *      npm run probar -- cardioib sanitas-autorizaciones '{"num_doc":"79589789","cups":"890328"}'
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { cerrarDb, Cliente, conectarDb, descifrar, env, ErrorNegocio, ErrorSesion, rutaProyecto, type ClienteDoc } from '@startia/core';
import { asegurarSesion } from './sesionHelper.js';
import { obtenerModulo } from '@startia/modulos';
import { cerrarTodo, guardarSesion, obtenerContexto } from './navegador.js';

const [clienteSlug, nombreModulo, parametrosJson = '{}'] = process.argv.slice(2);
if (!clienteSlug || !nombreModulo) {
  console.error("Uso: npm run probar -- <cliente> <modulo> '<parametros JSON>'");
  process.exit(1);
}
const modulo = obtenerModulo(nombreModulo);
if (!modulo) {
  console.error(`No existe el módulo ${nombreModulo}`);
  process.exit(1);
}
const parametros = modulo.parametros.safeParse(JSON.parse(parametrosJson));
if (!parametros.success) {
  console.error('Parámetros inválidos:', JSON.stringify(parametros.error.issues, null, 2));
  process.exit(1);
}
const HEADLESS = env('HEADLESS', 'true') !== 'false';
const sello = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const dir = rutaProyecto('inspeccion', modulo.portal, `probar-${sello}`);
await mkdir(dir, { recursive: true });
const log = (m: string) => console.log(`[${new Date().toLocaleTimeString('es-CO')}] ${m}`);

await conectarDb();
try {
  const cliente = await Cliente.findOne({ slug: clienteSlug }).lean<ClienteDoc>();
  if (!cliente) throw new Error(`No existe el cliente ${clienteSlug}`);
  const config = (cliente.modulos.find((m) => m.nombre === modulo.nombre)?.config ?? {}) as Record<string, unknown>;
  const credCifradas = ((cliente.credenciales as Record<string, Record<string, string>>)?.[modulo.portal] ?? {});
  const credenciales = Object.fromEntries(Object.entries(credCifradas).map(([k, v]) => [k, descifrar(v)]));

  const ctx = await obtenerContexto(clienteSlug, modulo.portal, HEADLESS);
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  let n = 0;
  const capturar = async (nombre: string) => {
    n++;
    const base = resolve(dir, `${String(n).padStart(2, '0')}-${nombre}`);
    await page.screenshot({ path: `${base}.png`, fullPage: true }).catch(() => undefined);
    await writeFile(`${base}.html`, await page.content().catch(() => ''), 'utf8');
    log(`captura ${nombre}`);
  };

  log(`Abriendo ${modulo.urlInicio}`);
  await page.goto(modulo.urlInicio, { waitUntil: 'networkidle' });
  await asegurarSesion(modulo, ctx, page, credenciales, { headless: HEADLESS, log, clienteSlug });
  log(`Sesión lista. URL: ${page.url()}`);
  await capturar('inicio');

  const inicio = Date.now();
  const resultado = await modulo.ejecutar({ parametros: parametros.data, credenciales, config, page, capturar, log });
  await guardarSesion(clienteSlug, modulo.portal, ctx, 'automatica');
  log(`Completado en ${((Date.now() - inicio) / 1000).toFixed(1)} s`);
  await writeFile(resolve(dir, 'resultado.json'), JSON.stringify(resultado, null, 2), 'utf8');
  console.log(JSON.stringify(resultado, null, 2));
} catch (e) {
  const err = e as Error;
  const tipo = err instanceof ErrorNegocio ? `NEGOCIO ${err.codigo}` : err instanceof ErrorSesion ? 'SESION' : err.name;
  console.error(`\nFALLO [${tipo}]: ${err.message}`);
  process.exitCode = 1;
} finally {
  console.log(`\nCapturas en ${dir}`);
  await cerrarTodo();
  await cerrarDb();
}
