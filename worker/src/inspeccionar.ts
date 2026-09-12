/**
 * Abre el portal con el perfil del cliente y, cada vez que se presiona Enter en la
 * terminal, guarda el HTML y una captura de la pantalla actual en inspeccion/<portal>/.
 * Sirve para confirmar selectores de un módulo sin instalar herramientas adicionales.
 *
 * Uso: npm run inspeccionar -- <cliente> <portal>
 *      npm run inspeccionar -- cardioib sanitas
 * Escriba "fin" y Enter para terminar.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { cerrarDb, Cliente, conectarDb, rutaProyecto } from '@startia/core';
import { registro } from '@startia/modulos';
import { cerrarTodo, obtenerContexto } from './navegador.js';

const [clienteSlug, portal] = process.argv.slice(2);
if (!clienteSlug || !portal) {
  console.error('Uso: npm run inspeccionar -- <cliente> <portal>');
  process.exit(1);
}
const modulo = Object.values(registro).find((m) => m.portal === portal);
if (!modulo) {
  console.error(`No hay módulos para el portal "${portal}"`);
  process.exit(1);
}

await conectarDb();
try {
  if (!(await Cliente.exists({ slug: clienteSlug }))) {
    console.error(`No existe el cliente "${clienteSlug}"`);
    process.exit(1);
  }
  const dir = rutaProyecto('inspeccion', portal);
  await mkdir(dir, { recursive: true });
  const ctx = await obtenerContexto(clienteSlug, portal, false);
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  await page.goto(modulo.urlInicio);

  console.log(`\nVentana abierta en ${modulo.urlInicio}`);
  console.log('Haga el flujo a mano. En cada pantalla que quiera registrar, escriba un nombre corto y presione Enter (por ejemplo: login, busqueda, contratos, ficha, autorizaciones, copago).');
  console.log('Escriba "fin" para terminar.\n');

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let n = 1;
  for (;;) {
    const nombre = (await rl.question('Nombre de la pantalla (o "fin"): ')).trim();
    if (!nombre || nombre.toLowerCase() === 'fin') break;
    const base = resolve(dir, `${String(n).padStart(2, '0')}-${nombre.replace(/[^a-z0-9-]/gi, '_')}`);
    await writeFile(`${base}.html`, await page.content(), 'utf8');
    await page.screenshot({ path: `${base}.png`, fullPage: true });
    await writeFile(`${base}.url.txt`, page.url(), 'utf8');
    console.log(`  guardado ${base}.html / .png`);
    n++;
  }
  rl.close();
  console.log(`\nListo. Archivos en ${dir}`);
} finally {
  await cerrarTodo();
  await cerrarDb();
}
